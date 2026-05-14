import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  type ScannerStorage,
} from "./storage";
import { DEFAULT_RANGE_SIZE } from "./ranges";
import {
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { BlockMetrics } from "./types";

const RANGE_SIZE = DEFAULT_RANGE_SIZE;

const cleanups: Array<() => Promise<void>> = [];

async function withStorage(): Promise<ScannerStorage> {
  const { storage, cleanup } = await createIsolatedStorage("storage");
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
  describe.skip("ScannerStorage (skipped: set TEST_DATABASE_URL to run)", () => {
    test("placeholder", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("ScannerStorage", () => {
    test("saves block metrics and resumes from the last successful block", async () => {
      const storage = await withStorage();

      expect(await storage.getLastSuccessfulBlock()).toBeUndefined();

      await storage.saveBlockMetrics({
        blockDate: "2024-01-01T00:00:00.000Z",
        blockNumber: 42n,
        baseBlockFeeWei: "100",
        totalGasUsed: "21000",
        maxGasInBlock: "30000000",
        transactionCount: 1,
        averageTransactionFeeWei: "2310000",
        averagePriorityFeeWeightedWei: "10",
        averagePriorityFeeWei: "10",
      });

      expect(await storage.getLastSuccessfulBlock()).toBe(42n);
    });

    test("saves backfill cursor separately from forward progress", async () => {
      const storage = await withStorage();

      await storage.saveBlockMetrics(
        {
          blockDate: "2024-01-01T00:00:00.000Z",
          blockNumber: 50n,
          baseBlockFeeWei: "100",
          totalGasUsed: "21000",
          maxGasInBlock: "30000000",
          transactionCount: 1,
          averageTransactionFeeWei: "2310000",
          averagePriorityFeeWeightedWei: "10",
          averagePriorityFeeWei: "10",
        },
        { kind: "backfillNextBlock", nextBlock: 49n },
      );

      expect(await storage.getLastSuccessfulBlock()).toBeUndefined();
      expect(await storage.getBackfillNextBlock()).toBe(49n);
    });

    test("supports very large block numbers (beyond Number.MAX_SAFE_INTEGER)", async () => {
      const storage = await withStorage();
      const bigBlock = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
      await storage.saveBlockMetrics({
        blockDate: "2024-01-01T00:00:00.000Z",
        blockNumber: bigBlock,
        baseBlockFeeWei: "100",
        totalGasUsed: "21000",
        maxGasInBlock: "30000000",
        transactionCount: 1,
        averageTransactionFeeWei: "2310000",
        averagePriorityFeeWeightedWei: "10",
        averagePriorityFeeWei: "10",
      });
      expect(await storage.getLastSuccessfulBlock()).toBe(bigBlock);
    });
  });

  describe("ScannerStorage.queryBlocks", () => {
    test("returns blocks ordered ascending by block number", async () => {
      const storage = await withStorage();
      for (const blockNumber of [3n, 1n, 2n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await storage.queryBlocks();
      expect(result.map((row) => row.blockNumber)).toEqual([1, 2, 3]);
    });

    test("returns all stored fields in camelCase", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(
        blockMetricsFixture({
          blockNumber: 7n,
          blockDate: "2024-02-01T00:00:00.000Z",
          baseBlockFeeWei: "12345",
          totalGasUsed: "21000",
          maxGasInBlock: "30000000",
          transactionCount: 5,
          averageTransactionFeeWei: "42",
          averagePriorityFeeWeightedWei: "11",
          averagePriorityFeeWei: "7",
        }),
      );

      const [row] = await storage.queryBlocks();
      expect(row).toEqual({
        blockNumber: 7,
        blockDate: "2024-02-01T00:00:00.000Z",
        baseBlockFeeWei: "12345",
        totalGasUsed: "21000",
        maxGasInBlock: "30000000",
        transactionCount: 5,
        averageTransactionFeeWei: "42",
        averagePriorityFeeWeightedWei: "11",
        averagePriorityFeeWei: "7",
      });
    });

    test("filters by blockGt and blockLt exclusively and combines them additively", async () => {
      const storage = await withStorage();
      for (let blockNumber = 10n; blockNumber <= 20n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await storage.queryBlocks({ blockGt: 12n, blockLt: 16n });
      expect(result.map((row) => row.blockNumber)).toEqual([13, 14, 15]);
    });

    test("filters by dateGt and dateLt exclusively", async () => {
      const storage = await withStorage();
      const samples = [
        { blockNumber: 1n, blockDate: "2024-01-01T00:00:00.000Z" },
        { blockNumber: 2n, blockDate: "2024-01-02T00:00:00.000Z" },
        { blockNumber: 3n, blockDate: "2024-01-03T00:00:00.000Z" },
        { blockNumber: 4n, blockDate: "2024-01-04T00:00:00.000Z" },
      ];
      for (const sample of samples) {
        await storage.saveBlockMetrics(blockMetricsFixture(sample));
      }

      const result = await storage.queryBlocks({
        dateGt: "2024-01-01T00:00:00.000Z",
        dateLt: "2024-01-04T00:00:00.000Z",
      });
      expect(result.map((row) => row.blockNumber)).toEqual([2, 3]);
    });

    test("treats date and block filters additively", async () => {
      const storage = await withStorage();
      const samples = [
        { blockNumber: 1n, blockDate: "2024-01-01T00:00:00.000Z" },
        { blockNumber: 2n, blockDate: "2024-01-02T00:00:00.000Z" },
        { blockNumber: 3n, blockDate: "2024-01-03T00:00:00.000Z" },
        { blockNumber: 4n, blockDate: "2024-01-04T00:00:00.000Z" },
      ];
      for (const sample of samples) {
        await storage.saveBlockMetrics(blockMetricsFixture(sample));
      }

      const result = await storage.queryBlocks({
        blockGt: 1n,
        dateLt: "2024-01-04T00:00:00.000Z",
      });
      expect(result.map((row) => row.blockNumber)).toEqual([2, 3]);
    });

    test("returns empty array when no blocks match", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 1n }));

      expect(await storage.queryBlocks({ blockGt: 1000n })).toEqual([]);
    });
  });

  describe("ScannerStorage block ranges", () => {
    test("aggregateRangeIfComplete returns undefined for incomplete windows", async () => {
      const storage = await withStorage();
      for (let offset = 0n; offset < 50n; offset += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 245_600n + offset }));
      }
      expect(await storage.aggregateRangeIfComplete(245_600n, 100n)).toBeUndefined();
      expect(await storage.queryBlockRanges()).toEqual([]);
    });

    test("aggregateRangeIfComplete writes a row once all 100 blocks are stored", async () => {
      const storage = await withStorage();
      for (let offset = 0n; offset < RANGE_SIZE; offset += 1n) {
        await storage.saveBlockMetrics(
          blockMetricsFixture({
            blockNumber: 245_600n + offset,
            blockDate: new Date(Date.UTC(2024, 0, 1, 0, Number(offset))).toISOString(),
            baseBlockFeeWei: (100n + offset).toString(),
            totalGasUsed: "1000",
            maxGasInBlock: "30000000",
            transactionCount: 2,
            averagePriorityFeeWeightedWei: "7",
            averagePriorityFeeWei: "5",
          }),
        );
      }

      const result = await storage.aggregateRangeIfComplete(245_600n, 100n);
      expect(result).toBeDefined();
      expect(result?.rangeStart).toBe(245_600n);
      expect(result?.rangeEnd).toBe(245_699n);
      expect(result?.rangeSize).toBe(100n);

      const stored = await storage.queryBlockRanges();
      expect(stored.length).toBe(1);
      expect(stored[0]).toEqual({
        rangeSize: 100,
        rangeStart: 245_600,
        rangeEnd: 245_699,
        minBlockDate: "2024-01-01T00:00:00.000Z",
        maxBlockDate: "2024-01-01T01:39:00.000Z",
        minBaseFeeWei: "100",
        maxBaseFeeWei: "199",
        averageBaseFeeWei: "149",
        totalGasUsed: "100000",
        totalMaxGas: "3000000000",
        transactionCount: 200,
        averagePriorityFeeWeightedWei: "7",
        averagePriorityFeeWei: "5",
      });
    });

    test("queryBlockRanges filters by range start and dates", async () => {
      const storage = await withStorage();
      for (const rangeStart of [0n, 100n, 200n, 300n]) {
        await saveCompleteRange(storage, rangeStart, "2024-01-01T00:00:00.000Z");
      }

      const result = await storage.queryBlockRanges({ rangeStartGt: 0n, rangeStartLt: 300n });
      expect(result.map((row) => row.rangeStart)).toEqual([100, 200]);
    });

    test("queryBlockRanges caps results at MAX_RANGES_PER_QUERY", () => {
      expect(MAX_RANGES_PER_QUERY).toBe(10_000);
    });

    test("queryBlocks caps results at MAX_BLOCKS_PER_QUERY", () => {
      expect(MAX_BLOCKS_PER_QUERY).toBe(10_000);
    });

    test("aggregates and isolates rows for multiple range sizes", async () => {
      const storage = await withStorage();
      for (let blockNumber = 0n; blockNumber < 200n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      expect((await storage.aggregateRangeIfComplete(0n, 50n))?.rangeSize).toBe(50n);
      expect((await storage.aggregateRangeIfComplete(50n, 50n))?.rangeSize).toBe(50n);
      expect((await storage.aggregateRangeIfComplete(100n, 50n))?.rangeSize).toBe(50n);
      expect((await storage.aggregateRangeIfComplete(0n, 100n))?.rangeSize).toBe(100n);
      expect((await storage.aggregateRangeIfComplete(100n, 100n))?.rangeSize).toBe(100n);

      const fifties = await storage.queryBlockRanges({ rangeSize: 50n });
      expect(fifties.map((row) => row.rangeStart)).toEqual([0, 50, 100]);
      expect(fifties.every((row) => row.rangeSize === 50)).toBe(true);

      const hundreds = await storage.queryBlockRanges({ rangeSize: 100n });
      expect(hundreds.map((row) => row.rangeStart)).toEqual([0, 100]);
      expect(hundreds.every((row) => row.rangeSize === 100)).toBe(true);

      const twos = await storage.queryBlockRanges({ rangeSize: 2n });
      expect(twos).toEqual([]);
    });

    test("rejects unsupported range sizes in storage helpers", async () => {
      const storage = await withStorage();
      expect(storage.aggregateRangeIfComplete(0n, 7n)).rejects.toThrow();
      expect(storage.getBlocksForRange(0n, 7n)).rejects.toThrow();
    });

    test("getMinStoredBlock / getMaxStoredBlock reflect stored blocks", async () => {
      const storage = await withStorage();
      expect(await storage.getMinStoredBlock()).toBeUndefined();
      expect(await storage.getMaxStoredBlock()).toBeUndefined();
      for (const blockNumber of [5n, 10n, 7n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }
      expect(await storage.getMinStoredBlock()).toBe(5n);
      expect(await storage.getMaxStoredBlock()).toBe(10n);
    });
  });
}

async function saveCompleteRange(
  storage: ScannerStorage,
  rangeStart: bigint,
  blockDate: string,
  rangeSize: bigint = RANGE_SIZE,
): Promise<void> {
  for (let offset = 0n; offset < rangeSize; offset += 1n) {
    await storage.saveBlockMetrics(
      blockMetricsFixture({ blockNumber: rangeStart + offset, blockDate }),
    );
  }
  await storage.aggregateRangeIfComplete(rangeStart, rangeSize);
}

function blockMetricsFixture(overrides: Partial<BlockMetrics> = {}): BlockMetrics {
  return {
    blockDate: "2024-01-01T00:00:00.000Z",
    blockNumber: 1n,
    baseBlockFeeWei: "100",
    totalGasUsed: "21000",
    maxGasInBlock: "30000000",
    transactionCount: 1,
    averageTransactionFeeWei: "2310000",
    averagePriorityFeeWeightedWei: "10",
    averagePriorityFeeWei: "10",
    ...overrides,
  };
}
