import { formatBytes, formatDurationMs, formatGwei, formatKGas } from "./format";
import { decodeBlockArkivOperations, type ArkivDecoderClient } from "./arkivOperations";
import { inspectBlockFromRpc } from "./blockInspector";
import { readBuildInfo } from "./buildInfo";
import { computeBlockMetrics } from "./metrics";
import { shouldIgnoreTransaction } from "./transactionFilter";
import type { BatcherMetricsSource } from "./batcher";
import type { GuzzlerRecorder } from "./guzzlers";
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
  batcherCollector?: BatcherMetricsSource,
  guzzlerRecorder?: GuzzlerRecorder,
  decoderClient?: ArkivDecoderClient,
): Promise<void> {
  logBuildInfo();
  console.log(`Transaction row storage: ${config.saveTransactionData ? "enabled" : "disabled"}`);
  console.log(`Guzzler tracking: ${guzzlerRecorder ? "enabled" : "disabled"}`);
  console.log(
    `Arkiv operation decoding: ${decoderClient ? `enabled (${decoderClient.baseUrl})` : "disabled"}`,
  );
  if (decoderClient && !config.saveTransactionData) {
    console.warn(
      "Arkiv operation decoding is skipped because transaction row storage is disabled",
    );
  }
  if (config.backfillOnly) {
    await runBackfillScanner(config, rpc, storage, runtime, batcherCollector, decoderClient);
    return;
  }

  await runNearHeadBackfillScanner(
    config,
    rpc,
    storage,
    runtime,
    batcherCollector,
    guzzlerRecorder,
    decoderClient,
  );
}

function logBuildInfo(): void {
  const build = readBuildInfo();
  console.log(
    `Scanner build: commit ${build.commit ?? "unknown"}, built at ${build.builtAtUtc ?? "unknown"}`,
  );
}

async function runNearHeadBackfillScanner(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime,
  batcherCollector: BatcherMetricsSource | undefined,
  guzzlerRecorder: GuzzlerRecorder | undefined,
  decoderClient: ArkivDecoderClient | undefined,
): Promise<void> {
  if (config.disableBackfill) {
    console.log("Starting near-head scanner with backfill disabled");
  } else {
    console.log(
      `Starting near-head scanner with oldest backfill block ${config.oldestBackfillBlock.toString()}`,
    );
  }

  while (true) {
    let lowestBackfilledBlock: bigint | undefined;
    if (!config.disableBackfill) {
      const backfillSafeHead = await readSafeHeadWithRetry(config, rpc, storage, runtime);
      lowestBackfilledBlock = await backfillDownForSlice(
        backfillSafeHead,
        config,
        rpc,
        storage,
        runtime,
        batcherCollector,
        decoderClient,
      );
    }

    const catchUpSafeHead = await readSafeHeadWithRetry(config, rpc, storage, runtime);
    const scannedForward = await scanForwardToSafeHead(
      catchUpSafeHead,
      lowestBackfilledBlock ?? catchUpSafeHead,
      config,
      rpc,
      storage,
      runtime,
      batcherCollector,
      guzzlerRecorder,
      decoderClient,
    );
    await fillRecentMissingBatcherMetrics(storage, batcherCollector);

    if (!scannedForward) {
      await runtime.sleep(config.pollMs);
    }
  }
}

async function runBackfillScanner(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime,
  batcherCollector: BatcherMetricsSource | undefined,
  decoderClient: ArkivDecoderClient | undefined,
): Promise<void> {
  if (config.disableBackfill) {
    console.log("Backfill-only scanner started with backfill disabled; idling without scanning");
    while (true) {
      await runtime.sleep(config.pollMs);
    }
  }

  console.log(
    `Starting backfill-only scanner with oldest backfill block ${config.oldestBackfillBlock.toString()}`,
  );

  while (true) {
    const safeHead = await readSafeHeadWithRetry(config, rpc, storage, runtime);
    const lowestBackfilledBlock = await backfillDownForSlice(
      safeHead,
      config,
      rpc,
      storage,
      runtime,
      batcherCollector,
      decoderClient,
    );
    await fillRecentMissingBatcherMetrics(storage, batcherCollector);

    if (lowestBackfilledBlock === undefined) {
      await runtime.sleep(config.pollMs);
    }
  }
}

