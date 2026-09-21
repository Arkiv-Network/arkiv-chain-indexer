import { describe, expect, test } from "bun:test";
import { formatStatisticsBytes } from "./src/statisticsFormat";

describe("statistics byte units", () => {
  test("keeps pure bytes exact beyond Number precision", () => {
    expect(formatStatisticsBytes("9007199254740993", "bytes")).toBe("9,007,199,254,740,993 B");
    expect(formatStatisticsBytes("0", "decimal")).toBe("0 B");
    expect(formatStatisticsBytes(null, "decimal")).toBe("Unavailable");
  });

  test("automatically selects decimal or binary units through terabytes", () => {
    expect(formatStatisticsBytes("999", "decimal")).toBe("999 B");
    expect(formatStatisticsBytes("1000", "decimal")).toBe("1.00 kB");
    expect(formatStatisticsBytes("1500000", "decimal")).toBe("1.50 MB");
    expect(formatStatisticsBytes("2000000000", "decimal")).toBe("2.00 GB");
    expect(formatStatisticsBytes("3000000000000", "decimal")).toBe("3.00 TB");
    expect(formatStatisticsBytes("1023", "binary")).toBe("1,023 B");
    expect(formatStatisticsBytes("1024", "binary")).toBe("1.00 KiB");
    expect(formatStatisticsBytes("1572864", "binary")).toBe("1.50 MiB");
    expect(formatStatisticsBytes("2147483648", "binary")).toBe("2.00 GiB");
    expect(formatStatisticsBytes("3298534883328", "binary")).toBe("3.00 TiB");
  });

  test("promotes rounded boundaries and scales fractional per-transaction means", () => {
    expect(formatStatisticsBytes("999999", "decimal")).toBe("1.00 MB");
    expect(formatStatisticsBytes("1048575", "binary")).toBe("1.00 MiB");
    expect(formatStatisticsBytes("9007199254740993", "decimal")).toBe("9.01 PB");
    expect(formatStatisticsBytes("3000", "decimal", "2")).toBe("1.50 kB");
    expect(formatStatisticsBytes("3", "bytes", "2")).toBe("1.50 B");
    expect(formatStatisticsBytes("0", "decimal", "0")).toBe("—");
  });
});
