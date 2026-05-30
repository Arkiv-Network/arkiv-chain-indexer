import { describe, expect, test } from "bun:test";
import type { GuzzlerHistoryPoint } from "./src/api";
import {
  activityPlotRange,
  filterPointsByWindow,
  GUZZLER_ACTIVITY_WINDOWS,
  isAddressLike,
  metricSeries,
  normalizeAddressInput,
  summarizeGuzzlerHistory,
  weiToTokenNumber,
} from "./src/guzzlerActivity";

const MINUTE_MS = 60_000;

/** Build a point for a given epoch minute with sensible defaults. */
function point(minute: number, overrides: Partial<GuzzlerHistoryPoint> = {}): GuzzlerHistoryPoint {
  const startMs = minute * MINUTE_MS;
  return {
    minute,
    startTime: new Date(startMs).toISOString(),
    transactionCount: 1,
    totalGasUsed: "1000",
    totalFeeWei: "0",
    firstSeen: new Date(startMs + 1_000).toISOString(),
    lastSeen: new Date(startMs + 30_000).toISOString(),
    ...overrides,
  };
}

describe("filterPointsByWindow", () => {
  // nowMs is in minute 100; build a run of minutes 70..100.
  const nowMs = 100 * MINUTE_MS + 30_000;
  const points = Array.from({ length: 31 }, (_, i) => point(70 + i));

  test("returns every point for the All window (null span)", () => {
    expect(filterPointsByWindow(points, nowMs, null)).toHaveLength(points.length);
  });

  test("keeps only minutes overlapping a fixed window", () => {
    // 10-minute window from a now that sits 30s into minute 100 → cutoff is
    // 30s into minute 90, so minute 90's bucket still overlaps and is kept.
    const windowMs = 10 * MINUTE_MS;
    const kept = filterPointsByWindow(points, nowMs, windowMs);
    expect(kept.map((p) => p.minute)).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  test("does not mutate the input array", () => {
    const copy = [...points];
    filterPointsByWindow(points, nowMs, null);
    expect(points).toEqual(copy);
  });
});

describe("summarizeGuzzlerHistory", () => {
  test("sums counts, gas and fees and finds the busiest minute", () => {
    const points = [
      point(10, {
        transactionCount: 3,
        totalGasUsed: "100",
        totalFeeWei: "1000000000000000000",
        firstSeen: "2026-05-30T10:00:05.000Z",
        lastSeen: "2026-05-30T10:00:50.000Z",
      }),
      point(11, {
        transactionCount: 9,
        totalGasUsed: "250",
        totalFeeWei: "500000000000000000",
        firstSeen: "2026-05-30T10:01:02.000Z",
        lastSeen: "2026-05-30T10:01:59.000Z",
      }),
      point(12, {
        transactionCount: 4,
        totalGasUsed: "70",
        totalFeeWei: "250000000000000000",
        firstSeen: "2026-05-30T10:02:10.000Z",
        lastSeen: "2026-05-30T10:02:40.000Z",
      }),
    ];

    const summary = summarizeGuzzlerHistory(points);
    expect(summary.activeMinutes).toBe(3);
    expect(summary.totalTransactions).toBe(16);
    expect(summary.totalGasUsed).toBe("420");
    expect(summary.totalFeeWei).toBe("1750000000000000000");
    expect(summary.peakTransactions).toBe(9);
    expect(summary.peakMinuteStart).toBe(point(11).startTime);
    expect(summary.firstSeen).toBe("2026-05-30T10:00:05.000Z");
    expect(summary.lastSeen).toBe("2026-05-30T10:02:40.000Z");
  });

  test("returns an empty summary for no points", () => {
    const summary = summarizeGuzzlerHistory([]);
    expect(summary).toEqual({
      activeMinutes: 0,
      totalTransactions: 0,
      totalGasUsed: "0",
      totalFeeWei: "0",
      peakTransactions: 0,
      peakMinuteStart: null,
      firstSeen: null,
      lastSeen: null,
    });
  });
});

describe("metricSeries", () => {
  const points = [
    point(1, { transactionCount: 2, totalGasUsed: "34493168", totalFeeWei: "2000000000000000000" }),
    point(2, { transactionCount: 5, totalGasUsed: "999", totalFeeWei: "0" }),
  ];

  test("transactions metric reads the count", () => {
    expect(metricSeries(points, "transactions")).toEqual([2, 5]);
  });

  test("gas metric reads gas used as a number", () => {
    expect(metricSeries(points, "gas")).toEqual([34493168, 999]);
  });

  test("fees metric converts wei to native-token numbers", () => {
    expect(metricSeries(points, "fees")).toEqual([2, 0]);
  });
});

describe("weiToTokenNumber", () => {
  test("converts whole and fractional token amounts", () => {
    expect(weiToTokenNumber("1000000000000000000")).toBe(1);
    expect(weiToTokenNumber("500000000000000000")).toBe(0.5);
  });

  test("treats malformed input as zero", () => {
    expect(weiToTokenNumber("not-a-number")).toBe(0);
    expect(weiToTokenNumber(null)).toBe(0);
  });
});

describe("activityPlotRange", () => {
  test("returns a fixed [now - span, now] range for a windowed view", () => {
    const nowMs = Date.UTC(2026, 4, 30, 18, 0, 0);
    expect(activityPlotRange(nowMs, 60 * MINUTE_MS)).toEqual([
      new Date(nowMs - 60 * MINUTE_MS).toISOString(),
      new Date(nowMs).toISOString(),
    ]);
  });

  test("returns undefined (auto-fit) for the All window", () => {
    expect(activityPlotRange(Date.now(), null)).toBeUndefined();
  });

  test("24h window spans exactly the retention horizon", () => {
    const day = GUZZLER_ACTIVITY_WINDOWS.find((w) => w.key === "24h");
    expect(day?.ms).toBe(24 * 60 * MINUTE_MS);
  });
});

describe("address helpers", () => {
  test("isAddressLike accepts 0x-prefixed 20-byte hex and trims whitespace", () => {
    expect(isAddressLike("0x7485cc77cf55ac7930506b7d25091fae29c90f0c")).toBe(true);
    expect(isAddressLike("  0x7485CC77CF55AC7930506B7D25091FAE29C90F0C  ")).toBe(true);
  });

  test("isAddressLike rejects malformed values", () => {
    expect(isAddressLike("0x123")).toBe(false);
    expect(isAddressLike("7485cc77cf55ac7930506b7d25091fae29c90f0c")).toBe(false);
    expect(isAddressLike(null)).toBe(false);
  });

  test("normalizeAddressInput lowercases valid addresses and rejects others", () => {
    expect(normalizeAddressInput(" 0x7485CC77CF55AC7930506B7D25091FAE29C90F0C ")).toBe(
      "0x7485cc77cf55ac7930506b7d25091fae29c90f0c",
    );
    expect(normalizeAddressInput("nope")).toBeNull();
  });
});
