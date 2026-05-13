import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScannerStorage } from "./storage";

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

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gas-price-tracker-"));
  tempDirs.push(dir);
  return join(dir, "scanner.sqlite");
}
