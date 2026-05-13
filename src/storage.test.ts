import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  ScannerStorage,
} from "./storage";
import { RANGE_SIZE } from "./ranges";
import type { BlockMetrics } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ScannerStorage", () => {
  test("saves block metrics and resumes from the last successful block", () => {
    const dbPath = tempDbPath();
    const storage = ScannerStorage.open(dbPath);

    expect(storage.getLastSuccessfulBlock()).toBeUndefined();

    storage.saveBlockMetrics({
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

    expect(storage.getLastSuccessfulBlock()).toBe(42n);
    storage.close();

    const reopened = ScannerStorage.open(dbPath);
    expect(reopened.getLastSuccessfulBlock()).toBe(42n);
    reopened.close();
  });

  test("does not advance progress when saving a later block fails", () => {
    const dbPath = tempDbPath();
    const storage = ScannerStorage.open(dbPath);
    storage.saveBlockMetrics({
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

    expect(() =>
      storage.saveBlockMetrics({
        blockDate: "2024-01-01T00:00:00.000Z",
        blockNumber: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        baseBlockFeeWei: "100",
        totalGasUsed: "21000",
        maxGasInBlock: "30000000",
        transactionCount: 1,
        averageTransactionFeeWei: "2310000",
        averagePriorityFeeWeightedWei: "10",
        averagePriorityFeeWei: "10",
      }),
    ).toThrow();

    expect(storage.getLastSuccessfulBlock()).toBe(42n);
    storage.close();
  });

  test("saves backfill cursor separately from forward progress", () => {
    const dbPath = tempDbPath();
    const storage = ScannerStorage.open(dbPath);

    storage.saveBlockMetrics(
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

    expect(storage.getLastSuccessfulBlock()).toBeUndefined();
    expect(storage.getBackfillNextBlock()).toBe(49n);
    storage.close();

    const reopened = ScannerStorage.open(dbPath);
    expect(reopened.getLastSuccessfulBlock()).toBeUndefined();
    expect(reopened.getBackfillNextBlock()).toBe(49n);
    reopened.close();
  });
});

describe("ScannerStorage.queryBlocks", () => {
  test("returns blocks ordered ascending by block number", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (const blockNumber of [3n, 1n, 2n]) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
    }

    const result = storage.queryBlocks();
    expect(result.map((row) => row.blockNumber)).toEqual([1, 2, 3]);
    storage.close();
  });

  test("returns all stored fields in camelCase", () => {
    const storage = ScannerStorage.open(tempDbPath());
    storage.saveBlockMetrics(
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

    const [row] = storage.queryBlocks();
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
    storage.close();
  });

  test("filters by blockGt and blockLt exclusively and combines them additively", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (let blockNumber = 10n; blockNumber <= 20n; blockNumber += 1n) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
    }

    const result = storage.queryBlocks({ blockGt: 12n, blockLt: 16n });
    expect(result.map((row) => row.blockNumber)).toEqual([13, 14, 15]);
    storage.close();
  });

  test("filters by dateGt and dateLt exclusively", () => {
    const storage = ScannerStorage.open(tempDbPath());
    const samples = [
      { blockNumber: 1n, blockDate: "2024-01-01T00:00:00.000Z" },
      { blockNumber: 2n, blockDate: "2024-01-02T00:00:00.000Z" },
      { blockNumber: 3n, blockDate: "2024-01-03T00:00:00.000Z" },
      { blockNumber: 4n, blockDate: "2024-01-04T00:00:00.000Z" },
    ];
    for (const sample of samples) {
      storage.saveBlockMetrics(blockMetricsFixture(sample));
    }

    const result = storage.queryBlocks({
      dateGt: "2024-01-01T00:00:00.000Z",
      dateLt: "2024-01-04T00:00:00.000Z",
    });
    expect(result.map((row) => row.blockNumber)).toEqual([2, 3]);
    storage.close();
  });

  test("treats date and block filters additively", () => {
    const storage = ScannerStorage.open(tempDbPath());
    const samples = [
      { blockNumber: 1n, blockDate: "2024-01-01T00:00:00.000Z" },
      { blockNumber: 2n, blockDate: "2024-01-02T00:00:00.000Z" },
      { blockNumber: 3n, blockDate: "2024-01-03T00:00:00.000Z" },
      { blockNumber: 4n, blockDate: "2024-01-04T00:00:00.000Z" },
    ];
    for (const sample of samples) {
      storage.saveBlockMetrics(blockMetricsFixture(sample));
    }

    const result = storage.queryBlocks({
      blockGt: 1n,
      dateLt: "2024-01-04T00:00:00.000Z",
    });
    expect(result.map((row) => row.blockNumber)).toEqual([2, 3]);
    storage.close();
  });

  test("truncates to the smallest MAX_BLOCKS_PER_QUERY blocks", () => {
    const storage = ScannerStorage.open(tempDbPath());
    const total = MAX_BLOCKS_PER_QUERY + 5;
    for (let i = 1; i <= total; i += 1) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: BigInt(i) }));
    }

    const result = storage.queryBlocks();
    expect(result.length).toBe(MAX_BLOCKS_PER_QUERY);
    expect(result[0]?.blockNumber).toBe(1);
    expect(result[result.length - 1]?.blockNumber).toBe(MAX_BLOCKS_PER_QUERY);
    storage.close();
  });

  test("returns empty array when no blocks match", () => {
    const storage = ScannerStorage.open(tempDbPath());
    storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 1n }));

    expect(storage.queryBlocks({ blockGt: 1000n })).toEqual([]);
    storage.close();
  });
});

describe("ScannerStorage block ranges", () => {
  test("aggregateRangeIfComplete returns undefined for incomplete windows", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (let offset = 0n; offset < 50n; offset += 1n) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 245_600n + offset }));
    }
    expect(storage.aggregateRangeIfComplete(245_600n)).toBeUndefined();
    expect(storage.queryBlockRanges()).toEqual([]);
    storage.close();
  });

  test("aggregateRangeIfComplete writes a row once all 100 blocks are stored", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (let offset = 0n; offset < RANGE_SIZE; offset += 1n) {
      storage.saveBlockMetrics(
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

    const result = storage.aggregateRangeIfComplete(245_600n);
    expect(result).toBeDefined();
    expect(result?.rangeStart).toBe(245_600n);
    expect(result?.rangeEnd).toBe(245_699n);

    const stored = storage.queryBlockRanges();
    expect(stored.length).toBe(1);
    expect(stored[0]).toEqual({
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
    storage.close();
  });

  test("queryBlockRanges filters by range start and dates", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (const rangeStart of [0n, 100n, 200n, 300n]) {
      saveCompleteRange(storage, rangeStart, "2024-01-01T00:00:00.000Z");
    }

    const result = storage.queryBlockRanges({ rangeStartGt: 0n, rangeStartLt: 300n });
    expect(result.map((row) => row.rangeStart)).toEqual([100, 200]);
    storage.close();
  });

  test("queryBlockRanges caps results at MAX_RANGES_PER_QUERY", () => {
    expect(MAX_RANGES_PER_QUERY).toBe(10_000);
  });
});

function saveCompleteRange(
  storage: ScannerStorage,
  rangeStart: bigint,
  blockDate: string,
): void {
  for (let offset = 0n; offset < RANGE_SIZE; offset += 1n) {
    storage.saveBlockMetrics(
      blockMetricsFixture({ blockNumber: rangeStart + offset, blockDate }),
    );
  }
  storage.aggregateRangeIfComplete(rangeStart);
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

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gas-price-tracker-"));
  tempDirs.push(dir);
  return join(dir, "scanner.sqlite");
}
