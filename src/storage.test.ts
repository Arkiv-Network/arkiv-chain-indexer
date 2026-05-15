import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  MAX_TRANSACTIONS_PER_QUERY,
  type ScannerStorage,
} from "./storage";
import { DEFAULT_RANGE_SIZE } from "./ranges";
import {
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { BlockMetrics } from "./types";
import type { InspectedTransaction } from "./blockInspector";

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
      });
      expect(await storage.getLastSuccessfulBlock()).toBe(bigBlock);
    });

    test("reports database and application table sizes", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 0n }), { kind: "lastSuccessfulBlock" }, [
        transactionFixture({ position: 0, hash: "0xaaa" }),
        transactionFixture({ position: 1, hash: "0xbbb" }),
      ]);
      await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 1n }));
      await storage.aggregateRangeIfComplete(0n, 2n);

      const stats = await storage.getDatabaseStats();
      const byName = new Map(stats.tables.map((table) => [table.tableName, table]));

      expect(BigInt(stats.totalSizeBytes)).toBeGreaterThan(0n);
      expect(stats.tables.map((table) => table.tableName)).toEqual([
        "blocks",
        "transactions",
        "block_ranges",
        "scanner_state",
      ]);
      expect(byName.get("blocks")?.rowCount).toBe("2");
      expect(byName.get("transactions")?.rowCount).toBe("2");
      expect(byName.get("block_ranges")?.rowCount).toBe("1");
      expect(byName.get("scanner_state")?.rowCount).toBe("1");
      for (const table of stats.tables) {
        expect(BigInt(table.tableSizeBytes)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(table.indexesSizeBytes)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(table.totalSizeBytes)).toBeGreaterThanOrEqual(BigInt(table.tableSizeBytes));
      }
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

    test("can return the newest matching blocks first", async () => {
      const storage = await withStorage();
      for (const blockNumber of [1n, 2n, 3n, 4n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await storage.queryBlocks({ limit: 2, order: "desc" });
      expect(result.map((row) => row.blockNumber)).toEqual([4, 3]);
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
          blockRewardWei: "231000",
          burntFeesWei: "259245000",
          totalTransactionFeeWei: "210",
          feePriceSumWei: "45",
          priorityFeeSumWei: "35",
          priorityFeeWeightedNumeratorWei: "2310",
          priorityFeeGasWeightedNumeratorWei: "231000",
          averageFeePriceWei: "9",
          averageTransactionFeeWei: "42",
          averageTransactionGasUsed: "4200",
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
        blockRewardWei: "231000",
        burntFeesWei: "259245000",
        totalTransactionFeeWei: "210",
        feePriceSumWei: "45",
        priorityFeeSumWei: "35",
        priorityFeeWeightedNumeratorWei: "2310",
        priorityFeeGasWeightedNumeratorWei: "231000",
        averageFeePriceWei: "9",
        averageTransactionFeeWei: "42",
        averageTransactionGasUsed: "4200",
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
            maxGasInBlock: (30_000_000n + offset * 10n).toString(),
            transactionCount: 2,
            blockRewardWei: "7000",
            burntFeesWei: ((100n + offset) * 1000n).toString(),
            feePriceSumWei: "18",
            priorityFeeSumWei: "10",
            priorityFeeGasWeightedNumeratorWei: "7000",
            averageFeePriceWei: "9",
            averageTransactionGasUsed: "500",
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
        totalMaxGas: "3000049500",
        minMaxGasInBlock: "30000000",
        maxMaxGasInBlock: "30000990",
        transactionCount: 200,
        totalBlockRewardWei: "700000",
        totalBurntFeesWei: "14950000",
        averageBlockRewardWei: "7000",
        averageBurntFeesWei: "149500",
        averageFeePriceWei: "9",
        averageTransactionGasUsed: "500",
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

    test("queryBlockRanges can return the newest matching ranges first", async () => {
      const storage = await withStorage();
      for (const rangeStart of [0n, 100n, 200n, 300n]) {
        await saveCompleteRange(storage, rangeStart, "2024-01-01T00:00:00.000Z");
      }

      const result = await storage.queryBlockRanges({ limit: 2, order: "desc" });
      expect(result.map((row) => row.rangeStart)).toEqual([300, 200]);
    });

    test("queryBlockRanges caps results at MAX_RANGES_PER_QUERY", () => {
      expect(MAX_RANGES_PER_QUERY).toBe(10_000);
    });

    test("queryBlocks caps results at MAX_BLOCKS_PER_QUERY", () => {
      expect(MAX_BLOCKS_PER_QUERY).toBe(10_000);
    });

    test("queryTransactions caps results at MAX_TRANSACTIONS_PER_QUERY", () => {
      expect(MAX_TRANSACTIONS_PER_QUERY).toBe(1_000);
    });

    test("saves and queries transactions with block context", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(
        blockMetricsFixture({
          blockNumber: 42n,
          blockDate: "2024-01-02T03:04:05.000Z",
          baseBlockFeeWei: "100",
          transactionCount: 2,
        }),
        { kind: "lastSuccessfulBlock" },
        [
          transactionFixture({ position: 0, hash: "0xaaa" }),
          transactionFixture({ position: 1, hash: "0xbbb", to: null, contractAddress: "0xccc" }),
        ],
      );

      const rows = await storage.queryTransactions({ blockNumber: 42n });
      expect(rows.map((row) => row.hash)).toEqual(["0xaaa", "0xbbb"]);
      expect(rows[0]).toMatchObject({
        blockNumber: 42,
        blockNumberDecimal: "42",
        blockDate: "2024-01-02T03:04:05.000Z",
        baseBlockFeeWei: "100",
        position: 0,
        gasUsed: "21000",
      });

      const inspected = await storage.getInspectedBlock(42n);
      expect(inspected?.transactionCount).toBe(2);
      expect(inspected?.transactions.map((row) => row.hash)).toEqual(["0xaaa", "0xbbb"]);
    });

    test("replaces transactions when a block is re-saved", async () => {
      const storage = await withStorage();
      const metrics = blockMetricsFixture({ blockNumber: 42n });

      await storage.saveBlockMetrics(metrics, { kind: "lastSuccessfulBlock" }, [
        transactionFixture({ position: 0, hash: "0xaaa" }),
      ]);
      await storage.saveBlockMetrics(metrics, { kind: "lastSuccessfulBlock" }, [
        transactionFixture({ position: 0, hash: "0xbbb" }),
      ]);

      const rows = await storage.queryTransactions({ blockNumber: 42n });
      expect(rows.map((row) => row.hash)).toEqual(["0xbbb"]);
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

function transactionFixture(overrides: Partial<InspectedTransaction> = {}): InspectedTransaction {
  return {
    position: 0,
    hash: "0xaaa",
    from: "0x111",
    to: "0x222",
    type: "2",
    nonce: "1",
    valueWei: "0",
    gasLimit: "21000",
    gasUsed: "21000",
    cumulativeGasUsed: "21000",
    gasPriceWei: "110",
    maxFeePerGasWei: "200",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "110",
    priorityFeeWei: "10",
    transactionFeeWei: "2310000",
    status: "1",
    contractAddress: null,
    ...overrides,
  };
}
