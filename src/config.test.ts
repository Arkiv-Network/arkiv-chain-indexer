import { describe, expect, test } from "bun:test";
import { HelpRequested, parseConfig } from "./config";

const baseEnv: NodeJS.ProcessEnv = {
  SCANNER_RPC_FULL_NODE: "https://example.test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
  SCANNER_FROM_BLOCK: "10",
};

describe("parseConfig", () => {
  test("does not require from-block for continuous near-head scanning", () => {
    expect(
      parseConfig([], {
        SCANNER_RPC_FULL_NODE: "https://example.test",
        DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      }).fromBlock,
    ).toBeUndefined();
  });

  test("requires from-block when to-block is set", () => {
    expect(() =>
      parseConfig(["--to-block", "12"], {
        SCANNER_RPC_FULL_NODE: "https://example.test",
        DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      }),
    ).toThrow("--from-block is required when --to-block is set");
  });

  test("requires DATABASE_URL", () => {
    expect(() => parseConfig([], { SCANNER_RPC_FULL_NODE: "https://example.test" })).toThrow(
      "DATABASE_URL (or --database-url) is required",
    );
  });

  test("defaults oldest backfill block to 25000000", () => {
    expect(
      parseConfig([], {
        SCANNER_RPC_FULL_NODE: "https://example.test",
        DATABASE_URL: "postgres://user:pass@localhost:5432/test",
      }).oldestBackfillBlock,
    ).toBe(25_000_000n);
  });

  test("reads oldest backfill block from env", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SCANNER_OLDEST_BACKFILL_BLOCK: "26000000",
      }).oldestBackfillBlock,
    ).toBe(26_000_000n);
  });

  test("lets the CLI oldest backfill block override env", () => {
    expect(
      parseConfig(["--oldest-backfill-block", "27000000"], {
        ...baseEnv,
        SCANNER_OLDEST_BACKFILL_BLOCK: "26000000",
      }).oldestBackfillBlock,
    ).toBe(27_000_000n);
  });

  test("rejects invalid oldest backfill block", () => {
    expect(() =>
      parseConfig(["--oldest-backfill-block", "nope"], baseEnv),
    ).toThrow("--oldest-backfill-block must be a non-negative integer");
  });

  test("defaults transaction receipt concurrency to 20", () => {
    expect(parseConfig([], baseEnv).txReceiptConcurrency).toBe(20);
  });

  test("reads transaction receipt concurrency from env", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SCANNER_TX_RECEIPT_CONCURRENCY: "7",
      }).txReceiptConcurrency,
    ).toBe(7);
  });

  test("lets the CLI transaction receipt concurrency override env", () => {
    expect(
      parseConfig(["--tx-receipt-concurrency", "3"], {
        ...baseEnv,
        SCANNER_TX_RECEIPT_CONCURRENCY: "7",
      }).txReceiptConcurrency,
    ).toBe(3);
  });

  test("rejects zero transaction receipt concurrency", () => {
    expect(() =>
      parseConfig([], {
        ...baseEnv,
        SCANNER_TX_RECEIPT_CONCURRENCY: "0",
      }),
    ).toThrow("--tx-receipt-concurrency must be greater than zero");
  });

  test("includes transaction receipt concurrency in help", () => {
    expect(() => parseConfig(["--help"], baseEnv)).toThrow(HelpRequested);

    try {
      parseConfig(["--help"], baseEnv);
    } catch (error) {
      expect(error).toBeInstanceOf(HelpRequested);
      expect(String((error as Error).message)).toContain("--tx-receipt-concurrency <n>");
    }
  });

  test("includes oldest backfill block in help", () => {
    try {
      parseConfig(["--help"], baseEnv);
    } catch (error) {
      expect(error).toBeInstanceOf(HelpRequested);
      expect(String((error as Error).message)).toContain("--oldest-backfill-block <number>");
    }
  });
});
