import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { aggregateRanges } from "./aggregator";
import { type ScannerStorage } from "./storage";
import {
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { BlockMetrics } from "./types";

const cleanups: Array<() => Promise<void>> = [];

async function withStorage(): Promise<ScannerStorage> {
  const { storage, cleanup } = await createIsolatedStorage("aggregator");
  cleanups.push(cleanup);
  return storage;
}

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending) {
    await cleanup();
  }
});

afterAll(async () => {
  await closeTestPools();
});

if (!hasPostgresForTests()) {
  describe.skip("aggregateRanges (skipped: set TEST_DATABASE_URL to run)", () => {
    test("placeholder", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("aggregateRanges", () => {
    test("returns zero counts when there are no stored blocks", async () => {
      const storage = await withStorage();
      const result = await aggregateRanges(storage, { rangeSize: 50n });
      expect(result).toEqual({ written: 0, incomplete: 0 });
      expect(await storage.queryBlockRanges({ rangeSize: 50n })).toEqual([]);
    });

    test("aggregates only complete windows aligned to rangeSize", async () => {
      const storage = await withStorage();
      for (let blockNumber = 0n; blockNumber < 120n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const events: Array<{ rangeStart: bigint; status: string }> = [];
      const result = await aggregateRanges(storage, {
        rangeSize: 50n,
        onWindow: (rangeStart, status) => events.push({ rangeStart, status }),
      });

      expect(result.written).toBe(2);
      expect(result.incomplete).toBe(1);
      expect(result.firstRangeStart).toBe(0n);
      expect(result.lastRangeStart).toBe(100n);
      expect(events).toEqual([
        { rangeStart: 0n, status: "written" },
        { rangeStart: 50n, status: "written" },
        { rangeStart: 100n, status: "incomplete" },
      ]);

      const stored = await storage.queryBlockRanges({ rangeSize: 50n, order: "asc" });
      expect(stored.map((row) => row.rangeStart)).toEqual([0, 50]);
    });

    test("supports multiple range sizes independently", async () => {
      const storage = await withStorage();
      for (let blockNumber = 0n; blockNumber < 100n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      await aggregateRanges(storage, { rangeSize: 10n });
      await aggregateRanges(storage, { rangeSize: 100n });

      const tens = await storage.queryBlockRanges({ rangeSize: 10n, order: "asc" });
      const hundreds = await storage.queryBlockRanges({ rangeSize: 100n, order: "asc" });
      expect(tens.map((row) => row.rangeStart)).toEqual([
        0, 10, 20, 30, 40, 50, 60, 70, 80, 90,
      ]);
      expect(hundreds.map((row) => row.rangeStart)).toEqual([0]);
    });

    test("respects fromBlock and toBlock bounds", async () => {
      const storage = await withStorage();
      for (let blockNumber = 0n; blockNumber < 200n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await aggregateRanges(storage, {
        rangeSize: 50n,
        fromBlock: 60n,
        toBlock: 120n,
      });
      expect(result.firstRangeStart).toBe(50n);
      expect(result.lastRangeStart).toBe(100n);
      expect(result.written).toBe(2);
    });

    test("rejects unsupported rangeSize", async () => {
      const storage = await withStorage();
      expect(aggregateRanges(storage, { rangeSize: 7n })).rejects.toThrow();
    });
  });
}

function blockMetricsFixture(overrides: Partial<BlockMetrics> = {}): BlockMetrics {
  return {
    blockDate: "2024-01-01T00:00:00.000Z",
    blockNumber: 1n,
    baseBlockFeeWei: "100",
    totalGasUsed: "21000",
    maxGasInBlock: "30000000",
    transactionCount: 1,
    blockRewardWei: "210000",
    burntFeesWei: "2100000",
    totalTransactionFeeWei: "2310000",
    feePriceSumWei: "110",
    priorityFeeSumWei: "10",
    priorityFeeWeightedNumeratorWei: "23100000",
    priorityFeeGasWeightedNumeratorWei: "210000",
    averageFeePriceWei: "110",
    averageTransactionFeeWei: "2310000",
    averageTransactionGasUsed: "21000",
    averagePriorityFeeWeightedWei: "10",
    averagePriorityFeeWei: "10",
    ...overrides,
  };
}
