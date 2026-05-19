import { describe, expect, test } from "bun:test";
import { backfillDownForSlice, scanForwardToSafeHead, scanOneBlock } from "./scanner";
import { IGNORED_TRANSACTION_FROM_ADDRESS } from "./transactionFilter";
import type { EthereumRpcClient, RpcStats } from "./rpc";
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
    expect(storage.lastSuccessfulBlock).toBe(1n);
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
  aggregatedRanges: bigint[] = [];
  lastSuccessfulBlock: bigint | undefined;
  backfillNextBlock: bigint | undefined;

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
  ): Promise<void> {
    this.savedMetrics.push(metrics);
    if (transactions !== undefined) {
      this.savedTransactions.push(transactions);
    }

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

}

class SimpleRpc {
  requestedBlocks: bigint[] = [];

  constructor(
    private readonly failuresByBlock = new Map<bigint, number>(),
    private readonly transactionCount = 0,
  ) {}

  getStatsSnapshot(): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
  }

  getStatsSince(_snapshot: RpcStats): RpcStats {
    return { calls: 0, requestBytes: 0, responseBytes: 0 };
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
    ...overrides,
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
