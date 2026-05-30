import { describe, expect, test } from "bun:test";
import { GuzzlerService } from "./guzzlerService";
import type { GuzzlerBlockTransaction, GuzzlerStore, GuzzlerTransaction } from "./guzzlers";

const T0 = Date.parse("2026-05-30T12:00:00.000Z");
const WINDOW_MS = 3_600_000;

class InMemoryGuzzlerStore implements GuzzlerStore {
  readonly senders = new Map<string, GuzzlerTransaction[]>();
  putCount = 0;
  removeCount = 0;
  closed = false;

  constructor(initial?: Map<string, GuzzlerTransaction[]>) {
    if (initial) {
      for (const [address, txs] of initial) this.senders.set(address, txs.map((t) => ({ ...t })));
    }
  }

  async loadAll(): Promise<Map<string, GuzzlerTransaction[]>> {
    return new Map([...this.senders].map(([address, txs]) => [address, txs.map((t) => ({ ...t }))]));
  }
  async putSender(address: string, txs: GuzzlerTransaction[]): Promise<void> {
    this.putCount += 1;
    this.senders.set(address, txs.map((t) => ({ ...t })));
  }
  async removeSenders(addresses: string[]): Promise<void> {
    this.removeCount += 1;
    for (const address of addresses) this.senders.delete(address);
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
    windowMs: WINDOW_MS,
  });
}

describe("GuzzlerService", () => {
  test("records a block's senders and persists them", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);

    await svc.recordBlock(T0, [blockTx("0xAaa", "0x1"), blockTx("0xBbb", "0x2"), blockTx(null, "0x3")]);

    expect([...store.senders.keys()].sort()).toEqual(["0xaaa", "0xbbb"]);
    expect(store.senders.get("0xaaa")).toEqual([
      { hash: "0x1", timestampMs: T0, gasUsed: "21000", feeWei: "1000" },
    ]);
  });

  test("ignores blocks older than the retention window", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);

    await svc.recordBlock(T0 - WINDOW_MS - 1, [blockTx("0xAaa", "0x1")]);

    expect(store.senders.size).toBe(0);
    expect(store.putCount).toBe(0);
  });

  test("sweep evicts expired senders and removes them from the store", async () => {
    const store = new InMemoryGuzzlerStore();
    const recordSvc = service(store, T0);
    await recordSvc.recordBlock(T0, [blockTx("0xAaa", "0x1")]);
    expect(store.senders.has("0xaaa")).toBe(true);

    // A fresh service one hour later sweeps the now-expired sender away.
    const laterSvc = service(store, T0 + WINDOW_MS + 1);
    await laterSvc.start();

    expect(store.senders.has("0xaaa")).toBe(false);
    expect(store.removeCount).toBeGreaterThan(0);
  });

  test("start reloads persisted senders that are still within the window", async () => {
    const store = new InMemoryGuzzlerStore(
      new Map([["0xaaa", [{ hash: "0x1", timestampMs: T0, gasUsed: "21000", feeWei: "1000" }]]]),
    );
    const svc = service(store, T0 + 1000);
    await svc.start();

    expect(svc.getStatistics(T0 + 1000).count).toBe(1);
  });

  test("stop closes the store", async () => {
    const store = new InMemoryGuzzlerStore();
    const svc = service(store, T0);
    await svc.stop();
    expect(store.closed).toBe(true);
  });
});
