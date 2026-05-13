import { formatBytes, formatDurationMs, formatGwei, formatKGas } from "./format";
import { computeBlockMetrics } from "./metrics";
import type { BlockMetrics, RpcReceipt } from "./types";
import type { EthereumRpcClient, RpcStats } from "./rpc";
import type { ScannerConfig } from "./config";
import type { ScannerStorage } from "./storage";

export async function runScanner(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
): Promise<void> {
  const lastSuccessfulBlock = storage.getLastSuccessfulBlock();
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
      await sleep(config.retryMs);
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

      await sleep(config.pollMs);
      continue;
    }

    try {
      await scanOneBlock(nextBlock, rpc, storage);
      nextBlock += 1n;
    } catch (error) {
      console.error(
        `Failed to scan block ${nextBlock.toString()}; retrying after ${config.retryMs}ms`,
        error,
      );
      await sleep(config.retryMs);
    }
  }
}

async function scanOneBlock(
  blockNumber: bigint,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
): Promise<void> {
  const startedAt = performance.now();
  const rpcStatsBefore = rpc.getStatsSnapshot();
  const block = await rpc.getBlockWithTransactions(blockNumber);
  const receipts: RpcReceipt[] = [];

  for (const transaction of block.transactions) {
    receipts.push(await rpc.getTransactionReceipt(transaction.hash));
  }

  const metrics = computeBlockMetrics(block, receipts);
  storage.saveBlockMetrics(metrics);
  const elapsedMs = performance.now() - startedAt;
  const rpcStats = rpc.getStatsSince(rpcStatsBefore);
  console.log(formatBlockSummary(metrics, elapsedMs, rpcStats));
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
    `  Avg priority fee: ${formatGwei(metrics.averagePriorityFeeWei)}`,
    `  Weighted avg priority fee: ${formatGwei(metrics.averagePriorityFeeWeightedWei)}`,
    `  Avg transaction fee: ${formatGwei(metrics.averageTransactionFeeWei)}`,
    `  RPC: ${rpcStats.calls.toString()} calls, ${formatBytes(rpcStats.requestBytes)} sent, ${formatBytes(
      rpcStats.responseBytes,
    )} received (${formatBytes(totalRpcBytes)} total)`,
  ].join("\n");
}
