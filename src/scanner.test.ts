import { describe, expect, test } from "bun:test";
import {
  backfillDownForSlice,
  fillRecentMissingBatcherMetrics,
  runScanner,
  scanForwardToSafeHead,
  scanOneBlock,
} from "./scanner";
import { IGNORED_TRANSACTION_FROM_ADDRESS } from "./transactionFilter";
import type { EthereumRpcClient, RpcStats } from "./rpc";
import type { BatcherMetrics, BatcherMetricsSource } from "./batcher";
import type { BlockProgressUpdate, ScannerStorage } from "./storage";
import type { InspectedTransaction } from "./blockInspector";
import type { BlockMetrics, Hex, RpcBlock, RpcReceipt } from "./types";

describe("scanOneBlock", () => {
  test("fetches transaction receipts sequentially and stores transactions after all receipts finish", async () => {
    const rpc = new ControlledReceiptRpc(blockWithTransactions(4));
    const storage = new FakeStorage();

    const scanPromise = scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      2,
    );

    await waitUntil(() => rpc.pending.length === 1);
    expect(rpc.maxActiveReceipts).toBe(1);
    expect(rpc.requestedReceipts).toEqual([txHash(0)]);
    expect(storage.savedMetrics).toHaveLength(0);

    rpc.resolveNext();
    await waitUntil(() => rpc.requestedReceipts.length === 2);
    expect(rpc.maxActiveReceipts).toBe(1);
    expect(storage.savedMetrics).toHaveLength(0);

    rpc.resolveNext();
    await waitUntil(() => rpc.requestedReceipts.length === 3);
    rpc.resolveNext();
    await waitUntil(() => rpc.requestedReceipts.length === 4);
    rpc.resolveNext();
    await scanPromise;

    expect(rpc.requestedReceipts).toEqual([txHash(0), txHash(1), txHash(2), txHash(3)]);
    expect(storage.savedMetrics).toHaveLength(1);
    expect(storage.savedMetrics[0]?.transactionCount).toBe(4);
    expect(storage.savedTransactions).toHaveLength(1);
    expect(storage.savedTransactions[0]?.map((entry) => entry.hash)).toEqual([
      txHash(0),
      txHash(1),
      txHash(2),
      txHash(3),
    ]);
    expect(storage.savedRecordCandidates[0]?.map((entry) => entry.hash)).toEqual([
      txHash(0),
      txHash(1),
      txHash(2),
      txHash(3),
    ]);
  });

  test("does not aggregate ranges inline after storing a block", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();

    await scanOneBlock(
      245_650n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      1,
    );

    expect(storage.aggregatedRanges).toEqual([]);
    expect(storage.savedMetrics.map((entry) => entry.blockNumber)).toEqual([245_650n]);
  });

  test("stores block metrics without transaction rows when transaction data is disabled", async () => {
    const rpc = new SimpleRpc(new Map(), 2);
    const storage = new FakeStorage();

    await scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      1,
      { kind: "lastSuccessfulBlock" },
      {},
      false,
    );

    expect(storage.savedMetrics).toHaveLength(1);
    expect(storage.savedMetrics[0]?.transactionCount).toBe(2);
    expect(storage.savedTransactions).toHaveLength(0);
    expect(storage.savedRecordCandidates[0]?.map((entry) => entry.hash)).toEqual([
      txHash(0),
      txHash(1),
    ]);
    expect(storage.lastSuccessfulBlock).toBe(1n);
  });

  test("adds batcher collector metrics to stored block metrics when available", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    const batcher = new FakeBatcherCollector({
      batcherQueueSize: "906",
      batcherIntensity: "0",
      batcherLowerThreshold: "10000000",
      batcherUpperThreshold: "50000000",
      batcherMaxBlockSize: "10000000",
      batcherMaxTxSize: "0",
    });

    await scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      1,
      { kind: "lastSuccessfulBlock" },
      {},
      true,
      batcher,
    );

    expect(batcher.requestedDates).toEqual(["2024-01-12T04:09:36.000Z"]);
    expect(storage.savedMetrics[0]).toMatchObject({
      batcherQueueSize: "906",
      batcherIntensity: "0",
      batcherLowerThreshold: "10000000",
      batcherUpperThreshold: "50000000",
      batcherMaxBlockSize: "10000000",
      batcherMaxTxSize: "0",
    });
  });

  test("skips receipts and stored rows for transactions from the configured dead sender address", async () => {
    const block = blockWithTransactions(3);
    block.transactions[1] = {
      ...block.transactions[1]!,
      from: IGNORED_TRANSACTION_FROM_ADDRESS.toLowerCase() as Hex,
    };
    const rpc = new ControlledReceiptRpc(block);
    const storage = new FakeStorage();

    const scanPromise = scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      1,
    );

    await waitUntil(() => rpc.pending.length === 1);
    expect(rpc.requestedReceipts).toEqual([txHash(0)]);

    rpc.resolveNext();
    await waitUntil(() => rpc.requestedReceipts.length === 2);
    expect(rpc.requestedReceipts).toEqual([txHash(0), txHash(2)]);

    rpc.resolveNext();
    await scanPromise;

    expect(storage.savedMetrics[0]?.transactionCount).toBe(2);
    expect(storage.savedTransactions[0]?.map((entry) => entry.hash)).toEqual([txHash(0), txHash(2)]);
    expect(storage.savedTransactions[0]?.map((entry) => entry.position)).toEqual([0, 2]);
  });

  test("does not store metrics or transactions when a receipt read fails", async () => {
    const rpc = new ControlledReceiptRpc(blockWithTransactions(3));
    const storage = new FakeStorage();

    const scanPromise = scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      2,
    );

    await waitUntil(() => rpc.pending.length === 1);
    rpc.rejectNext(new Error("receipt failed"));

    await expect(scanPromise).rejects.toThrow("receipt failed");
    expect(storage.savedMetrics).toHaveLength(0);
    expect(storage.savedTransactions).toHaveLength(0);
    expect(rpc.requestedReceipts).toEqual([txHash(0)]);
  });
});

