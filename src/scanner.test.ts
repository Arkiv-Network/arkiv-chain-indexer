import { describe, expect, test } from "bun:test";
import { scanOneBlock } from "./scanner";
import type { EthereumRpcClient, RpcStats } from "./rpc";
import type { ScannerStorage } from "./storage";
import type { BlockMetrics, Hex, RpcBlock, RpcReceipt } from "./types";

describe("scanOneBlock", () => {
  test("limits transaction receipt fetches and stores after all receipts finish", async () => {
    const rpc = new ControlledReceiptRpc(blockWithTransactions(4));
    const storage = new FakeStorage();

    const scanPromise = scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      2,
    );

    await waitUntil(() => rpc.pending.length === 2);
    expect(rpc.maxActiveReceipts).toBe(2);
    expect(rpc.requestedReceipts).toEqual([txHash(0), txHash(1)]);
    expect(storage.savedMetrics).toHaveLength(0);

    rpc.resolveNext();
    await waitUntil(() => rpc.requestedReceipts.length === 3);
    expect(rpc.maxActiveReceipts).toBe(2);
    expect(storage.savedMetrics).toHaveLength(0);

    rpc.resolveNext();
    await waitUntil(() => rpc.requestedReceipts.length === 4);
    rpc.resolveAll();
    await scanPromise;

    expect(rpc.requestedReceipts).toEqual([txHash(0), txHash(1), txHash(2), txHash(3)]);
    expect(storage.savedMetrics).toHaveLength(1);
    expect(storage.savedMetrics[0]?.transactionCount).toBe(4);
  });

  test("waits for all receipt jobs to settle before failing the block", async () => {
    const rpc = new ControlledReceiptRpc(blockWithTransactions(3));
    const storage = new FakeStorage();
    let settled = false;

    const scanPromise = scanOneBlock(
      1n,
      rpc as unknown as EthereumRpcClient,
      storage as unknown as ScannerStorage,
      2,
    ).finally(() => {
      settled = true;
    });

    await waitUntil(() => rpc.pending.length === 2);
    rpc.rejectNext(new Error("receipt failed"));
    await waitUntil(() => rpc.requestedReceipts.length === 3);

    expect(settled).toBe(false);
    expect(storage.savedMetrics).toHaveLength(0);

    rpc.resolveAll();

    await expect(scanPromise).rejects.toThrow("receipt failed");
    expect(storage.savedMetrics).toHaveLength(0);
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

  saveBlockMetrics(metrics: BlockMetrics): void {
    this.savedMetrics.push(metrics);
  }
}

function blockWithTransactions(transactionCount: number): RpcBlock {
  return {
    number: "0x1",
    timestamp: "0x65a0bb80",
    baseFeePerGas: "0x1",
    gasUsed: "0x4",
    gasLimit: "0x1c9c380",
    transactions: Array.from({ length: transactionCount }, (_unused, index) => ({
      hash: txHash(index),
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
