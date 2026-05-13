import { describe, expect, test } from "bun:test";
import { HelpRequested, parseConfig } from "./config";

const baseEnv: NodeJS.ProcessEnv = {
  SCANNER_RPC_FULL_NODE: "https://example.test",
  SCANNER_FROM_BLOCK: "10",
};

describe("parseConfig", () => {
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
});
