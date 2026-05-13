import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateRanges } from "./aggregator";
import { ScannerStorage } from "./storage";
import type { BlockMetrics } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("aggregateRanges", () => {
  test("returns zero counts when there are no stored blocks", () => {
    const storage = ScannerStorage.open(tempDbPath());
    const result = aggregateRanges(storage, { rangeSize: 50n });
    expect(result).toEqual({ written: 0, incomplete: 0 });
    expect(storage.queryBlockRanges({ rangeSize: 50n })).toEqual([]);
    storage.close();
  });

  test("aggregates only complete windows aligned to rangeSize", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (let blockNumber = 0n; blockNumber < 120n; blockNumber += 1n) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
    }

    const events: Array<{ rangeStart: bigint; status: string }> = [];
    const result = aggregateRanges(storage, {
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

    const stored = storage.queryBlockRanges({ rangeSize: 50n });
    expect(stored.map((row) => row.rangeStart)).toEqual([0, 50]);
    storage.close();
  });

  test("supports multiple range sizes independently", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (let blockNumber = 0n; blockNumber < 100n; blockNumber += 1n) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
    }

    aggregateRanges(storage, { rangeSize: 10n });
    aggregateRanges(storage, { rangeSize: 100n });

    const tens = storage.queryBlockRanges({ rangeSize: 10n });
    const hundreds = storage.queryBlockRanges({ rangeSize: 100n });
    expect(tens.map((row) => row.rangeStart)).toEqual([
      0, 10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]);
    expect(hundreds.map((row) => row.rangeStart)).toEqual([0]);
    storage.close();
  });

  test("respects fromBlock and toBlock bounds", () => {
    const storage = ScannerStorage.open(tempDbPath());
    for (let blockNumber = 0n; blockNumber < 200n; blockNumber += 1n) {
      storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
    }

    const result = aggregateRanges(storage, {
      rangeSize: 50n,
      fromBlock: 60n,
      toBlock: 120n,
    });
    expect(result.firstRangeStart).toBe(50n);
    expect(result.lastRangeStart).toBe(100n);
    expect(result.written).toBe(2);
    storage.close();
  });

  test("rejects unsupported rangeSize", () => {
    const storage = ScannerStorage.open(tempDbPath());
    expect(() => aggregateRanges(storage, { rangeSize: 7n })).toThrow();
    storage.close();
  });
});

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
  const dir = mkdtempSync(join(tmpdir(), "gas-price-tracker-aggregator-"));
  tempDirs.push(dir);
  return join(dir, "scanner.sqlite");
}