describe("fillRecentMissingBatcherMetrics", () => {
  test("fills stored recent blocks without changing scanner progress", async () => {
    const storage = new FakeStorage();
    storage.recentBlocksMissingBatcherMetrics = [
      blockMetricsFixture({ blockNumber: 10n, blockDate: "2026-05-22T15:17:01.000Z" }),
    ];
    const batcher = new FakeBatcherCollector({ batcherQueueSize: "906" });

    const updated = await fillRecentMissingBatcherMetrics(
      storage as unknown as ScannerStorage,
      batcher,
    );

    expect(updated).toBe(1);
    expect(storage.savedBatcherMetrics).toEqual([
      { blockNumber: 10n, metrics: { batcherQueueSize: "906" } },
    ]);
    expect(storage.lastSuccessfulBlock).toBeUndefined();
  });
});

describe("backfillDownForSlice", () => {
  test("seeds from safe head and advances the backfill cursor after a successful write", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    const runtime = new FakeRuntime([0, 0, 20_000]);

    const lowestBackfilled = await backfillDownForSlice(
      100n,
      config({ oldestBackfillBlock: 90n }),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      runtime,
    );

    expect(lowestBackfilled).toBe(100n);
    expect(rpc.requestedBlocks).toEqual([100n]);
    expect(storage.backfillNextBlock).toBe(99n);
    expect(storage.lastSuccessfulBlock).toBeUndefined();
  });

  test("stops at the oldest backfill block", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    const runtime = new FakeRuntime();

    const lowestBackfilled = await backfillDownForSlice(
      100n,
      config({ oldestBackfillBlock: 99n }),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      runtime,
    );

    expect(lowestBackfilled).toBe(99n);
    expect(rpc.requestedBlocks).toEqual([100n, 99n]);
    expect(storage.backfillNextBlock).toBe(98n);
  });

  test("sleeps after every successful backfill block", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    const runtime = new FakeRuntime();

    await backfillDownForSlice(
      100n,
      config({ oldestBackfillBlock: 99n, backfillSleepMs: 100 }),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      runtime,
    );

    expect(rpc.requestedBlocks).toEqual([100n, 99n]);
    expect(runtime.sleeps).toEqual([100, 100]);
    expect(storage.backfillNextBlock).toBe(98n);
  });

  test("retries the same failed backfill block without advancing the cursor", async () => {
    const rpc = new SimpleRpc(new Map([[100n, 1]]));
    const storage = new FakeStorage();
    const runtime = new FakeRuntime([0, 0, 20_000]);

    await backfillDownForSlice(
      100n,
      config({ oldestBackfillBlock: 90n, retryMs: 7 }),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      runtime,
    );

    expect(rpc.requestedBlocks).toEqual([100n, 100n]);
    expect(runtime.sleeps).toEqual([7]);
    expect(storage.backfillNextBlock).toBe(99n);
  });
});

