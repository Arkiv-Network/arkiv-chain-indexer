import { describe, expect, test } from "bun:test";
import {
  GuzzlerTracker,
  readGuzzlerStatistics,
  type GuzzlerStore,
  type GuzzlerTransaction,
} from "./guzzlers";

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

describe("readGuzzlerStatistics", () => {
  test("loads from the store, drops aged-out senders, and sorts by gas", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        ["0xactive", [tx("0x1", T0, "300")]],
        ["0xbusy", [tx("0x2", T0 - 10, "50"), tx("0x3", T0 - 5, "60")]],
        ["0xexpired", [tx("0x4", T0 - 10_000_000, "999")]],
      ]),
    );

    const stats = await readGuzzlerStatistics(store, T0);
    expect(stats.guzzlers.map((g) => g.address)).toEqual(["0xactive", "0xbusy"]);
    expect(stats.count).toBe(2);
    expect(stats.windowMs).toBe(60 * 60 * 1000);
  });
});
