import { describe, expect, test } from "bun:test";
import {
  buildGuzzlerHistory,
  emptyLeaderboards,
  GUZZLER_WINDOWS,
  GuzzlerTracker,
  isValidBucket,
  sliceLeaderboards,
  type GuzzlerBucket,
} from "./guzzlers";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const T0 = Date.parse("2026-05-30T12:00:00.000Z");

/** A single-transaction bucket landing in the minute that contains `timestampMs`. */
function bucket(timestampMs: number, gasUsed: string, feeWei = "0", count = 1): GuzzlerBucket {
  return {
    minute: Math.floor(timestampMs / MINUTE),
    transactionCount: count,
    totalGasUsed: gasUsed,
    totalFeeWei: feeWei,
    firstSeenMs: timestampMs,
    lastSeenMs: timestampMs,
  };
}

describe("GuzzlerTracker", () => {
  test("tracks a sender and reports it in statistics", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xAbC", { timestampMs: T0, gasUsed: "21000", feeWei: "1000" }, T0);

    const stats = tracker.getStatistics(T0);
    expect(stats.count).toBe(1);
    expect(stats.guzzlers[0]).toMatchObject({
      address: "0xabc",
      transactionCount: 1,
      totalGasUsed: "21000",
      totalFeeWei: "1000",
    });
  });

  test("folds transactions in the same minute into one bucket", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xa", { timestampMs: T0, gasUsed: "100", feeWei: "10" }, T0);
    tracker.record("0xa", { timestampMs: T0 + 5000, gasUsed: "200", feeWei: "20" }, T0 + 5000);

    const buckets = tracker.getSenderBuckets("0xa");
    expect(buckets).toHaveLength(1);
    expect(buckets?.[0]).toMatchObject({
      transactionCount: 2,
      totalGasUsed: "300",
      totalFeeWei: "30",
    });
  });

  test("splits transactions in different minutes into separate buckets", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xa", { timestampMs: T0, gasUsed: "100", feeWei: "0" }, T0);
    tracker.record("0xa", { timestampMs: T0 + 2 * MINUTE, gasUsed: "200", feeWei: "0" }, T0 + 2 * MINUTE);

    const buckets = tracker.getSenderBuckets("0xa");
    expect(buckets?.map((b) => b.transactionCount)).toEqual([1, 1]);
    expect(buckets?.map((b) => b.minute)).toEqual([
      Math.floor(T0 / MINUTE),
      Math.floor((T0 + 2 * MINUTE) / MINUTE),
    ]);
  });

  test("normalizes addresses case-insensitively", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xAAA", { timestampMs: T0, gasUsed: "10", feeWei: "0" }, T0);
    tracker.record("0xaaa", { timestampMs: T0 + 1000, gasUsed: "20", feeWei: "0" }, T0 + 1000);

    const stats = tracker.getStatistics(T0 + 1000);
    expect(stats.count).toBe(1);
    expect(stats.guzzlers[0]?.transactionCount).toBe(2);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("30");
  });

  test("evicts buckets older than the retention window on record", () => {
    const tracker = new GuzzlerTracker(2 * MINUTE);
    tracker.record("0xa", { timestampMs: T0, gasUsed: "10", feeWei: "0" }, T0);
    tracker.record("0xa", { timestampMs: T0 + 3 * MINUTE, gasUsed: "20", feeWei: "0" }, T0 + 3 * MINUTE);

    const stats = tracker.getStatistics(T0 + 3 * MINUTE);
    expect(stats.guzzlers[0]?.transactionCount).toBe(1);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("20");
  });

  test("sweep removes senders whose buckets all aged out", () => {
    const tracker = new GuzzlerTracker(2 * MINUTE);
    tracker.record("0xa", { timestampMs: T0, gasUsed: "10", feeWei: "0" }, T0);
    tracker.record("0xb", { timestampMs: T0 + 90 * 1000, gasUsed: "10", feeWei: "0" }, T0 + 90 * 1000);

    const { removed, updated } = tracker.sweep(T0 + 3 * MINUTE);
    expect(removed).toEqual(["0xa"]);
    expect(updated).toEqual([]);
    expect(tracker.senderCount).toBe(1);
    expect(tracker.getStatistics(T0 + 3 * MINUTE).count).toBe(1);
  });

  test("returns only senders active in the window, sorted by gas used desc", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xsmall", { timestampMs: T0, gasUsed: "100", feeWei: "0" }, T0);
    tracker.record("0xsmall", { timestampMs: T0 + 1000, gasUsed: "100", feeWei: "0" }, T0 + 1000);
    tracker.record("0xbig", { timestampMs: T0 + 2000, gasUsed: "500", feeWei: "0" }, T0 + 2000);

    const stats = tracker.getStatistics(T0 + 2000);
    expect(stats.guzzlers.map((g) => g.address)).toEqual(["0xbig", "0xsmall"]);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("500");
    expect(stats.guzzlers[1]?.totalGasUsed).toBe("200");
  });

  test("reports first and last seen timestamps across buckets", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xa", { timestampMs: T0, gasUsed: "1", feeWei: "0" }, T0);
    tracker.record("0xa", { timestampMs: T0 + 5 * MINUTE, gasUsed: "1", feeWei: "0" }, T0 + 5 * MINUTE);

    const stat = tracker.getStatistics(T0 + 5 * MINUTE).guzzlers[0];
    expect(stat?.firstSeen).toBe(new Date(T0).toISOString());
    expect(stat?.lastSeen).toBe(new Date(T0 + 5 * MINUTE).toISOString());
  });

  test("loadSender restores retained buckets sorted by minute", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [bucket(T0 + 2 * MINUTE, "5"), bucket(T0, "5")]);
    expect(tracker.getSenderBuckets("0xa")?.map((b) => b.minute)).toEqual([
      Math.floor(T0 / MINUTE),
      Math.floor((T0 + 2 * MINUTE) / MINUTE),
    ]);
  });
});