describe("scanForwardToSafeHead", () => {
  test("scans forward from the backfill lower bound when there is no forward progress", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();

    const scanned = await scanForwardToSafeHead(
      100n,
      98n,
      config(),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      new FakeRuntime(),
    );

    expect(scanned).toBe(true);
    expect(rpc.requestedBlocks).toEqual([98n, 99n, 100n]);
    expect(storage.lastSuccessfulBlock).toBe(100n);
    expect(storage.backfillNextBlock).toBeUndefined();
  });

  test("continues forward from the existing last successful block", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    storage.lastSuccessfulBlock = 100n;

    const scanned = await scanForwardToSafeHead(
      102n,
      95n,
      config(),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      new FakeRuntime(),
    );

    expect(scanned).toBe(true);
    expect(rpc.requestedBlocks).toEqual([101n, 102n]);
    expect(storage.lastSuccessfulBlock).toBe(102n);
  });

  test("catches up sequentially from existing progress even when the lower bound is ahead", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    storage.lastSuccessfulBlock = 90n;

    const scanned = await scanForwardToSafeHead(
      100n,
      100n,
      config({ disableBackfill: true }),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      new FakeRuntime(),
    );

    expect(scanned).toBe(true);
    expect(rpc.requestedBlocks).toEqual([91n, 92n, 93n, 94n, 95n, 96n, 97n, 98n, 99n, 100n]);
    expect(storage.lastSuccessfulBlock).toBe(100n);
  });

  test("retries the same failed forward block without skipping it", async () => {
    const rpc = new SimpleRpc(new Map([[99n, 1]]));
    const storage = new FakeStorage();
    const runtime = new FakeRuntime();

    await scanForwardToSafeHead(
      100n,
      99n,
      config({ retryMs: 11 }),
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      runtime,
    );

    expect(rpc.requestedBlocks).toEqual([99n, 99n, 100n]);
    expect(runtime.sleeps).toEqual([11]);
    expect(storage.lastSuccessfulBlock).toBe(100n);
  });

  test("logs failed forward blocks with block number and RPC endpoint", async () => {
    const rpc = new SimpleRpc(new Map([[99n, 1]]));
    const storage = new FakeStorage();
    const runtime = new FakeRuntime();
    const captured = captureConsoleError();

    try {
      await scanForwardToSafeHead(
        99n,
        99n,
        config({ retryMs: 11 }),
        rpc as unknown as EthereumRpcClient,
        storage as unknown as ScannerStorage,
        runtime,
      );
    } finally {
      captured.restore();
    }

    expect(String(captured.calls[0]?.[0])).toContain(
      "Failed to forward scan block 99 via RPC endpoint https://example.test",
    );
    expect(captured.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});

describe("runScanner", () => {
  test("disable-backfill mode catches up sequentially when progress is behind the safe head", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    storage.lastSuccessfulBlock = 90n;
    const runtime = new StopAfterFirstSleepRuntime();

    await expect(
      runScanner(
        config({
          confirmationDepth: 0n,
          disableBackfill: true,
        }),
        rpc as unknown as EthereumRpcClient,
        storage as unknown as ScannerStorage,
        runtime,
      ),
    ).rejects.toThrow("stop after first sleep");

    expect(rpc.requestedBlocks).toEqual([91n, 92n, 93n, 94n, 95n, 96n, 97n, 98n, 99n, 100n]);
    expect(storage.lastSuccessfulBlock).toBe(100n);
    expect(storage.backfillNextBlock).toBeUndefined();
  });

  test("backfill-only mode updates only the backfill cursor", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    const runtime = new StopAfterFirstSleepRuntime();

    await expect(
      runScanner(
        config({
          backfillOnly: true,
          backfillSleepMs: 100,
          confirmationDepth: 0n,
          oldestBackfillBlock: 90n,
        }),
        rpc as unknown as EthereumRpcClient,
        storage as unknown as ScannerStorage,
        runtime,
      ),
    ).rejects.toThrow("stop after first sleep");

    expect(rpc.requestedBlocks).toEqual([100n]);
    expect(storage.backfillNextBlock).toBe(99n);
    expect(storage.lastSuccessfulBlock).toBeUndefined();
    expect(runtime.sleeps).toEqual([100]);
  });

  test("backfill-only mode with backfill disabled idles without scanning", async () => {
    const rpc = new SimpleRpc();
    const storage = new FakeStorage();
    const runtime = new StopAfterFirstSleepRuntime();

    await expect(
      runScanner(
        config({
          backfillOnly: true,
          disableBackfill: true,
          confirmationDepth: 0n,
          oldestBackfillBlock: 90n,
        }),
        rpc as unknown as EthereumRpcClient,
        storage as unknown as ScannerStorage,
        runtime,
      ),
    ).rejects.toThrow("stop after first sleep");

    expect(rpc.requestedBlocks).toEqual([]);
    expect(storage.backfillNextBlock).toBeUndefined();
    expect(storage.lastSuccessfulBlock).toBeUndefined();
  });

  test("logs latest block read failures with latest block target and RPC endpoint", async () => {
    const rpc = new LatestBlockFailureRpc();
    const storage = new FakeStorage();
    const runtime = new StopAfterFirstSleepRuntime();
    const captured = captureConsoleError();

    try {
      await expect(
        runScanner(
          config({ retryMs: 13 }),
          rpc as unknown as EthereumRpcClient,
          storage as unknown as ScannerStorage,
          runtime,
        ),
      ).rejects.toThrow("stop after first sleep");
    } finally {
      captured.restore();
    }

    expect(String(captured.calls[0]?.[0])).toContain(
      "Failed to read latest block (block target: latest) via RPC endpoint https://example.test",
    );
    expect(captured.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});

class ControlledReceiptRpc {
  activeReceipts = 0;
  maxActiveReceipts = 0;
  requestedReceipts: Hex[] = [];
  pending: Array<{
    hash: Hex;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly block: RpcBlock) {}

  getStatsSnapshot(): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  getStatsSince(_snapshot: RpcStats): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  async getBlockWithTransactions(blockNumber: bigint): Promise<RpcBlock> {
    expect(blockNumber).toBe(1n);
    return this.block;
  }

  async getTransactionReceipt(hash: Hex): Promise<RpcReceipt> {
    this.requestedReceipts.push(hash);
    this.activeReceipts += 1;
    this.maxActiveReceipts = Math.max(this.maxActiveReceipts, this.activeReceipts);

    try {
      await new Promise<void>((resolve, reject) => {
        this.pending.push({
          hash,
          resolve,
          reject,
        });
      });
      return receiptFor(hash);
    } finally {
      this.activeReceipts -= 1;
    }
  }

  resolveNext(): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No pending receipt to resolve");
    }

    pending.resolve();
  }

  rejectNext(error: Error): void {
    const pending = this.pending.shift();
    if (!pending) {
      throw new Error("No pending receipt to reject");
    }

    pending.reject(error);
  }

  resolveAll(): void {
    while (this.pending.length > 0) {
      this.resolveNext();
    }
  }
}

