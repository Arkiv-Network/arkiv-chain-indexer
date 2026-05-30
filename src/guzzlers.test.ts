import { describe, expect, test } from "bun:test";
import {
  GuzzlerLeaderboardCache,
  GuzzlerTracker,
  readGuzzlerLeaderboards,
  type GuzzlerStore,
  type GuzzlerTransaction,
} from "./guzzlers";

const HOUR = 60 * 60 * 1000;

const T0 = Date.parse("2026-05-30T12:00:00.000Z");

function tx(hash: string, timestampMs: number, gasUsed: string, feeWei = "0"): GuzzlerTransaction {
  return { hash, timestampMs, gasUsed, feeWei };
}

class FakeGuzzlerStore implements GuzzlerStore {
  constructor(private readonly data: Map<string, GuzzlerTransaction[]>) {}
  async loadAll(): Promise<Map<string, GuzzlerTransaction[]>> {
    return new Map([...this.data].map(([address, txs]) => [address, txs.map((t) => ({ ...t }))]));
  }
  async putSender(): Promise<void> {}
  async removeSenders(): Promise<void> {}
  async stats(): Promise<{ entryCount: number; totalBytes: number }> {
    return { entryCount: this.data.size, totalBytes: 0 };
  }
  async close(): Promise<void> {}
}

describe("GuzzlerTracker", () => {
  test("tracks a sender and reports it in statistics", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xAbC", tx("0x1", T0, "21000", "1000"), T0);

    const stats = tracker.getStatistics(T0);
    expect(stats.count).toBe(1);
    expect(stats.guzzlers[0]).toMatchObject({
      address: "0xabc",
      transactionCount: 1,
      totalGasUsed: "21000",
      totalFeeWei: "1000",
    });
  });

  test("normalizes addresses case-insensitively", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xAAA", tx("0x1", T0, "10"), T0);
    tracker.record("0xaaa", tx("0x2", T0 + 1, "20"), T0 + 1);

    const stats = tracker.getStatistics(T0 + 1);
    expect(stats.count).toBe(1);
    expect(stats.guzzlers[0]?.transactionCount).toBe(2);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("30");
  });

  test("evicts transactions older than the window on record", () => {
    const tracker = new GuzzlerTracker(1000);
    tracker.record("0xa", tx("0x1", 0, "10"), 0);
    tracker.record("0xa", tx("0x2", 2000, "20"), 2000);

    const stats = tracker.getStatistics(2000);
    expect(stats.guzzlers[0]?.transactionCount).toBe(1);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("20");
  });

  test("sweep removes senders whose transactions all aged out", () => {
    const tracker = new GuzzlerTracker(1000);
    tracker.record("0xa", tx("0x1", 0, "10"), 0);
    tracker.record("0xb", tx("0x2", 1500, "10"), 1500);

    const { removed, updated } = tracker.sweep(2000);
    expect(removed).toEqual(["0xa"]);
    expect(updated).toEqual([]);
    expect(tracker.senderCount).toBe(1);
    expect(tracker.getStatistics(2000).count).toBe(1);
  });

  test("returns only senders active in the window, sorted by gas used desc", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xsmall", tx("0x1", T0, "100"), T0);
    tracker.record("0xsmall", tx("0x2", T0 + 1, "100"), T0 + 1);
    tracker.record("0xbig", tx("0x3", T0 + 2, "500"), T0 + 2);

    const stats = tracker.getStatistics(T0 + 2);
    expect(stats.guzzlers.map((g) => g.address)).toEqual(["0xbig", "0xsmall"]);
    expect(stats.guzzlers[0]?.totalGasUsed).toBe("500");
    expect(stats.guzzlers[1]?.totalGasUsed).toBe("200");
  });

  test("reports first and last seen timestamps", () => {
    const tracker = new GuzzlerTracker();
    tracker.record("0xa", tx("0x1", T0, "1"), T0);
    tracker.record("0xa", tx("0x2", T0 + 5000, "1"), T0 + 5000);

    const stat = tracker.getStatistics(T0 + 5000).guzzlers[0];
    expect(stat?.firstSeen).toBe(new Date(T0).toISOString());
    expect(stat?.lastSeen).toBe(new Date(T0 + 5000).toISOString());
  });

  test("loadSender restores retained transactions", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [tx("0x2", T0 + 1, "5"), tx("0x1", T0, "5")]);
    expect(tracker.getSenderTransactions("0xa")?.map((t) => t.hash)).toEqual(["0x1", "0x2"]);
  });
});

