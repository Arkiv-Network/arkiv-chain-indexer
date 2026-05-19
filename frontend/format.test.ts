import { describe, expect, test } from "bun:test";
import {
  fmtBytes,
  fmtDate,
  fmtDurationSeconds,
  fmtEth,
  fmtGwei,
  fmtInteger,
  fmtRatio,
  fmtSig,
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
    expect(fmtDate("not-a-date", "UTC")).toBe("not-a-date");
  });

  test("formats durations from seconds", () => {
    expect(fmtDurationSeconds(null)).toBe("—");
    expect(fmtDurationSeconds(59)).toBe("59s");
    expect(fmtDurationSeconds(125)).toBe("2m 5s");
    expect(fmtDurationSeconds(7_200)).toBe("2h 0m");
  });
});