class FakeStorage {
  savedMetrics: BlockMetrics[] = [];
  savedTransactions: InspectedTransaction[][] = [];
  savedRecordCandidates: InspectedTransaction[][] = [];
  savedBatcherMetrics: Array<{ blockNumber: bigint; metrics: BatcherMetrics }> = [];
  recentBlocksMissingBatcherMetrics: BlockMetrics[] = [];
  aggregatedRanges: bigint[] = [];
  lastSuccessfulBlock: bigint | undefined;
  backfillNextBlock: bigint | undefined;
  chainProgress: Array<{ latestBlock: bigint; safeHead: bigint }> = [];

  async getLastSuccessfulBlock(): Promise<bigint | undefined> {
    return this.lastSuccessfulBlock;
  }

  async getBackfillNextBlock(): Promise<bigint | undefined> {
    return this.backfillNextBlock;
  }

  async saveBlockMetrics(
    metrics: BlockMetrics,
    progressUpdate: BlockProgressUpdate = { kind: "lastSuccessfulBlock" },
    transactions?: InspectedTransaction[],
    recordCandidates: InspectedTransaction[] = transactions ?? [],
  ): Promise<void> {
    this.savedMetrics.push(metrics);
    if (transactions !== undefined) {
      this.savedTransactions.push(transactions);
    }
    this.savedRecordCandidates.push(recordCandidates);

    switch (progressUpdate.kind) {
      case "lastSuccessfulBlock":
        this.lastSuccessfulBlock = metrics.blockNumber;
        return;
      case "backfillNextBlock":
        this.backfillNextBlock = progressUpdate.nextBlock;
        return;
      case "none":
        return;
    }
  }

