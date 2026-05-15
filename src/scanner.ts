import { formatBytes, formatDurationMs, formatGwei, formatKGas } from "./format";
import { inspectBlockFromRpc } from "./blockInspector";
import { computeBlockMetrics } from "./metrics";
import type { BlockMetrics, RpcBlock, RpcReceipt } from "./types";
import type { EthereumRpcClient, RpcStats } from "./rpc";
import type { ScannerConfig } from "./config";
import type { BlockProgressUpdate, ScannerStorage } from "./storage";

const BACKFILL_SLICE_MS = 20_000;

export interface ScannerRuntime {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultRuntime: ScannerRuntime = {
  now: () => performance.now(),
  sleep,
};

export async function runScanner(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime = defaultRuntime,
): Promise<void> {
  if (config.toBlock !== undefined) {
    await runBoundedForwardScanner(config, rpc, storage, runtime);
    return;
  }

  await runNearHeadBackfillScanner(config, rpc, storage, runtime);
}

async function runBoundedForwardScanner(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime,
): Promise<void> {
  if (config.fromBlock === undefined) {
    throw new Error("--from-block is required when --to-block is set");
  }

  const lastSuccessfulBlock = await storage.getLastSuccessfulBlock();
  let nextBlock = lastSuccessfulBlock === undefined ? config.fromBlock : lastSuccessfulBlock + 1n;

  console.log(`Starting scanner at block ${nextBlock.toString()}`);
  if (lastSuccessfulBlock !== undefined) {
    console.log(`Resumed from last successful block ${lastSuccessfulBlock.toString()}`);
  }

  while (true) {
    let latestBlock: bigint;
    try {
      latestBlock = await rpc.getLatestBlockNumber();
    } catch (error) {
      console.error(`Failed to read latest block; retrying after ${config.retryMs}ms`, error);
      await runtime.sleep(config.retryMs);
      continue;
    }

    const safeHead =
      latestBlock > config.confirmationDepth ? latestBlock - config.confirmationDepth : 0n;
    const upperBound = config.toBlock !== undefined && config.toBlock < safeHead ? config.toBlock : safeHead;

    if (nextBlock > upperBound) {
      if (config.toBlock !== undefined && nextBlock > config.toBlock) {
        console.log(`Finished scanning through block ${config.toBlock.toString()}`);
        return;
      }

      await runtime.sleep(config.pollMs);
      continue;
    }

    try {
      await scanOneBlock(nextBlock, rpc, storage, config.txReceiptConcurrency);
      nextBlock += 1n;
    } catch (error) {
      console.error(
        `Failed to scan block ${nextBlock.toString()}; retrying after ${config.retryMs}ms`,
        error,
      );
      await runtime.sleep(config.retryMs);
    }
  }
}

async function runNearHeadBackfillScanner(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime,
): Promise<void> {
  console.log(
    `Starting near-head scanner with oldest backfill block ${config.oldestBackfillBlock.toString()}`,
  );

  while (true) {
    const backfillSafeHead = await readSafeHeadWithRetry(config, rpc, runtime);
    const lowestBackfilledBlock = await backfillDownForSlice(
      backfillSafeHead,
      config,
      rpc,
      storage,
      runtime,
    );

    const catchUpSafeHead = await readSafeHeadWithRetry(config, rpc, runtime);
    const scannedForward = await scanForwardToSafeHead(
      catchUpSafeHead,
      lowestBackfilledBlock ?? catchUpSafeHead,
      config,
      rpc,
      storage,
      runtime,
    );

    if (!scannedForward) {
      await runtime.sleep(config.pollMs);
    }
  }
}

async function readSafeHeadWithRetry(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  runtime: ScannerRuntime,
): Promise<bigint> {
  while (true) {
    try {
      const latestBlock = await rpc.getLatestBlockNumber();
      return computeSafeHead(latestBlock, config.confirmationDepth);
    } catch (error) {
      console.error(`Failed to read latest block; retrying after ${config.retryMs}ms`, error);
      await runtime.sleep(config.retryMs);
    }
  }
}

export async function backfillDownForSlice(
  safeHead: bigint,
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime = defaultRuntime,
): Promise<bigint | undefined> {
  let nextBackfillBlock = await storage.getBackfillNextBlock();
  if (nextBackfillBlock === undefined || nextBackfillBlock > safeHead) {
    nextBackfillBlock = safeHead;
  }

  const deadlineMs = runtime.now() + BACKFILL_SLICE_MS;
  let lowestBackfilledBlock: bigint | undefined;

  while (nextBackfillBlock >= config.oldestBackfillBlock && runtime.now() < deadlineMs) {
    const blockToScan = nextBackfillBlock;
    await scanBlockWithRetry(
      blockToScan,
      rpc,
      storage,
      config,
      runtime,
      { kind: "backfillNextBlock", nextBlock: blockToScan - 1n },
      "backfill",
    );

    lowestBackfilledBlock = blockToScan;
    nextBackfillBlock -= 1n;
  }

  return lowestBackfilledBlock;
}

export async function scanForwardToSafeHead(
  safeHead: bigint,
  initialLowerBound: bigint,
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime = defaultRuntime,
): Promise<boolean> {
  const lastSuccessfulBlock = await storage.getLastSuccessfulBlock();
  let nextBlock = lastSuccessfulBlock === undefined ? initialLowerBound : lastSuccessfulBlock + 1n;
  let scanned = false;

  while (nextBlock <= safeHead) {
    await scanBlockWithRetry(
      nextBlock,
      rpc,
      storage,
      config,
      runtime,
      { kind: "lastSuccessfulBlock" },
      "forward",
    );

    scanned = true;
    nextBlock += 1n;
  }

  return scanned;
}

async function scanBlockWithRetry(
  blockNumber: bigint,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  config: ScannerConfig,
  runtime: ScannerRuntime,
  progressUpdate: BlockProgressUpdate,
  direction: "backfill" | "forward",
): Promise<void> {
  while (true) {
    try {
      await scanOneBlock(blockNumber, rpc, storage, config.txReceiptConcurrency, progressUpdate);
      return;
    } catch (error) {
      console.error(
        `Failed to ${direction} scan block ${blockNumber.toString()}; retrying after ${config.retryMs}ms`,
        error,
      );
      await runtime.sleep(config.retryMs);
    }
  }
}

export async function scanOneBlock(
  blockNumber: bigint,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  txReceiptConcurrency: number,
  progressUpdate: BlockProgressUpdate = { kind: "lastSuccessfulBlock" },
): Promise<void> {
  const startedAt = performance.now();
  const rpcStatsBefore = rpc.getStatsSnapshot();
  const block = await rpc.getBlockWithTransactions(blockNumber);
  const receipts = await getTransactionReceipts(block, rpc, txReceiptConcurrency);

  const metrics = computeBlockMetrics(block, receipts);
  const inspected = inspectBlockFromRpc(block, receipts);
  await storage.saveBlockMetrics(metrics, progressUpdate, inspected.transactions);
  const elapsedMs = performance.now() - startedAt;
  const rpcStats = rpc.getStatsSince(rpcStatsBefore);
  console.log(formatBlockSummary(metrics, elapsedMs, rpcStats));
}

function computeSafeHead(latestBlock: bigint, confirmationDepth: bigint): bigint {
  return latestBlock > confirmationDepth ? latestBlock - confirmationDepth : 0n;
}

async function getTransactionReceipts(
  block: RpcBlock,
  rpc: EthereumRpcClient,
  txReceiptConcurrency: number,
): Promise<RpcReceipt[]> {
  if (txReceiptConcurrency < 1) {
    throw new Error("Transaction receipt concurrency must be greater than zero");
  }

  const receipts: RpcReceipt[] = [];
  for (const transaction of block.transactions) {
    receipts.push(await rpc.getTransactionReceipt(transaction.hash));
  }
  return receipts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBlockSummary(metrics: BlockMetrics, elapsedMs: number, rpcStats: RpcStats): string {
  const totalRpcBytes = rpcStats.requestBytes + rpcStats.responseBytes;

  return [
    `Block ${metrics.blockNumber.toString()} scanned and stored`,
    `  Date: ${metrics.blockDate}`,
    `  Duration: ${formatDurationMs(elapsedMs)}`,
    `  Transactions: ${metrics.transactionCount.toString()}`,
    `  Gas used: ${formatKGas(metrics.totalGasUsed)} / ${formatKGas(metrics.maxGasInBlock)}`,
    `  Base fee: ${formatGwei(metrics.baseBlockFeeWei)}`,
    `  Avg fee price: ${formatGwei(metrics.averageFeePriceWei)}`,
    `  Avg priority fee: ${formatGwei(metrics.averagePriorityFeeWei)}`,
    `  Gas-weighted avg priority fee: ${formatGwei(metrics.averagePriorityFeeWeightedWei)}`,
    `  Avg transaction gas: ${metrics.averageTransactionGasUsed}`,
    `  RPC: ${rpcStats.calls.toString()} calls, ${formatBytes(rpcStats.requestBytes)} sent, ${formatBytes(
      rpcStats.responseBytes,
    )} received (${formatBytes(totalRpcBytes)} total)`,
  ].join("\n");
}
