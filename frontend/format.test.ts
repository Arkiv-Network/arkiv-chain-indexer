import { describe, expect, test } from "bun:test";
import {
  fmtBytes,
  fmtDate,
  fmtDurationSeconds,
  fmtEth,
  fmtGasPrice,
  fmtGwei,
  fmtInteger,
  fmtTokenAmount,
  fmtMillions,
  fmtRatio,
  fmtSig,
  fmtThousands,
  fmtUtcDate,
} from "./src/format";

describe("frontend format helpers", () => {
  test("formats wei values as Gwei with 4 significant digits", () => {
    expect(fmtGwei(undefined)).toBe("—");
    expect(fmtGwei(null)).toBe("—");
    expect(fmtGwei("0")).toBe("0");
    expect(fmtGwei("1000000000")).toBe("1");
    expect(fmtGwei("1234567890")).toBe("1.235");
    expect(fmtGwei("1234000000")).toBe("1.234");
    expect(fmtGwei("not-a-number")).toBe("not-a-number");
  });

  test("formats gas prices in the unit that can show them", () => {
    expect(fmtGasPrice(undefined)).toBe("—");
    expect(fmtGasPrice(null)).toBe("—");
    expect(fmtGasPrice("0")).toBe("0 wei");
    expect(fmtGasPrice("10000000000")).toBe("10 gwei");
    expect(fmtGasPrice("1234567890")).toBe("1.235 gwei");
    expect(fmtGasPrice("100000000")).toBe("0.1 gwei");
    expect(fmtGasPrice("1000000")).toBe("0.001 gwei");
    // Arkiv devnet prices: gwei would render every one of these as "0".
    expect(fmtGasPrice("999999")).toBe("999999 wei");
    expect(fmtGasPrice("9")).toBe("9 wei");
    expect(fmtGasPrice("7")).toBe("7 wei");
    expect(fmtGasPrice("2")).toBe("2 wei");
    expect(fmtGasPrice("not-a-number")).toBe("not-a-number");
  });

  test("formats token amounts, falling back to wei below ETH resolution", () => {
    expect(fmtTokenAmount(undefined, "ETH")).toBe("—");
    expect(fmtTokenAmount("0", "ETH")).toBe("0 ETH");
    expect(fmtTokenAmount("1000000000000000000", "ETH")).toBe("1 ETH");
    expect(fmtTokenAmount("10000000000", "ETH")).toBe("0.00000001 ETH");
    // A 113432 gas transaction at 9 wei costs 1020888 wei — "0 ETH" hides it.
    expect(fmtTokenAmount("1020888", "ETH")).toBe("1020888 wei");
    expect(fmtTokenAmount("1", "TOK")).toBe("1 wei");
    expect(fmtTokenAmount("not-a-number", "ETH")).toBe("not-a-number");
  });

  test("formats wei values as ETH with 4 significant digits", () => {
    expect(fmtEth(undefined)).toBe("—");
    expect(fmtEth(null)).toBe("—");
    expect(fmtEth("0")).toBe("0");
    expect(fmtEth("1000000000000000000")).toBe("1");
    expect(fmtEth("1234567890000000000")).toBe("1.235");
    expect(fmtEth("1234000000000000000")).toBe("1.234");
    expect(fmtEth("1000000000000000")).toBe("0.001");
    expect(fmtEth("134500000000000")).toBe("0.0001345");
    expect(fmtEth("9")).toBe("0");
    expect(fmtEth("not-a-number")).toBe("not-a-number");
  });

  test("fmtSig caps at 4 significant digits and trims zeros", () => {
    expect(fmtSig(undefined)).toBe("—");
    expect(fmtSig(null)).toBe("—");
    expect(fmtSig("not-a-number")).toBe("not-a-number");

    expect(fmtSig(0)).toBe("0");
    expect(fmtSig(1e-9)).toBe("0");
    expect(fmtSig(1e-8)).toBe("0.00000001");
    expect(fmtSig(0.0001345)).toBe("0.0001345");
    expect(fmtSig(0.001)).toBe("0.001");
    expect(fmtSig(1)).toBe("1");
    expect(fmtSig(1.234567)).toBe("1.235");
    expect(fmtSig(12.34567)).toBe("12.35");
    expect(fmtSig(123.4567)).toBe("123.5");
    expect(fmtSig(999.9)).toBe("999.9");
    expect(fmtSig(1000)).toBe("1000.0");
    expect(fmtSig(1234.56)).toBe("1234.6");
    expect(fmtSig(1_234_567)).toBe("1234567.0");
    expect(fmtSig(-1.234567)).toBe("-1.235");
    expect(fmtSig(-0.0001345)).toBe("-0.0001345");
  });

  test("keeps trailing zeros when trimZeros is false", () => {
    // 9.3797992667 ETH rounds to 4 significant digits as "9.380" — the trailing
    // zero must survive instead of collapsing to "9.38".
    expect(fmtEth("9379799266705438590", { trimZeros: false })).toBe("9.380");
    expect(fmtEth("9379799266705438590")).toBe("9.38");
    expect(fmtSig(9.38, { trimZeros: false })).toBe("9.380");
    expect(fmtSig(0.1, { trimZeros: false })).toBe("0.1000");
  });

  test("formats raw counts in millions and thousands", () => {
    expect(fmtMillions(null)).toBe("—");
    expect(fmtMillions("7068398560")).toBe("7068.40M");
    expect(fmtMillions("not-a-number")).toBe("not-a-number");
    expect(fmtThousands(null)).toBe("—");
    expect(fmtThousands("2025329")).toBe("2025.33K");
    expect(fmtThousands("not-a-number")).toBe("not-a-number");
  });

  test("formats ratios and integers without changing stored precision", () => {
    expect(fmtRatio(undefined, "100")).toBe("—");
    expect(fmtRatio("50", "0")).toBe("50 / 0");
    expect(fmtRatio("1234", "10000")).toBe("1234 / 10000 (12.34%)");
    expect(fmtRatio("bad", "100")).toBe("bad / 100");
    expect(fmtInteger("12345678901234567890")).toBe("12345678901234567890");
    expect(fmtInteger("not-a-number")).toBe("not-a-number");
  });

  test("formats byte counts with readable units", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes("0")).toBe("0 B");
    expect(fmtBytes("1024")).toBe("1.00 KB");
    expect(fmtBytes("1536")).toBe("1.50 KB");
    expect(fmtBytes("10485760")).toBe("10.0 MB");
    expect(fmtBytes("not-a-number")).toBe("not-a-number");
  });

  test("formats timestamps in selected timezones and UTC", () => {
    expect(fmtUtcDate("2024-01-01T00:00:00.000Z")).toBe("2024-01-01 00:00:00Z");
    expect(fmtDate("2024-01-01T00:00:00.000Z", "UTC")).toContain("UTC");
    expect(fmtDate("2024-07-01T00:00:00.000Z", "Europe/Berlin")).toMatch(/\sCET$/);
    expect(fmtDate("not-a-date", "UTC")).toBe("not-a-date");
  });

  test("formats durations from seconds", () => {
    expect(fmtDurationSeconds(null)).toBe("—");
    expect(fmtDurationSeconds(59)).toBe("59s");
    expect(fmtDurationSeconds(125)).toBe("2m 5s");
    expect(fmtDurationSeconds(7_200)).toBe("2h 0m");
  });
});
