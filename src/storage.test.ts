import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { openDb } from "./db";
import {
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  MAX_SENDERS_PER_QUERY,
  MAX_TRANSACTIONS_PER_QUERY,
  type ScannerStorage,
} from "./storage";
import { DEFAULT_RANGE_SIZE } from "./ranges";
import {
  TEST_DATABASE_URL,
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { ArkivOperation, TransactionArkivOperations } from "./arkivOperations";
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
  describe.skip("ScannerStorage (skipped: set TEST_DATABASE_URL to run)", () => {});
} else {
  describe("ScannerStorage", () => {
    test("saves block metrics and resumes from the last successful block", async () => {
      const storage = await withStorage();

      expect(await storage.getLastSuccessfulBlock()).toBeUndefined();

      await storage.saveBlockMetrics({
        blockDate: "2024-01-01T00:00:00.000Z",
        blockNumber: 42n,
        blockTimeSeconds: "2",
        baseBlockFeeWei: "100",
        totalGasUsed: "21000",
        totalInputDataSizeBytes: "0",
        totalInputDataCompressedSizeBytes: "0",
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
        averageTransactionInputDataSizeBytes: "0",
        averageTransactionInputDataCompressedSizeBytes: "0",
        averagePriorityFeeWeightedWei: "10",
        averagePriorityFeeWei: "10",
      });

      expect(await storage.getLastSuccessfulBlock()).toBe(42n);
    });

    test("returns tip blocks ascending for sync-rate sampling", async () => {
      const storage = await withStorage();

      for (const blockNumber of [10n, 11n, 12n]) {
        await storage.saveBlockMetrics(
          blockMetricsFixture({
            blockNumber,
            blockDate: new Date(Number(blockNumber) * 2000).toISOString(),
          }),
        );
      }

      const samples = await storage.getForwardScanSamples(2);
      expect(samples.map((sample) => sample.blockNumber)).toEqual([11n, 12n]);
      expect(samples[1]?.blockDate).toBe(new Date(24_000).toISOString());
      expect(samples[1]?.scannedAtUtc).toMatch(/Z$/);
    });

    test("saves backfill cursor separately from forward progress", async () => {
      const storage = await withStorage();

      await storage.saveBlockMetrics(
        {
          blockDate: "2024-01-01T00:00:00.000Z",
          blockNumber: 50n,
          blockTimeSeconds: "2",
          baseBlockFeeWei: "100",
          totalGasUsed: "21000",
          totalInputDataSizeBytes: "0",
          totalInputDataCompressedSizeBytes: "0",
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
          averageTransactionInputDataSizeBytes: "0",
          averageTransactionInputDataCompressedSizeBytes: "0",
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
        blockTimeSeconds: "2",
        baseBlockFeeWei: "100",
        totalGasUsed: "21000",
        totalInputDataSizeBytes: "0",
        totalInputDataCompressedSizeBytes: "0",
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
        averageTransactionInputDataSizeBytes: "0",
        averageTransactionInputDataCompressedSizeBytes: "0",
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
        "transaction_operations",
        "transaction_records",
        "block_ranges",
        "sender_stats",
        "scanner_state",
        "baseload_configs",
      ]);
      expect(byName.get("blocks")?.rowCount).toBe("2");
      expect(byName.get("transactions")?.rowCount).toBe("2");
      expect(byName.get("transaction_operations")?.rowCount).toBe("0");
      expect(byName.get("transaction_records")?.rowCount).toBe("6");
      expect(byName.get("block_ranges")?.rowCount).toBe("1");
      expect(byName.get("sender_stats")?.rowCount).toBe("0");
      expect(byName.get("scanner_state")?.rowCount).toBe("1");
      expect(byName.get("baseload_configs")?.rowCount).toBe("0");
      for (const table of stats.tables) {
        expect(BigInt(table.tableSizeBytes)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(table.indexesSizeBytes)).toBeGreaterThanOrEqual(0n);
        expect(BigInt(table.totalSizeBytes)).toBeGreaterThanOrEqual(BigInt(table.tableSizeBytes));
      }

      // Fresh tables are counted exactly (reltuples is -1 until the first
      // ANALYZE); afterwards the count comes from the planner statistics.
      const internals = storage as unknown as {
        db: { query(sql: string): Promise<unknown> };
        qBlocks: string;
      };
      await internals.db.query(`ANALYZE ${internals.qBlocks}`);
      const analyzed = await storage.getDatabaseStats();
      const analyzedBlocks = analyzed.tables.find((table) => table.tableName === "blocks");
      expect(analyzedBlocks?.rowCount).toBe("2");
    });

    test("persists named baseload configs as JSON documents", async () => {
      const storage = await withStorage();

      const saved = await storage.saveBaseloadConfig("low gas", {
        version: 2,
        workers: [
          {
            id: "wallet-0",
            behavior: "create",
            maxGasPriceGwei: 0.1,
            opsPerMinute: 1,
            entitiesPerRequest: 1,
            singleCreatePayloadSize: 5000,
            singleCreateStringArgumentCount: 2,
            singleCreateNumberArgumentCount: 2,
            entityPoolSize: 10,
            timeBombOffsetSeconds: 600,
            walletNumber: 0,
            walletAddress: "0x0000000000000000000000000000000000000000",
            startBlock: 0,
            endBlock: null,
            durationSeconds: null,
            ttlSeconds: 3600,
          },
        ],
      });

      expect(saved.name).toBe("low gas");
      expect(saved.workerCount).toBe(1);
      expect(saved.createdAt).toMatch(/Z$/);
      expect(saved.updatedAt).toMatch(/Z$/);

      await storage.saveBaseloadConfig("empty", { version: 2, workers: [] });
      expect((await storage.listBaseloadConfigs()).map((config) => config.name)).toEqual([
        "empty",
        "low gas",
      ]);
      expect((await storage.getBaseloadConfig("low gas"))?.config.workers[0]?.walletNumber).toBe(0);
      expect(await storage.deleteBaseloadConfig("low gas")).toBe(true);
      expect(await storage.getBaseloadConfig("low gas")).toBeUndefined();
    });
  });

  describe("ScannerStorage.queryBlocks", () => {
    test("returns newest blocks first by default", async () => {
      const storage = await withStorage();
      for (const blockNumber of [3n, 1n, 2n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await storage.queryBlocks();
      expect(result.map((row) => row.blockNumber)).toEqual([3, 2, 1]);
    });

    test("can return the oldest matching blocks first", async () => {
      const storage = await withStorage();
      for (const blockNumber of [1n, 2n, 3n, 4n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await storage.queryBlocks({ limit: 2, order: "asc" });
      expect(result.map((row) => row.blockNumber)).toEqual([1, 2]);
    });

    test("returns all stored fields in camelCase", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(
        blockMetricsFixture({
          blockNumber: 7n,
          blockDate: "2024-02-01T00:00:00.000Z",
          baseBlockFeeWei: "12345",
          totalGasUsed: "21000",
          totalInputDataSizeBytes: "512",
          totalInputDataCompressedSizeBytes: "73",
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
          averageTransactionInputDataSizeBytes: "102",
          averageTransactionInputDataCompressedSizeBytes: "15",
          averagePriorityFeeWeightedWei: "11",
          averagePriorityFeeWei: "7",
          batcherQueueSize: "906",
          batcherIntensity: "0",
          batcherLowerThreshold: "10000000",
          batcherUpperThreshold: "50000000",
          batcherMaxBlockSize: "10000000",
          batcherMaxTxSize: "0",
        }),
      );

      const [row] = await storage.queryBlocks();
      expect(row).toEqual({
        blockNumber: 7,
        blockDate: "2024-02-01T00:00:00.000Z",
        blockTimeSeconds: "2",
        baseBlockFeeWei: "12345",
        totalGasUsed: "21000",
        totalInputDataSizeBytes: "512",
        totalInputDataCompressedSizeBytes: "73",
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
        averageTransactionInputDataSizeBytes: "102",
        averageTransactionInputDataCompressedSizeBytes: "15",
        averagePriorityFeeWeightedWei: "11",
        averagePriorityFeeWei: "7",
        batcherQueueSize: "906",
        batcherIntensity: "0",
        batcherLowerThreshold: "10000000",
        batcherUpperThreshold: "50000000",
        batcherMaxBlockSize: "10000000",
        batcherMaxTxSize: "0",
      });
    });

    test("filters by blockGt and blockLt exclusively and combines them additively", async () => {
      const storage = await withStorage();
      for (let blockNumber = 10n; blockNumber <= 20n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const result = await storage.queryBlocks({ blockGt: 12n, blockLt: 16n });
      expect(result.map((row) => row.blockNumber)).toEqual([15, 14, 13]);
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
      expect(result.map((row) => row.blockNumber)).toEqual([3, 2]);
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
      expect(result.map((row) => row.blockNumber)).toEqual([3, 2]);
    });

    test("returns empty array when no blocks match", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 1n }));

      expect(await storage.queryBlocks({ blockGt: 1000n })).toEqual([]);
    });
  });

  describe("ScannerStorage.findBlockGaps", () => {
    test("reports internal holes between stored blocks", async () => {
      const storage = await withStorage();
      for (const blockNumber of [1n, 2n, 5n, 6n, 10n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const gaps = await storage.findBlockGaps();
      expect(gaps).toEqual([
        { gapStart: 3n, gapEnd: 4n, missingCount: 2n },
        { gapStart: 7n, gapEnd: 9n, missingCount: 3n },
      ]);
    });

    test("returns no gaps for a contiguous run", async () => {
      const storage = await withStorage();
      for (let blockNumber = 100n; blockNumber <= 105n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      expect(await storage.findBlockGaps()).toEqual([]);
    });

    test("never reports holes below the minimum or above the maximum stored block", async () => {
      const storage = await withStorage();
      for (const blockNumber of [10n, 11n, 15n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const gaps = await storage.findBlockGaps();
      // Only the internal 12..14 hole — nothing below 10 or above 15.
      expect(gaps).toEqual([{ gapStart: 12n, gapEnd: 14n, missingCount: 3n }]);
    });

    test("caps the number of gap ranges returned", async () => {
      const storage = await withStorage();
      // Blocks 0,2,4,6 -> three single-block gaps at 1, 3, 5.
      for (const blockNumber of [0n, 2n, 4n, 6n]) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      const gaps = await storage.findBlockGaps(2);
      expect(gaps).toEqual([
        { gapStart: 1n, gapEnd: 1n, missingCount: 1n },
        { gapStart: 3n, gapEnd: 3n, missingCount: 1n },
      ]);
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
            batcherQueueSize: (900n + offset).toString(),
            batcherIntensity: "0",
            batcherLowerThreshold: "10000000",
            batcherUpperThreshold: "50000000",
            batcherMaxBlockSize: "10000000",
            batcherMaxTxSize: "0",
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
        averageBlockTimeSeconds: "2",
        minBlockTimeSeconds: "2",
        maxBlockTimeSeconds: "2",
        minBaseFeeWei: "100",
        maxBaseFeeWei: "199",
        averageBaseFeeWei: "149",
        totalGasUsed: "100000",
        averageTotalGasUsed: "1000",
        minTotalGasUsed: "1000",
        maxTotalGasUsed: "1000",
        totalInputDataSizeBytes: "0",
        averageTotalInputDataSizeBytes: "0",
        minTotalInputDataSizeBytes: "0",
        maxTotalInputDataSizeBytes: "0",
        totalInputDataCompressedSizeBytes: "0",
        averageTotalInputDataCompressedSizeBytes: "0",
        minTotalInputDataCompressedSizeBytes: "0",
        maxTotalInputDataCompressedSizeBytes: "0",
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
        averageTransactionInputDataSizeBytes: "0",
        averageTransactionInputDataCompressedSizeBytes: "0",
        averagePriorityFeeWeightedWei: "7",
        averagePriorityFeeWei: "5",
        minBatcherQueueSize: "900",
        maxBatcherQueueSize: "999",
        averageBatcherQueueSize: "949",
        averageBatcherIntensity: "0",
        averageBatcherLowerThreshold: "10000000",
        averageBatcherUpperThreshold: "50000000",
        averageBatcherMaxBlockSize: "10000000",
        averageBatcherMaxTxSize: "0",
      });
    });

    test("queryBlockRanges filters by range start and dates", async () => {
      const storage = await withStorage();
      for (const rangeStart of [0n, 100n, 200n, 300n]) {
        await saveCompleteRange(storage, rangeStart, "2024-01-01T00:00:00.000Z");
      }

      const result = await storage.queryBlockRanges({ rangeStartGt: 0n, rangeStartLt: 300n });
      expect(result.map((row) => row.rangeStart)).toEqual([200, 100]);
    });

    test("queryBlockRanges can return the oldest matching ranges first", async () => {
      const storage = await withStorage();
      for (const rangeStart of [0n, 100n, 200n, 300n]) {
        await saveCompleteRange(storage, rangeStart, "2024-01-01T00:00:00.000Z");
      }

      const result = await storage.queryBlockRanges({ limit: 2, order: "asc" });
      expect(result.map((row) => row.rangeStart)).toEqual([0, 100]);
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

    test("querySenderStats caps results at MAX_SENDERS_PER_QUERY", () => {
      expect(MAX_SENDERS_PER_QUERY).toBe(10_000);
    });

    test("aggregates sender stats from stored transactions", async () => {
      const storage = await withStorage();
      const activeAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const quietAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

      await storage.saveBlockMetrics(
        blockMetricsFixture({
          blockNumber: 100n,
          blockDate: "2024-01-01T00:00:00.000Z",
          transactionCount: 2,
        }),
        { kind: "lastSuccessfulBlock" },
        [
          transactionFixture({
            position: 0,
            hash: "0xaaa",
            from: activeAddress.toUpperCase() as `0x${string}`,
            nonce: "7",
            valueWei: "1000",
            gasUsed: "21000",
            transactionFeeWei: "2310000",
          }),
          transactionFixture({
            position: 1,
            hash: "0xbbb",
            from: quietAddress,
            nonce: "1",
            valueWei: "3000",
            gasUsed: "50000",
            transactionFeeWei: "6000000",
          }),
        ],
      );
      await storage.saveBlockMetrics(
        blockMetricsFixture({
          blockNumber: 101n,
          blockDate: "2024-01-02T00:00:00.000Z",
          transactionCount: 2,
        }),
        { kind: "lastSuccessfulBlock" },
        [
          transactionFixture({
            position: 0,
            hash: "0xccc",
            from: activeAddress,
            nonce: "8",
            valueWei: "2000",
            gasUsed: "42000",
            transactionFeeWei: "4620000",
          }),
          transactionFixture({
            position: 1,
            hash: "0xddd",
            from: null,
          }),
        ],
      );

      expect(await storage.aggregateSenderStats()).toBe(2);

      const rows = await storage.querySenderStats();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        address: activeAddress,
        latestNonce: "8",
        transactionCount: "2",
        totalGasUsed: "63000",
        totalTransactionFeeWei: "6930000",
        totalValueWei: "3000",
        averageGasUsed: "31500",
        averageTransactionFeeWei: "3465000",
        firstBlockNumber: 100,
        firstBlockNumberDecimal: "100",
        lastBlockNumber: 101,
        lastBlockNumberDecimal: "101",
        firstBlockDate: "2024-01-01T00:00:00.000Z",
        lastBlockDate: "2024-01-02T00:00:00.000Z",
      });
      expect(rows[0]?.aggregatedAt).toMatch(/Z$/);
      expect(rows[1]?.address).toBe(quietAddress);

      const ascending = await storage.querySenderStats({ order: "asc", limit: 1 });
      expect(ascending.map((row) => row.address)).toEqual([quietAddress]);
    });

    test("orders senders numerically by transaction_count across digit boundaries", async () => {
      const storage = await withStorage();
      const highAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
      const lowAddress = "0xdddddddddddddddddddddddddddddddddddddddd";

      const makeTransactions = (from: string, count: number, prefix: string) =>
        Array.from({ length: count }, (_unused, index) =>
          transactionFixture({
            position: index,
            hash: `${prefix}${index}` as `0x${string}`,
            from: from as `0x${string}`,
            nonce: index.toString(),
          }),
        );

      // 10 transactions for the high sender, 9 for the low sender. Lexicographically "9" > "10",
      // so a string sort would rank the low sender first; numerically 10 > 9 must win.
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 200n, transactionCount: 10 }),
        { kind: "lastSuccessfulBlock" },
        makeTransactions(highAddress, 10, "0xhigh"),
      );
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 201n, transactionCount: 9 }),
        { kind: "lastSuccessfulBlock" },
        makeTransactions(lowAddress, 9, "0xlow"),
      );

      expect(await storage.aggregateSenderStats()).toBe(2);

      const descending = await storage.querySenderStats();
      expect(descending.map((row) => row.address)).toEqual([highAddress, lowAddress]);
      expect(descending.map((row) => row.transactionCount)).toEqual(["10", "9"]);

      const ascending = await storage.querySenderStats({ order: "asc" });
      expect(ascending.map((row) => row.address)).toEqual([lowAddress, highAddress]);
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

      const rows = await storage.queryTransactions({ blockNumber: 42n, order: "asc" });
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

    test("queryTransactions returns newest matching transactions first by default", async () => {
      const storage = await withStorage();
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 100n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xaaa" })],
      );
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 101n, transactionCount: 2 }),
        { kind: "lastSuccessfulBlock" },
        [
          transactionFixture({ position: 0, hash: "0xbbb" }),
          transactionFixture({ position: 1, hash: "0xccc" }),
        ],
      );

      const rows = await storage.queryTransactions({ limit: 2 });
      expect(rows.map((row) => row.hash)).toEqual(["0xccc", "0xbbb"]);
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

      const rows = await storage.queryTransactions({ blockNumber: 42n, order: "asc" });
      expect(rows.map((row) => row.hash)).toEqual(["0xbbb"]);

      const records = await storage.queryTransactionRecords({ limit: 20 });
      expect(records.gas_used.map((row) => row.hash)).toEqual(["0xbbb"]);
    });

    test("stores record transactions even when full transaction rows are disabled", async () => {
      const storage = await withStorage();
      const transaction = transactionFixture({
        position: 0,
        hash: "0xrecord",
        gasUsed: "42000",
        effectiveGasPriceWei: "300",
        transactionFeeWei: "12600000",
      });

      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 42n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        undefined,
        [transaction],
      );

      expect(await storage.countTransactions({ blockNumber: 42n })).toBe(0);

      const records = await storage.queryTransactionRecords({ limit: 20 });
      expect(records.gas_used[0]).toMatchObject({
        category: "gas_used",
        recordValue: "42000",
        hash: "0xrecord",
      });
      expect(records.transaction_fee[0]).toMatchObject({
        category: "transaction_fee",
        recordValue: "12600000",
        hash: "0xrecord",
      });
      expect(records.effective_fee[0]).toMatchObject({
        category: "effective_fee",
        recordValue: "300",
        hash: "0xrecord",
      });
    });

    test("keeps only the top 100 records per category", async () => {
      const storage = await withStorage();

      for (let index = 0; index < 105; index += 1) {
        await storage.saveBlockMetrics(
          blockMetricsFixture({ blockNumber: BigInt(index), transactionCount: 1 }),
          { kind: "lastSuccessfulBlock" },
          undefined,
          [
            transactionFixture({
              position: 0,
              hash: `0x${index.toString(16)}`,
              gasUsed: String(index),
              effectiveGasPriceWei: String(index * 2),
              transactionFeeWei: String(index * 3),
            }),
          ],
        );
      }

      const records = await storage.queryTransactionRecords({ limit: 100 });
      expect(records.gas_used).toHaveLength(100);
      expect(records.gas_used[0]?.recordValue).toBe("104");
      expect(records.gas_used.at(-1)?.recordValue).toBe("5");
      expect(records.transaction_fee).toHaveLength(100);
      expect(records.transaction_fee[0]?.recordValue).toBe("312");
      expect(records.effective_fee).toHaveLength(100);
      expect(records.effective_fee[0]?.recordValue).toBe("208");
    });

    test("queries outgoing address transactions by nonce with pagination", async () => {
      const storage = await withStorage();
      const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 100n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xaaa", from: address, nonce: "10" })],
      );
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 101n, transactionCount: 2 }),
        { kind: "lastSuccessfulBlock" },
        [
          transactionFixture({ position: 0, hash: "0xbbb", from: address, nonce: "2" }),
          transactionFixture({
            position: 1,
            hash: "0xccc",
            from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            nonce: "1",
          }),
        ],
      );
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 102n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xddd", from: address, nonce: "3" })],
      );

      const rows = await storage.queryTransactions({
        fromAddress: address.toUpperCase(),
        limit: 10,
        order: "asc",
      });
      expect(rows.map((row) => row.nonce)).toEqual(["2", "3", "10"]);

      const filteredCount = await storage.countTransactions({
        fromAddress: address,
        nonceGt: 2n,
        nonceLt: 11n,
      });
      expect(filteredCount).toBe(2);

      const secondPage = await storage.queryTransactions({
        fromAddress: address,
        limit: 1,
        page: 2,
        order: "asc",
      });
      expect(secondPage.map((row) => row.hash)).toEqual(["0xddd"]);

      const newestOutgoing = await storage.queryTransactions({
        fromAddress: address,
        limit: 2,
        order: "desc",
      });
      expect(newestOutgoing.map((row) => row.nonce)).toEqual(["10", "3"]);
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
      expect(fifties.map((row) => row.rangeStart)).toEqual([100, 50, 0]);
      expect(fifties.every((row) => row.rangeSize === 50)).toBe(true);

      const hundreds = await storage.queryBlockRanges({ rangeSize: 100n });
      expect(hundreds.map((row) => row.rangeStart)).toEqual([100, 0]);
      expect(hundreds.every((row) => row.rangeSize === 100)).toBe(true);

      const twos = await storage.queryBlockRanges({ rangeSize: 2n });
      expect(twos).toEqual([]);
    });

    test("tracks completed range starts independently for each range size", async () => {
      const storage = await withStorage();
      for (let blockNumber = 0n; blockNumber < 200n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }

      await storage.aggregateRangeIfComplete(0n, 50n);
      await storage.aggregateRangeIfComplete(50n, 50n);
      await storage.aggregateRangeIfComplete(150n, 50n);
      await storage.aggregateRangeIfComplete(0n, 100n);

      expect(await storage.getLatestCompleteRangeStart(50n)).toBe(150n);
      expect(await storage.getLatestCompleteRangeStart(50n, 0n)).toBe(50n);
      expect(await storage.getLatestCompleteRangeStart(50n, 100n)).toBeUndefined();
      expect(await storage.getLatestCompleteRangeStart(50n, 150n)).toBe(150n);
      expect(await storage.getLatestCompleteRangeStart(100n)).toBe(0n);
      expect(await storage.getLatestCompleteRangeStart(2n)).toBeUndefined();
      expect(await storage.isBlockRangeComplete(50n, 50n)).toBe(true);
      expect(await storage.isBlockRangeComplete(100n, 50n)).toBe(false);
      expect(await storage.isBlockRangeComplete(150n, 50n)).toBe(true);
      expect(await storage.isBlockRangeComplete(0n, 100n)).toBe(true);
    });

    test("rejects unsupported range sizes in storage helpers", async () => {
      const storage = await withStorage();
      expect(storage.aggregateRangeIfComplete(0n, 7n)).rejects.toThrow();
      expect(storage.getBlocksForRange(0n, 7n)).rejects.toThrow();
      expect(storage.getLatestCompleteRangeStart(7n)).rejects.toThrow();
      expect(storage.isBlockRangeComplete(0n, 7n)).rejects.toThrow();
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

  describe("ScannerStorage transaction operations", () => {
    test("saves operation metadata with a block and reads it back by hash", async () => {
      const storage = await withStorage();
      const operations = arkivOperationsFixture("0xfeed", 0);

      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 42n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xfeed" })],
        undefined,
        operations,
      );

      const stored = await storage.getOperationsByHash("0xFEED");
      expect(stored).toEqual(operations[0]!.operations);
      // Attributes roundtrip through jsonb; uint32-max expiry survives BIGINT.
      expect(stored[0]?.attributes).toEqual([
        { key: "project", valueType: 2, valueTypeName: "string", value: "demo" },
        { key: "version", valueType: 1, valueTypeName: "uint", value: "7" },
      ]);
      expect(stored[0]?.expiresAtBlocks).toBe(4_294_967_295);
      // Reference receipt + verdict round-trip through jsonb; the inline op
      // reads back with the reference columns null/false.
      expect(stored[0]?.isReference).toBe(true);
      expect(stored[0]?.payloadReference?.provider).toBe("atlas-payload-provider");
      expect(stored[0]?.referenceVerification).toMatchObject({ valid: true, signerTrusted: true });
      expect(stored[1]).toMatchObject({
        isReference: false,
        payloadReference: null,
        referenceVerification: null,
        referenceError: null,
      });
      expect(await storage.getOperationsByHash("0xother")).toEqual([]);
    });

    test("reads an entity's operation history across blocks in chain order", async () => {
      const storage = await withStorage();
      const entityKey = `0x${"ab".repeat(32)}`;
      // Block 10 holds the create (fixture op 0 uses this entity key, op 1 a
      // different one); block 11 holds a delete of the same entity.
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 10n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xfeed" })],
        undefined,
        arkivOperationsFixture("0xfeed", 0),
      );
      const deleteOperations: TransactionArkivOperations[] = [
        {
          position: 0,
          hash: "0xdead" as `0x${string}`,
          operations: [
            {
              opIndex: 0,
              operationType: 5,
              operation: "delete",
              entityKey,
              contentType: null,
              payloadSizeBytes: 0,
              attributes: [],
              expiresAtBlocks: 0,
              newOwner: null,
              isReference: false,
              payloadReference: null,
              referenceVerification: null,
              referenceError: null,
            },
          ],
        },
      ];
      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 11n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xdead" })],
        undefined,
        deleteOperations,
      );

      // Uppercase input is normalized; history spans blocks in chain order and
      // carries each operation's transaction context.
      const history = await storage.getEntityOperationHistory(`0x${"AB".repeat(32)}`);
      expect(history.totalOperations).toBe(2);
      expect(history.firstOperation).toBeNull();
      expect(history.operations).toHaveLength(2);
      expect(history.operations[0]).toMatchObject({
        blockNumber: 10,
        blockNumberDecimal: "10",
        position: 0,
        hash: "0xfeed",
        operation: "create",
        entityKey,
      });
      expect(history.operations[1]).toMatchObject({
        blockNumber: 11,
        blockNumberDecimal: "11",
        hash: "0xdead",
        operation: "delete",
        entityKey,
      });
      expect(typeof history.operations[0]?.blockDate).toBe("string");

      expect(await storage.getEntityOperationHistory(`0x${"99".repeat(32)}`)).toEqual({
        operations: [],
        totalOperations: 0,
        firstOperation: null,
      });
    });

    test("truncates entity history to the newest operations and keeps the create reachable", async () => {
      const storage = await withStorage();
      const entityKey = `0x${"77".repeat(32)}`;
      const operationFor = (blockNumber: bigint, operation: string, operationType: number) => ({
        position: 0,
        hash: `0x${blockNumber.toString(16).padStart(4, "0")}` as `0x${string}`,
        operations: [
          {
            opIndex: 0,
            operationType,
            operation,
            entityKey,
            contentType: operation === "create" ? "text/plain" : null,
            payloadSizeBytes: 0,
            attributes: [],
            expiresAtBlocks: 0,
            newOwner: null,
            isReference: false,
            payloadReference: null,
            referenceVerification: null,
            referenceError: null,
          },
        ],
      });
      const blocks: Array<[bigint, string, number]> = [
        [20n, "create", 1],
        [21n, "update", 2],
        [22n, "update", 2],
        [23n, "delete", 5],
      ];
      for (const [blockNumber, operation, operationType] of blocks) {
        await storage.saveBlockMetrics(
          blockMetricsFixture({ blockNumber, transactionCount: 1 }),
          { kind: "lastSuccessfulBlock" },
          [transactionFixture({ position: 0, hash: `0x${blockNumber.toString(16).padStart(4, "0")}` })],
          undefined,
          [operationFor(blockNumber, operation, operationType)],
        );
      }

      const history = await storage.getEntityOperationHistory(entityKey, 2);
      expect(history.totalOperations).toBe(4);
      // The slice holds the newest two operations in chain order…
      expect(history.operations.map((operation) => operation.operation)).toEqual([
        "update",
        "delete",
      ]);
      expect(history.operations.map((operation) => operation.blockNumber)).toEqual([22, 23]);
      // …and the earliest stored operation (the create) rides along separately.
      expect(history.firstOperation).toMatchObject({
        operation: "create",
        blockNumber: 20,
        entityKey,
      });

      // A limit covering everything returns no separate first operation.
      const full = await storage.getEntityOperationHistory(entityKey, 10);
      expect(full.totalOperations).toBe(4);
      expect(full.operations).toHaveLength(4);
      expect(full.firstOperation).toBeNull();
    });

    test("notifies the schema-scoped channel with changed entity keys on commit", async () => {
      const storage = await withStorage();
      const entityKey = `0x${"5a".repeat(32)}`;
      const received: string[] = [];
      const stop = await storage.listenForEntityOperationChanges((key) => {
        received.push(key);
      });

      try {
        await storage.saveBlockMetrics(
          blockMetricsFixture({ blockNumber: 30n, transactionCount: 1 }),
          { kind: "lastSuccessfulBlock" },
          [transactionFixture({ position: 0, hash: "0xfeed" })],
          undefined,
          [
            {
              position: 0,
              hash: "0xfeed" as `0x${string}`,
              operations: [
                {
                  opIndex: 0,
                  operationType: 1,
                  operation: "create",
                  entityKey,
                  contentType: "text/plain",
                  payloadSizeBytes: 3,
                  attributes: [],
                  expiresAtBlocks: 0,
                  newOwner: null,
                  isReference: false,
                  payloadReference: null,
                  referenceVerification: null,
                  referenceError: null,
                },
              ],
            },
          ],
        );

        const deadline = Date.now() + 5_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(received).toEqual([entityKey]);

        // Re-scanning the block (replacing its rows) notifies again, covering
        // keys from the deleted rows as well as the inserted ones.
        received.length = 0;
        await storage.saveBlockMetrics(
          blockMetricsFixture({ blockNumber: 30n, transactionCount: 1 }),
          { kind: "lastSuccessfulBlock" },
          [transactionFixture({ position: 0, hash: "0xfeed" })],
          undefined,
          [],
        );
        const replaceDeadline = Date.now() + 5_000;
        while (received.length === 0 && Date.now() < replaceDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(received).toEqual([entityKey]);
      } finally {
        await stop();
      }
    });

    test("notifies stored-block listeners with the block number on commit", async () => {
      const storage = await withStorage();
      const received: string[] = [];
      const stop = await storage.listenForStoredBlocks((blockNumber) => {
        received.push(blockNumber);
      });

      try {
        // Metrics-only writes (no transaction payload) notify too — every
        // committed block invalidates cached block lists and sync status.
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 40n }));

        const deadline = Date.now() + 5_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(received).toEqual(["40"]);
      } finally {
        await stop();
      }
    });

    test("aggregates operation summaries per transaction ordered by operation type", async () => {
      const storage = await withStorage();
      const deleteOperation: ArkivOperation = {
        opIndex: 2,
        operationType: 5,
        operation: "delete",
        entityKey: `0x${"cd".repeat(32)}`,
        contentType: null,
        payloadSizeBytes: 0,
        attributes: [],
        expiresAtBlocks: 0,
        newOwner: null,
        isReference: false,
        payloadReference: null,
        referenceVerification: null,
        referenceError: null,
      };
      const operations: TransactionArkivOperations[] = [
        {
          position: 0,
          hash: "0xaaa",
          operations: [
            { ...deleteOperation, opIndex: 0 },
            ...arkivOperationsFixture("0xaaa", 0)[0]!.operations.map((operation, index) => ({
              ...operation,
              opIndex: index + 1,
            })),
          ],
        },
      ];

      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 100n, transactionCount: 2 }),
        { kind: "lastSuccessfulBlock" },
        [
          transactionFixture({ position: 0, hash: "0xaaa" }),
          transactionFixture({ position: 1, hash: "0xbbb" }),
        ],
        undefined,
        operations,
      );

      const summaries = await storage.getOperationsSummaryForTransactions([
        { blockNumber: "100", position: 0 },
        { blockNumber: "100", position: 1 },
      ]);
      expect(summaries.get("100:0")).toEqual([
        { operation: "create", operationType: 1, count: 1 },
        { operation: "transfer", operationType: 4, count: 1 },
        { operation: "delete", operationType: 5, count: 1 },
      ]);
      expect(summaries.has("100:1")).toBe(false);

      expect(await storage.getOperationsSummaryForTransactions([])).toEqual(new Map());
    });

    test("clears stored operations when a block is re-saved without them", async () => {
      const storage = await withStorage();
      const metrics = blockMetricsFixture({ blockNumber: 42n, transactionCount: 1 });
      const transactions = [transactionFixture({ position: 0, hash: "0xfeed" })];

      await storage.saveBlockMetrics(
        metrics,
        { kind: "lastSuccessfulBlock" },
        transactions,
        undefined,
        arkivOperationsFixture("0xfeed", 0),
      );
      expect(await storage.getOperationsByHash("0xfeed")).toHaveLength(2);

      await storage.saveBlockMetrics(metrics, { kind: "lastSuccessfulBlock" }, transactions);
      expect(await storage.getOperationsByHash("0xfeed")).toEqual([]);
    });

    test("chunks operation inserts past the bind-parameter limit", async () => {
      const storage = await withStorage();
      // 5,050 rows × 17 columns would exceed Postgres's 65,535 bind-parameter
      // cap in a single INSERT; the writer must split into chunked statements.
      const operationCount = 5_050;
      const baseOperation = arkivOperationsFixture("0xfeed", 0)[0]!.operations[1]!;
      const operations: TransactionArkivOperations[] = [
        {
          position: 0,
          hash: "0xfeed",
          operations: Array.from({ length: operationCount }, (_unused, index) => ({
            ...baseOperation,
            opIndex: index,
          })),
        },
      ];

      await storage.saveBlockMetrics(
        blockMetricsFixture({ blockNumber: 7n, transactionCount: 1 }),
        { kind: "lastSuccessfulBlock" },
        [transactionFixture({ position: 0, hash: "0xfeed" })],
        undefined,
        operations,
      );

      expect(await storage.getOperationsByHash("0xfeed")).toHaveLength(operationCount);
    });

    test("transaction_operations stores only the payload size, never payload bytes", async () => {
      await withStorage();
      const db = openDb(TEST_DATABASE_URL!, { max: 1 });
      try {
        const result = await db.query<{ column_name: string }>(
          `SELECT DISTINCT column_name
           FROM information_schema.columns
           WHERE table_name = 'transaction_operations'`,
        );
        expect(result.rows.map((row) => row.column_name).sort()).toEqual([
          "attributes",
          "block_date",
          "block_number",
          "content_type",
          "entity_key",
          "expires_at_blocks",
          "hash",
          "is_reference",
          "new_owner",
          "op_index",
          "operation",
          "operation_type",
          "payload_reference",
          "payload_size_bytes",
          "position",
          "reference_error",
          "reference_verification",
          "scanned_at",
        ]);
      } finally {
        await db.close();
      }
    });
  });
}

