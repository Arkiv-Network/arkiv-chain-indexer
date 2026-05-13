import { describe, expect, test } from "bun:test";
import { formatBytes, formatDurationMs, formatGwei, formatKGas } from "./format";

describe("format helpers", () => {
  test("formats wei values as Gwei", () => {
    expect(formatGwei("0")).toBe("0 Gwei");
    expect(formatGwei("1000000000")).toBe("1 Gwei");
    expect(formatGwei("1234567890")).toBe("1.23456789 Gwei");
    expect(formatGwei(42_000_000_001n)).toBe("42.000000001 Gwei");
  });

  test("formats gas values as kGas", () => {
    expect(formatKGas("0")).toBe("0 kGas");
    expect(formatKGas("21000")).toBe("21 kGas");
    expect(formatKGas("1234567")).toBe("1234.567 kGas");
  });

  test("formats byte counts with binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1048576)).toBe("1 MiB");
  });

  test("formats durations", () => {
    expect(formatDurationMs(120.4)).toBe("120ms");
    expect(formatDurationMs(1000)).toBe("1s");
    expect(formatDurationMs(1234)).toBe("1.23s");
  });
});