describe("GuzzlerTracker.getLeaderboards", () => {
  test("buckets each transaction into the windows that contain it", () => {
    const tracker = new GuzzlerTracker();
    // Ages chosen to land in nested window sets.
    tracker.loadSender("0xrecent", [tx("0xr", T0 - 60_000, "100", "10")]); // 1m → every window
    tracker.loadSender("0xmid", [tx("0xm", T0 - 30 * 60_000, "500", "50")]); // 30m → 1h,6h,24h
    tracker.loadSender("0xold", [tx("0xo", T0 - 10 * HOUR, "999", "99")]); // 10h → 24h only

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

  test("sums repeated transactions for a sender within a window", () => {
    const tracker = new GuzzlerTracker();
    tracker.loadSender("0xa", [tx("0x1", T0 - 1000, "100", "10"), tx("0x2", T0 - 2000, "200", "20")]);

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
      tracker.loadSender(`0x${i.toString()}`, [tx(`0xh${i.toString()}`, T0 - 1000, String((i + 1) * 100))]);
    }

    const board = tracker.getLeaderboards(T0, 2);
    const five = board.windows.find((w) => w.label === "5m")!;
    expect(five.count).toBe(5);
    expect(five.guzzlers.map((g) => g.address)).toEqual(["0x4", "0x3"]);
  });
});

describe("readGuzzlerLeaderboards", () => {
  test("loads from the store, drops aged-out senders, and ranks per window", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        ["0xactive", [tx("0x1", T0 - 60_000, "300")]],
        ["0xbusy", [tx("0x2", T0 - 10, "50"), tx("0x3", T0 - 5, "60")]],
        ["0xexpired", [tx("0x4", T0 - 25 * HOUR, "999")]],
      ]),
    );

    const board = await readGuzzlerLeaderboards(store, T0, 10);
    expect(board.windows.map((w) => w.label)).toEqual(["5m", "20m", "1h", "6h", "24h"]);
    const five = board.windows.find((w) => w.label === "5m")!;
    // 0xbusy (110) outranks 0xactive (300)? No — 300 > 110, so 0xactive first.
    expect(five.guzzlers.map((g) => g.address)).toEqual(["0xactive", "0xbusy"]);
    // The sender beyond the 24h retention is swept from every window.
    for (const window of board.windows) {
      expect(window.guzzlers.map((g) => g.address)).not.toContain("0xexpired");
    }
  });
});

class CountingGuzzlerStore extends FakeGuzzlerStore {
  loadCount = 0;
  override async loadAll(): Promise<Map<string, GuzzlerTransaction[]>> {
    this.loadCount += 1;
    return super.loadAll();
  }
}

describe("GuzzlerLeaderboardCache", () => {
  function buildStore(): CountingGuzzlerStore {
    return new CountingGuzzlerStore(
      new Map([
        ["0xa", [tx("0x1", T0 - 1000, "100")]],
        ["0xb", [tx("0x2", T0 - 1000, "200")]],
        ["0xc", [tx("0x3", T0 - 1000, "300")]],
      ]),
    );
  }

  test("reuses the computed board within the TTL and recomputes after it", async () => {
    const store = buildStore();
    let now = T0;
    const cache = new GuzzlerLeaderboardCache(store, { ttlMs: 5000, now: () => now });

    await cache.get(10);
    now = T0 + 4000; // still within the 5s TTL
    await cache.get(10);
    expect(store.loadCount).toBe(1);

    now = T0 + 6000; // past the TTL
    await cache.get(10);
    expect(store.loadCount).toBe(2);
  });

  test("serves different limits from one cached board", async () => {
    const store = buildStore();
    const cache = new GuzzlerLeaderboardCache(store, { ttlMs: 5000, now: () => T0 });

    const top1 = await cache.get(1);
    const top10 = await cache.get(10);

    expect(store.loadCount).toBe(1); // both served from the same rebuild
    const five1 = top1.windows.find((w) => w.label === "5m")!;
    const five10 = top10.windows.find((w) => w.label === "5m")!;
    expect(top1.limit).toBe(1);
    expect(five1.guzzlers.map((g) => g.address)).toEqual(["0xc"]);
    expect(five1.count).toBe(3); // full count preserved despite the cut
    expect(five10.guzzlers.map((g) => g.address)).toEqual(["0xc", "0xb", "0xa"]);
  });

  test("collapses concurrent misses onto a single rebuild", async () => {
    const store = buildStore();
    const cache = new GuzzlerLeaderboardCache(store, { ttlMs: 5000, now: () => T0 });

    await Promise.all([cache.get(10), cache.get(10), cache.get(10)]);
    expect(store.loadCount).toBe(1);
  });
});
