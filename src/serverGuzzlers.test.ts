import { describe, expect, test } from "bun:test";
import { handleRequest, type GuzzlersResponseBody, type HealthResponseBody } from "./server";
import type { GuzzlerStore, GuzzlerTransaction } from "./guzzlers";
import type { ScannerStorage } from "./storage";

const NOW = Date.now();

class FakeGuzzlerStore implements GuzzlerStore {
  constructor(private readonly data: Map<string, GuzzlerTransaction[]>) {}
  async loadAll(): Promise<Map<string, GuzzlerTransaction[]>> {
    return new Map([...this.data].map(([address, txs]) => [address, txs.map((t) => ({ ...t }))]));
  }
  async putSender(): Promise<void> {}
  async removeSenders(): Promise<void> {}
  async stats(): Promise<{ entryCount: number; totalBytes: number }> {
    let totalBytes = 0;
    for (const txs of this.data.values()) {
      totalBytes += Buffer.byteLength(JSON.stringify(txs), "utf8");
    }
    return { entryCount: this.data.size, totalBytes };
  }
  async close(): Promise<void> {}
}

const emptyStorage = {} as ScannerStorage;

describe("GET /guzzlers", () => {
  test("returns active senders sorted by gas used", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        ["0xsmall", [{ hash: "0x1", timestampMs: NOW - 1000, gasUsed: "100", feeWei: "10" }]],
        ["0xbig", [{ hash: "0x2", timestampMs: NOW - 500, gasUsed: "900", feeWei: "90" }]],
      ]),
    );

    const response = await handleRequest(
      new Request("http://example.test/guzzlers"),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as GuzzlersResponseBody;
    expect(body.count).toBe(2);
    expect(body.windowMs).toBe(60 * 60 * 1000);
    expect(body.guzzlers.map((g) => g.address)).toEqual(["0xbig", "0xsmall"]);
    expect(body.guzzlers[0]).toMatchObject({ totalGasUsed: "900", transactionCount: 1 });
  });

  test("omits senders whose transactions have all aged out", async () => {
    const store = new FakeGuzzlerStore(
      new Map([["0xold", [{ hash: "0x1", timestampMs: NOW - 7_200_000, gasUsed: "100", feeWei: "10" }]]]),
    );

    const response = await handleRequest(
      new Request("http://example.test/guzzlers"),
      emptyStorage,
      { guzzlerStore: store },
    );
    const body = (await response.json()) as GuzzlersResponseBody;
    expect(body.count).toBe(0);
    expect(body.guzzlers).toEqual([]);
  });

  test("returns 503 when guzzler tracking is disabled", async () => {
    const response = await handleRequest(new Request("http://example.test/guzzlers"), emptyStorage);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Guzzler tracking is disabled" });
  });
});

describe("GET /health guzzlers feature flag", () => {
  const healthStorage = {
    getScannerProgress: async () => ({
      lastSuccessfulBlock: null,
      lastSuccessfulBlockDate: null,
      lastSuccessfulScannedAt: null,
      backfillNextBlock: null,
      latestObservedBlock: null,
      safeHeadBlock: null,
      latestObservedAt: null,
    }),
    getDatabaseStats: async () => ({ totalSizeBytes: "0", tables: [] }),
  } as unknown as ScannerStorage;

  test("reflects whether a guzzler store is configured", async () => {
    const withStore = await handleRequest(new Request("http://example.test/health"), healthStorage, {
      guzzlerStore: new FakeGuzzlerStore(new Map()),
    });
    expect(((await withStore.json()) as HealthResponseBody).features.guzzlers).toBe(true);

    const withoutStore = await handleRequest(new Request("http://example.test/health"), healthStorage);
    expect(((await withoutStore.json()) as HealthResponseBody).features.guzzlers).toBe(false);
  });

  test("reports guzzler cache entry count and size", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        ["0xa", [{ hash: "0x1", timestampMs: NOW, gasUsed: "100", feeWei: "10" }]],
        ["0xb", [{ hash: "0x2", timestampMs: NOW, gasUsed: "200", feeWei: "20" }]],
      ]),
    );
    const response = await handleRequest(new Request("http://example.test/health"), healthStorage, {
      guzzlerStore: store,
    });
    const body = (await response.json()) as HealthResponseBody;

    expect(body.guzzlers.enabled).toBe(true);
    expect(body.guzzlers.entryCount).toBe(2);
    expect(Number(body.guzzlers.totalSizeBytes)).toBeGreaterThan(0);
  });

  test("reports a disabled cache when no store is configured", async () => {
    const response = await handleRequest(new Request("http://example.test/health"), healthStorage);
    const body = (await response.json()) as HealthResponseBody;
    expect(body.guzzlers).toEqual({ enabled: false, entryCount: null, totalSizeBytes: null });
  });
});
