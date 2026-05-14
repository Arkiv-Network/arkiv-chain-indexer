import { describe, expect, test } from "bun:test";
import { fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./src/format";

describe("frontend format helpers", () => {
  test("formats wei values as Gwei with at most four decimal places", () => {
    expect(fmtGwei(undefined)).toBe("—");
    expect(fmtGwei(null)).toBe("—");
    expect(fmtGwei("0")).toBe("0");
    expect(fmtGwei("1000000000")).toBe("1");
    expect(fmtGwei("1234567890")).toBe("1.2345");
    expect(fmtGwei("1234000000")).toBe("1.234");
    expect(fmtGwei("not-a-number")).toBe("not-a-number");
  });

  test("formats wei values as ETH with at most four decimal places", () => {
    expect(fmtEth(undefined)).toBe("—");
    expect(fmtEth(null)).toBe("—");
    expect(fmtEth("0")).toBe("0");
    expect(fmtEth("1000000000000000000")).toBe("1");
    expect(fmtEth("1234567890000000000")).toBe("1.2345");
    expect(fmtEth("1234000000000000000")).toBe("1.234");
    expect(fmtEth("not-a-number")).toBe("not-a-number");
  });

  test("formats ratios and integers without changing stored precision", () => {
    expect(fmtRatio(undefined, "100")).toBe("—");
    expect(fmtRatio("50", "0")).toBe("50 / 0");
    expect(fmtRatio("1234", "10000")).toBe("1234 / 10000 (12.34%)");
    expect(fmtRatio("bad", "100")).toBe("bad / 100");
    expect(fmtInteger("12345678901234567890")).toBe("12345678901234567890");
    expect(fmtInteger("not-a-number")).toBe("not-a-number");
  });
});