async function readSafeHeadWithRetry(
  config: ScannerConfig,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  runtime: ScannerRuntime,
): Promise<bigint> {
  while (true) {
    try {
      const latestBlock = await rpc.getLatestBlockNumber();
      const safeHead = computeSafeHead(latestBlock, config.confirmationDepth);
      await recordChainProgress(storage, latestBlock, safeHead);
      return safeHead;
    } catch (error) {
      console.error(
        `Failed to read latest block (block target: latest) via RPC endpoint ${rpc.rpcUrl}; retrying after ${config.retryMs}ms`,
        error,
      );
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
  batcherCollector?: BatcherMetricsSource,
  decoderClient?: ArkivDecoderClient,
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
      { safeHead },
      batcherCollector,
      undefined,
      decoderClient,
    );

    lowestBackfilledBlock = blockToScan;
    nextBackfillBlock -= 1n;
    if (config.backfillSleepMs > 0) {
      await runtime.sleep(config.backfillSleepMs);
    }
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
  batcherCollector?: BatcherMetricsSource,
  guzzlerRecorder?: GuzzlerRecorder,
  decoderClient?: ArkivDecoderClient,
): Promise<boolean> {
  const lastSuccessfulBlock = await storage.getLastSuccessfulBlock();
  // Cold start: no prior progress — jump to the lower bound (typically the
  // current safe head, or the lowest block already filled by backfill in this
  // slice). Once we have any progress, always resume strictly at
  // lastSuccessfulBlock + 1 so we never silently skip blocks near the head.
  let nextBlock =
    lastSuccessfulBlock === undefined ? initialLowerBound : lastSuccessfulBlock + 1n;
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
      { safeHead },
      batcherCollector,
      guzzlerRecorder,
      decoderClient,
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
  summaryContext: BlockSummaryContext = {},
  batcherCollector?: BatcherMetricsSource,
  guzzlerRecorder?: GuzzlerRecorder,
  decoderClient?: ArkivDecoderClient,
): Promise<void> {
  while (true) {
    try {
      await scanOneBlock(
        blockNumber,
        rpc,
        storage,
        config.txReceiptConcurrency,
        progressUpdate,
        summaryContext,
        config.saveTransactionData,
        batcherCollector,
        guzzlerRecorder,
        decoderClient,
      );
      return;
    } catch (error) {
      console.error(
        `Failed to ${direction} scan block ${blockNumber.toString()} via RPC endpoint ${rpc.rpcUrl}; retrying after ${config.retryMs}ms`,
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
  summaryContext: BlockSummaryContext = {},
  saveTransactionData = true,
  batcherCollector?: BatcherMetricsSource,
  guzzlerRecorder?: GuzzlerRecorder,
  decoderClient?: ArkivDecoderClient,
): Promise<void> {
  const startedAt = performance.now();
  const rpcStatsBefore = rpc.getStatsSnapshot();
  const block = await rpc.getBlockWithTransactions(blockNumber);
  const previousBlock = blockNumber === 0n ? undefined : await rpc.getBlockWithTransactions(blockNumber - 1n);
  const receipts = await getTransactionReceipts(block, rpc, txReceiptConcurrency);

  const metrics = await enrichWithBatcherMetrics(
    computeBlockMetrics(block, receipts, previousBlock),
    batcherCollector,
  );
  const inspectedTransactions = inspectBlockFromRpc(block, receipts).transactions;
  const transactions = saveTransactionData ? inspectedTransactions : undefined;
  // A decoder failure throws here and is retried by scanBlockWithRetry, so a
  // decoder outage cannot create silent gaps in stored operations.
  const operations =
    decoderClient && saveTransactionData
      ? await decodeBlockArkivOperations(block, decoderClient)
      : undefined;
  await storage.saveBlockMetrics(
    metrics,
    progressUpdate,
    transactions,
    inspectedTransactions,
    operations,
  );
  await recordGuzzlerTransactions(guzzlerRecorder, metrics.blockDate, inspectedTransactions);
  const elapsedMs = performance.now() - startedAt;
  const rpcStats = rpc.getStatsSince(rpcStatsBefore);
  console.log(formatBlockSummary(metrics, elapsedMs, rpcStats, summaryContext));
}

export async function fillRecentMissingBatcherMetrics(
  storage: ScannerStorage,
  batcherCollector: BatcherMetricsSource | undefined,
): Promise<number> {
  if (!batcherCollector) return 0;

  let updated = 0;
  let blocks: Awaited<ReturnType<ScannerStorage["queryRecentBlocksMissingBatcherMetrics"]>>;
  try {
    blocks = await storage.queryRecentBlocksMissingBatcherMetrics();
  } catch (error) {
    console.error("Failed to query blocks missing batcher metrics", error);
    return 0;
  }

  for (const block of blocks) {
    try {
      const metrics = await batcherCollector.getMetricsForBlockDate(block.blockDate);
      if (!metrics) continue;
      if (await storage.saveBatcherMetricsForBlock(BigInt(block.blockNumber), metrics)) {
        updated += 1;
      }
    } catch (error) {
      console.error(`Failed to fetch batcher metrics for block ${block.blockNumber}`, error);
    }
  }
  return updated;
}

async function recordGuzzlerTransactions(
  guzzlerRecorder: GuzzlerRecorder | undefined,
  blockDate: string,
  transactions: ReturnType<typeof inspectBlockFromRpc>["transactions"],
): Promise<void> {
  if (!guzzlerRecorder) {
    return;
  }
  const blockTimestampMs = Date.parse(blockDate);
  if (!Number.isFinite(blockTimestampMs)) {
    return;
  }
  try {
    await guzzlerRecorder.recordBlock(
      blockTimestampMs,
      transactions.map((transaction) => ({
        from: transaction.from,
        hash: transaction.hash,
        gasUsed: transaction.gasUsed,
        feeWei: transaction.transactionFeeWei,
      })),
    );
  } catch (error) {
    console.error("Failed to record guzzler transactions", error);
  }
}

async function enrichWithBatcherMetrics(
  metrics: BlockMetrics,
  batcherCollector: BatcherMetricsSource | undefined,
): Promise<BlockMetrics> {
  if (!batcherCollector) return metrics;

  try {
    const batcherMetrics = await batcherCollector.getMetricsForBlockDate(metrics.blockDate);
    return batcherMetrics ? { ...metrics, ...batcherMetrics } : metrics;
  } catch (error) {
    console.error(`Failed to fetch batcher metrics for block ${metrics.blockNumber.toString()}`, error);
    return metrics;
  }
}

interface BlockSummaryContext {
  latestBlock?: bigint;
  safeHead?: bigint;
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
    if (shouldIgnoreTransaction(transaction)) {
      continue;
    }
    receipts.push(await rpc.getTransactionReceipt(transaction.hash));
  }
  return receipts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordChainProgress(
  storage: ScannerStorage,
  latestBlock: bigint,
  safeHead: bigint,
): Promise<void> {
  try {
    await storage.saveChainProgress(latestBlock, safeHead);
  } catch (error) {
    console.error("Failed to store chain progress metadata", error);
  }
}

function formatBlockSummary(
  metrics: BlockMetrics,
  elapsedMs: number,
  rpcStats: RpcStats,
  context: BlockSummaryContext,
): string {
  const totalRpcBytes = rpcStats.requestBytes + rpcStats.responseBytes;
  const safeHeadLag =
    context.safeHead !== undefined ? context.safeHead - metrics.blockNumber : undefined;
  const headLag =
    context.latestBlock !== undefined ? context.latestBlock - metrics.blockNumber : undefined;
  const blockAgeMs = Date.now() - Date.parse(metrics.blockDate);

  return [
    `Block ${metrics.blockNumber.toString()} scanned and stored`,
    `  Date: ${metrics.blockDate}`,
    `  Block time: ${metrics.blockTimeSeconds}s`,
    `  Block age: ${Number.isFinite(blockAgeMs) ? formatDurationMs(Math.max(0, blockAgeMs)) : "unknown"}`,
    ...(context.safeHead !== undefined
      ? [`  Safe head lag: ${safeHeadLag !== undefined && safeHeadLag >= 0n ? safeHeadLag.toString() : "0"} blocks`]
      : []),
    ...(context.latestBlock !== undefined
      ? [`  Chain head lag: ${headLag !== undefined && headLag >= 0n ? headLag.toString() : "0"} blocks`]
      : []),
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