function arkivOperationsFixture(hash: string, position: number): TransactionArkivOperations[] {
  return [
    {
      position,
      hash: hash as `0x${string}`,
      operations: [
        {
          opIndex: 0,
          operationType: 1,
          operation: "create",
          entityKey: `0x${"ab".repeat(32)}`,
          contentType: "application/vnd.atlas.payload-reference+json",
          payloadSizeBytes: 512,
          attributes: [
            { key: "project", valueType: 2, valueTypeName: "string", value: "demo" },
            { key: "version", valueType: 1, valueTypeName: "uint", value: "7" },
          ],
          expiresAtBlocks: 4_294_967_295,
          newOwner: null,
          // Reference op: receipt metadata + verdict round-trip through jsonb.
          isReference: true,
          payloadReference: {
            kind: "atlas.payloadReference",
            version: 1,
            provider: "atlas-payload-provider",
            id: "a".repeat(64),
            namespace: "atlas.test",
            checksum: `sha256:${"b".repeat(64)}`,
            sizeBytes: 700,
            submittedAt: "2026-06-24T15:24:30Z",
            nonce: `0x${"00".repeat(31)}01`,
            payment: 100000,
            signature: {
              scheme: "eip191",
              signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
              receipt: { service: "atlas-payload-provider" },
              messageHash: `0x${"cd".repeat(32)}`,
              signature: `0x${"ef".repeat(65)}`,
              r: `0x${"11".repeat(32)}`,
              s: `0x${"22".repeat(32)}`,
              v: 27,
            },
          },
          referenceVerification: {
            valid: true,
            signerTrusted: true,
            chainId: 1337,
            claimedSigner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            recoveredSigner: "0x7e5f4552091a69125d5dFcB7b8C2659029395Bdf",
            messageHash: `0x${"cd".repeat(32)}`,
            errors: [],
          },
          referenceError: null,
        },
        {
          opIndex: 1,
          operationType: 4,
          operation: "transfer",
          entityKey: `0x${"cd".repeat(32)}`,
          contentType: null,
          payloadSizeBytes: 0,
          attributes: [],
          expiresAtBlocks: 0,
          newOwner: "0x9999999999999999999999999999999999999999",
          // Inline (non-reference) op: reference columns stay null/false.
          isReference: false,
          payloadReference: null,
          referenceVerification: null,
          referenceError: null,
        },
      ],
    },
  ];
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
    blockTimeSeconds: "2",
    baseBlockFeeWei: "100",
    totalGasUsed: "21000",
    totalInputDataSizeBytes: "0",
    totalInputDataCompressedSizeBytes: "0",
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
    averageTransactionInputDataSizeBytes: "0",
    averageTransactionInputDataCompressedSizeBytes: "0",
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
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
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