  async queryRecentBlocksMissingBatcherMetrics(): Promise<BlockMetrics[]> {
    return this.recentBlocksMissingBatcherMetrics;
  }

  async saveBatcherMetricsForBlock(blockNumber: bigint, metrics: BatcherMetrics): Promise<boolean> {
    this.savedBatcherMetrics.push({ blockNumber, metrics });
    return true;
  }

  async saveChainProgress(latestBlock: bigint, safeHead: bigint): Promise<void> {
    this.chainProgress.push({ latestBlock, safeHead });
  }
}

class FakeBatcherCollector implements BatcherMetricsSource {
  requestedDates: string[] = [];

  constructor(private readonly metrics: BatcherMetrics | undefined) {}

  async getMetricsForBlockDate(blockDate: string): Promise<BatcherMetrics | undefined> {
    this.requestedDates.push(blockDate);
    return this.metrics;
  }
}

class SimpleRpc {
  readonly rpcUrl = "https://example.test";
  requestedBlocks: bigint[] = [];

  constructor(
    private readonly failuresByBlock = new Map<bigint, number>(),
    private readonly transactionCount = 0,
    private readonly latestBlock = 100n,
  ) {}

  getStatsSnapshot(): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  getStatsSince(_snapshot: RpcStats): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  async getLatestBlockNumber(): Promise<bigint> {
    return this.latestBlock;
  }

  async getBlockWithTransactions(blockNumber: bigint): Promise<RpcBlock> {
    this.requestedBlocks.push(blockNumber);

    const failuresRemaining = this.failuresByBlock.get(blockNumber) ?? 0;
    if (failuresRemaining > 0) {
      this.failuresByBlock.set(blockNumber, failuresRemaining - 1);
      throw new Error(`block ${blockNumber.toString()} failed`);
    }

    return blockWithTransactions(this.transactionCount, blockNumber);
  }