describe("GuzzlerTracker.getLeaderboards", () => {
  test("buckets each bucket into the windows that contain it", () => {
    const tracker = new GuzzlerTracker();
    // Ages chosen to land in nested window sets.
    tracker.loadSender("0xrecent", [bucket(T0 - MINUTE, "100", "10")]); // 1m → every window
    tracker.loadSender("0xmid", [bucket(T0 - 30 * MINUTE, "500", "50")]); // 30m → 1h,6h,24h
    tracker.loadSender("0xold", [bucket(T0 - 10 * HOUR, "999", "99")]); // 10h → 24h only

    const board = tracker.getLeaderboards(T0, 10);
    expect(board.retentionMs).toBe(24 * HOUR);
    expect(board.limit).toBe(10);
    const byLabel = Object.fromEntries(board.windows.map((w) => [w.label, w]));

    expect(byLabel["5m"]!.guzzlers.map((g) => g.address)).toEqual(["0xrecent"]);
    expect(byLabel["20m"]!.guzzlers.map((g) => g.address)).toEqual(["0xrecent"]);
    // 1h includes recent + mid, ranked by gas (500 > 100).
    expect(byLabel["1h"]!.guzzlers.map((g) => g.address)).toEqual(["0xmid", "0xrecent"]);
    expect(byLabel["6h"]!.guzzlers.map((g) => g.address)).toEqual(["0xmid", "0xrecent"]);
    expect(byLabel["24h"]!.count).toBe(3);
    expect(byLabel["24h"]!.guzzlers.map((g) => g.address)).toEqual(["0xold", "0xmid", "0xrecent"]);
  });

  test("sums a sender's buckets within a window", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [
      bucket(T0 - MINUTE, "100", "10"),
      bucket(T0 - 2 * MINUTE, "200", "20"),
    ]);

    const board = tracker.getLeaderboards(T0, 10);
    const five = board.windows.find((w) => w.label === "5m")!;
    expect(five.guzzlers[0]).toMatchObject({
      address: "0xa",
      transactionCount: 2,
      totalGasUsed: "300",
      totalFeeWei: "30",
    });
  });

  test("applies the top-N limit per window but still reports the full count", () => {
    const tracker = new GuzzlerTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.loadSender(`0x${i.toString()}`, [bucket(T0 - MINUTE, String((i + 1) * 100))]);
    }

    const board = tracker.getLeaderboards(T0, 2);
    const five = board.windows.find((w) => w.label === "5m")!;
    expect(five.count).toBe(5);
    expect(five.guzzlers.map((g) => g.address)).toEqual(["0x4", "0x3"]);
  });
});

describe("sliceLeaderboards", () => {
  test("cuts each window to the requested top-N while preserving the count", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [bucket(T0 - MINUTE, "100")]);
    tracker.loadSender("0xb", [bucket(T0 - MINUTE, "200")]);
    tracker.loadSender("0xc", [bucket(T0 - MINUTE, "300")]);

    const full = tracker.getLeaderboards(T0, 250);
    const sliced = sliceLeaderboards(full, 1);
    const five = sliced.windows.find((w) => w.label === "5m")!;
    expect(sliced.limit).toBe(1);
    expect(five.count).toBe(3);
    expect(five.guzzlers.map((g) => g.address)).toEqual(["0xc"]);
  });
});

describe("malformed bucket handling", () => {
  const malformed = {
    hash: "0x1",
    timestampMs: T0,
    gasUsed: "21000",
    feeWei: "1000",
  } as unknown as GuzzlerBucket;

  test("isValidBucket accepts buckets and rejects malformed shapes", () => {
    expect(isValidBucket(bucket(T0, "1"))).toBe(true);
    expect(isValidBucket(malformed)).toBe(false);
    expect(isValidBucket(null)).toBe(false);
    expect(isValidBucket({})).toBe(false);
  });

  test("loadSender drops malformed entries instead of producing Invalid Date", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [malformed, malformed]);
    expect(tracker.senderCount).toBe(0);
    expect(() => tracker.getLeaderboards(T0, 10)).not.toThrow();
  });

  test("loadSender keeps valid buckets and skips malformed ones", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [malformed, bucket(T0 - MINUTE, "100", "10")]);
    const stats = tracker.getStatistics(T0);
    expect(stats.count).toBe(1);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("100");
  });

  test("buildGuzzlerHistory drops malformed buckets", () => {
    const history = buildGuzzlerHistory("0xa", [malformed, bucket(T0 - MINUTE, "100", "10")], T0);
    expect(history.count).toBe(1);
    expect(history.points[0]?.totalGasUsed).toBe("100");
  });
});

describe("emptyLeaderboards", () => {
  test("returns a well-formed payload with every window empty", () => {
    const board = emptyLeaderboards(T0, 100);
    expect(board.limit).toBe(100);
    expect(board.retentionMs).toBe(24 * HOUR);
    expect(board.windows.map((w) => w.label)).toEqual(GUZZLER_WINDOWS.map((w) => w.label));
    for (const window of board.windows) {
      expect(window.count).toBe(0);
      expect(window.guzzlers).toEqual([]);
    }
  });
});
