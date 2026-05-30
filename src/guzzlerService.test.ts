import { describe, expect, test } from "bun:test";
import { GuzzlerService } from "./guzzlerService";
import type {
  GuzzlerBlockTransaction,
  GuzzlerBucket,
  GuzzlerLeaderboards,
  GuzzlerStore,
} from "./guzzlers";

const T0 = Date.parse("2026-05-30T12:00:00.000Z");
const MINUTE = 60 * 1000;
const RETENTION_MS = 60 * MINUTE; // 1 hour, for fast eviction tests

class InMemoryGuzzlerStore implements GuzzlerStore {
  readonly senders = new Map<string, GuzzlerBucket[]>();
  board: GuzzlerLeaderboards | null = null;
  putCount = 0;
  removeCount = 0;
  saveCount = 0;
  closed = false;

  constructor(initial?: Map<string, GuzzlerBucket[]>) {
    if (initial) {
      for (const [address, buckets] of initial) {
        this.senders.set(address, buckets.map((b) => ({ ...b })));
      }
    }
  }

  async loadAll(): Promise<Map<string, GuzzlerBucket[]>> {
    return new Map(
      [...this.senders].map(([address, buckets]) => [address, buckets.map((b) => ({ ...b }))]),
    );
  }
  async putSender(address: string, buckets: GuzzlerBucket[]): Promise<void> {
    this.putCount += 1;
    this.senders.set(address, buckets.map((b) => ({ ...b })));
  }
  async removeSenders(addresses: string[]): Promise<void> {
    this.removeCount += 1;
    for (const address of addresses) this.senders.delete(address);
  }
  async saveLeaderboards(board: GuzzlerLeaderboards): Promise<void> {
    this.saveCount += 1;
    this.board = board;
  }
  async loadLeaderboards(): Promise<GuzzlerLeaderboards | null> {
    return this.board;
  }
  async stats(): Promise<{ entryCount: number; totalBytes: number }> {
    let totalBytes = 0;
    for (const buckets of this.senders.values()) {
      totalBytes += Buffer.byteLength(JSON.stringify(buckets), "utf8");
    }
    return { entryCount: this.senders.size, totalBytes };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function blockTx(
  from: string | null,
  hash: string,
  gasUsed = "21000",
  feeWei = "1000",
): GuzzlerBlockTransaction {
  return { from, hash, gasUsed, feeWei };
}

function service(store: GuzzlerStore, now: number, options: { sweepIntervalMs?: number } = {}) {
  return new GuzzlerService(store, {
    now: () => now,
    sweepIntervalMs: options.sweepIntervalMs ?? 0,
    retentionMs: RETENTION_MS,
  });
}

describe("GuzzlerService", () => {
  test("records a block's senders into minute buckets and persists them", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);

    await svc.recordBlock(T0, [blockTx("0xAaa", "0x1"), blockTx("0xBbb", "0x2"), blockTx(null, "0x3")]);

    expect([...store.senders.keys()].sort()).toEqual(["0xaaa", "0xbbb"]);
    expect(store.senders.get("0xaaa")).toEqual([
      {
        minute: Math.floor(T0 / MINUTE),
        transactionCount: 1,
        totalGasUsed: "21000",
        totalFeeWei: "1000",
        firstSeenMs: T0,
        lastSeenMs: T0,
      },
    ]);
  });

  test("folds multiple same-minute transactions from one sender into a bucket", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);

    await svc.recordBlock(T0, [blockTx("0xAaa", "0x1", "100", "10")]);
    await svc.recordBlock(T0 + 5000, [blockTx("0xAaa", "0x2", "200", "20")]);

    const buckets = store.senders.get("0xaaa");
    expect(buckets).toHaveLength(1);
    expect(buckets?.[0]).toMatchObject({
      transactionCount: 2,
      totalGasUsed: "300",
      totalFeeWei: "30",
    });
  });

  test("ignores blocks older than the retention window", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);

    await svc.recordBlock(T0 - RETENTION_MS - 1, [blockTx("0xAaa", "0x1")]);

    expect(store.senders.size).toBe(0);
    expect(store.putCount).toBe(0);
  });

  test("sweep evicts expired senders and removes them from the store", async () => {
    const store = new InMemoryGuzzlerStore();
    const recordSvc = service(store, T0);
    await recordSvc.recordBlock(T0, [blockTx("0xAaa", "0x1")]);
    expect(store.senders.has("0xaaa")).toBe(true);

    // A fresh service past the retention horizon sweeps the expired sender away.
    const laterSvc = service(store, T0 + RETENTION_MS + MINUTE);
    await laterSvc.start();

    expect(store.senders.has("0xaaa")).toBe(false);
    expect(store.removeCount).toBeGreaterThan(0);
  });

  test("start reloads persisted senders that are still within the window", async () => {
    const store = new InMemoryGuzzlerStore(
      new Map([
        [
          "0xaaa",
          [
            {
              minute: Math.floor(T0 / MINUTE),
              transactionCount: 1,
              totalGasUsed: "21000",
              totalFeeWei: "1000",
              firstSeenMs: T0,
              lastSeenMs: T0,
            },
          ],
        ],
      ]),
    );
    const svc = service(store, T0 + 1000);
    await svc.start();

    expect(svc.getStatistics(T0 + 1000).count).toBe(1);
  });

  test("start publishes an initial cached leaderboard", async () => {
    const store = new InMemoryGuzzlerStore();
    const recordSvc = service(store, T0);
    await recordSvc.recordBlock(T0, [blockTx("0xAaa", "0x1", "500", "50")]);

    const svc = service(store, T0 + 1000);
    await svc.start();

    expect(store.board).not.toBeNull();
    const five = store.board?.windows.find((w) => w.label === "5m");
    expect(five?.guzzlers.map((g) => g.address)).toEqual(["0xaaa"]);
    expect(store.board?.limit).toBe(250);
  });

  test("recordBlock persists buckets but does not refresh the cached board", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);
    await svc.start();
    const savesAfterStart = store.saveCount;

    await svc.recordBlock(T0, [blockTx("0xAaa", "0x1")]);

    // Bucket data is mirrored immediately...
    expect(store.senders.has("0xaaa")).toBe(true);
    // ...but the cached leaderboard only refreshes on the minute tick.
    expect(store.saveCount).toBe(savesAfterStart);

    await svc.refreshLeaderboards();
    expect(store.saveCount).toBe(savesAfterStart + 1);
    const five = store.board?.windows.find((w) => w.label === "5m");
    expect(five?.guzzlers.map((g) => g.address)).toEqual(["0xaaa"]);
  });

  test("stop closes the store", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);
    await svc.stop();
    expect(store.closed).toBe(true);
  });
});