  async getTransactionReceipt(hash: Hex): Promise<RpcReceipt> {
    return receiptFor(hash);
  }
}

class LatestBlockFailureRpc {
  readonly rpcUrl = "https://example.test";

  getStatsSnapshot(): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  getStatsSince(_snapshot: RpcStats): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  async getLatestBlockNumber(): Promise<bigint> {
    throw new Error("latest block failed");
  }

  async getBlockWithTransactions(_blockNumber: bigint): Promise<RpcBlock> {
    throw new Error("unexpected block read");
  }

  async getTransactionReceipt(_hash: Hex): Promise<RpcReceipt> {
    throw new Error("unexpected receipt read");
  }
}

class FakeRuntime {
  sleeps: number[] = [];

  constructor(private readonly nowValues: number[] = []) {}

  now(): number {
    return this.nowValues.shift() ?? 0;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }
}

class StopAfterFirstSleepRuntime extends FakeRuntime {
  override async sleep(ms: number): Promise<void> {
    await super.sleep(ms);
    throw new Error("stop after first sleep");
  }
}

function blockWithTransactions(transactionCount: number, blockNumber = 1n): RpcBlock {
  return {
    number: `0x${blockNumber.toString(16)}`,
    timestamp: "0x65a0bb80",
    baseFeePerGas: "0x1",
    gasUsed: "0x4",
    gasLimit: "0x1c9c380",
    transactions: Array.from({ length: transactionCount }, (_unused, index) => ({
      hash: txHash(index),
      from: "0x111",
      to: "0x222",
      type: "0x2",
      nonce: `0x${index.toString(16)}`,
      value: "0x0",
      gas: "0x5208",
      gasPrice: "0x2",
      maxFeePerGas: "0x3",
      maxPriorityFeePerGas: "0x1",
    })),
  };
}

function receiptFor(hash: Hex): RpcReceipt {
  return {
    transactionHash: hash,
    gasUsed: "0x1",
    effectiveGasPrice: "0x2",
  };
}

function txHash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function blockMetricsFixture(overrides: Partial<BlockMetrics> = {}): BlockMetrics {
  return {
    blockDate: "2024-01-01T00:00:00.000Z",
    blockNumber: 1n,
    baseBlockFeeWei: "1",
    totalGasUsed: "0",
    maxGasInBlock: "0",
    transactionCount: 0,
    blockRewardWei: "0",
    burntFeesWei: "0",
    totalTransactionFeeWei: "0",
    feePriceSumWei: "0",
    priorityFeeSumWei: "0",
    priorityFeeWeightedNumeratorWei: "0",
    priorityFeeGasWeightedNumeratorWei: "0",
    averageFeePriceWei: "0",
    averageTransactionFeeWei: "0",
    averageTransactionGasUsed: "0",
    averagePriorityFeeWeightedWei: "0",
    averagePriorityFeeWei: "0",
    ...overrides,
  };
}

function config(overrides: Partial<Parameters<typeof backfillDownForSlice>[1]> = {}): Parameters<typeof backfillDownForSlice>[1] {
  return {
    rpcUrl: "https://example.test",
    databaseUrl: "postgres://localhost/test",
    oldestBackfillBlock: 0n,
    confirmationDepth: 3n,
    pollMs: 12_000,
    retryMs: 5_000,
    txReceiptConcurrency: 1,
    saveTransactionData: true,
    disableBackfill: false,
    backfillOnly: false,
    backfillSleepMs: 0,
    ...overrides,
  };
}

function captureConsoleError(): { calls: unknown[][]; restore: () => void } {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const startedAt = performance.now();

  while (!condition()) {
    if (performance.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }

    await sleep(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
