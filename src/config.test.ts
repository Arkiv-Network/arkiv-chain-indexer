import { describe, expect, test } from "bun:test";
import { HelpRequested, parseConfig } from "./config";

const baseEnv: NodeJS.ProcessEnv = {
  SCANNER_RPC_FULL_NODE: "https://example.test",
  DATABASE_URL: "postgres://user:pass@localhost:5432/test",
};

describe("parseConfig", () => {
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

  test("saves transaction data by default", () => {
    expect(parseConfig([], baseEnv).saveTransactionData).toBe(true);
  });

  test("reads transaction data storage flag from env", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SAVE_TRANSACTION_DATA: "false",
      }).saveTransactionData,
    ).toBe(false);
  });

  test("lets scanner-specific transaction data storage flag override shared env", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SAVE_TRANSACTION_DATA: "false",
        SCANNER_SAVE_TRANSACTION_DATA: "true",
      }).saveTransactionData,
    ).toBe(true);
  });

  test("lets the CLI transaction data storage flag override env", () => {
    expect(
      parseConfig(["--save-transaction-data", "false"], {
        ...baseEnv,
        SAVE_TRANSACTION_DATA: "true",
      }).saveTransactionData,
    ).toBe(false);
  });

  test("rejects invalid transaction data storage flag", () => {
    expect(() =>
      parseConfig([], {
        ...baseEnv,
        SAVE_TRANSACTION_DATA: "maybe",
      }),
    ).toThrow("--save-transaction-data must be a boolean");
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
      expect(String((error as Error).message)).toContain("--save-transaction-data <bool>");
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

  test("does not disable backfill by default", () => {
    expect(parseConfig([], baseEnv).disableBackfill).toBe(false);
  });

  test("defaults to combined scanner mode with a 100ms backfill sleep", () => {
    const config = parseConfig([], baseEnv);
    expect(config.backfillOnly).toBe(false);
    expect(config.backfillSleepMs).toBe(100);
  });

  test("reads disable backfill flag from env", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SCANNER_DISABLE_BACKFILL: "true",
      }).disableBackfill,
    ).toBe(true);
  });

  test("lets the CLI disable backfill flag override env", () => {
    expect(
      parseConfig(["--disable-backfill", "true"], {
        ...baseEnv,
        SCANNER_DISABLE_BACKFILL: "false",
      }).disableBackfill,
    ).toBe(true);
  });

  test("rejects invalid disable backfill flag", () => {
    expect(() =>
      parseConfig([], {
        ...baseEnv,
        SCANNER_DISABLE_BACKFILL: "maybe",
      }),
    ).toThrow("--disable-backfill must be a boolean");
  });

  test("reads backfill-only mode and backfill sleep from env", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SCANNER_BACKFILL_ONLY: "true",
        SCANNER_BACKFILL_SLEEP_MS: "250",
      }),
    ).toMatchObject({
      backfillOnly: true,
      backfillSleepMs: 250,
    });
  });

  test("lets CLI backfill-only mode and sleep override env", () => {
    expect(
      parseConfig(["--backfill-only", "true", "--backfill-sleep-ms", "75"], {
        ...baseEnv,
        SCANNER_BACKFILL_ONLY: "false",
        SCANNER_BACKFILL_SLEEP_MS: "250",
      }),
    ).toMatchObject({
      backfillOnly: true,
      backfillSleepMs: 75,
    });
  });

  test("allows backfill-only mode together with disabled backfill so the backfill scanner idles", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        SCANNER_BACKFILL_ONLY: "true",
        SCANNER_DISABLE_BACKFILL: "true",
      }),
    ).toMatchObject({
      backfillOnly: true,
      disableBackfill: true,
    });
  });

  test("reads batcher collector URL from env and lets CLI override it", () => {
    expect(
      parseConfig([], {
        ...baseEnv,
        BATCHER_COLLECTOR_URL: "https://collector.example",
      }).batcherCollectorUrl,
    ).toBe("https://collector.example");

    expect(
      parseConfig(["--batcher-collector-url", "https://cli.example"], {
        ...baseEnv,
        BATCHER_COLLECTOR_URL: "https://collector.example",
      }).batcherCollectorUrl,
    ).toBe("https://cli.example");
  });
});
