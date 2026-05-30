import { describe, expect, test } from "bun:test";
import {
  handleRequest,
  type GuzzlerHistoryResponseBody,
  type GuzzlersResponseBody,
  type HealthResponseBody,
} from "./server";
import {
  GUZZLER_CACHE_LIMIT,
  GuzzlerTracker,
  type GuzzlerBucket,
  type GuzzlerLeaderboards,
  type GuzzlerStore,
} from "./guzzlers";
import type { ScannerStorage } from "./storage";

const NOW = Date.now();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A single-transaction bucket landing in the minute that contains `timestampMs`. */
function bucket(timestampMs: number, gasUsed: string, feeWei = "0"): GuzzlerBucket {
  return {
    minute: Math.floor(timestampMs / MINUTE),
    transactionCount: 1,
    totalGasUsed: gasUsed,
    totalFeeWei: feeWei,
    firstSeenMs: timestampMs,
    lastSeenMs: timestampMs,
  };
}

/** Build the cached leaderboard the writer would publish for these senders. */
function boardFor(data: Map<string, GuzzlerBucket[]>, nowMs = NOW): GuzzlerLeaderboards {
  const tracker = new GuzzlerTracker();
  for (const [address, buckets] of data) {
    tracker.loadSender(address, buckets);
  }
  return tracker.getLeaderboards(nowMs, GUZZLER_CACHE_LIMIT);
}

class FakeGuzzlerStore implements GuzzlerStore {
  private readonly data: Map<string, GuzzlerBucket[]>;
  private readonly board: GuzzlerLeaderboards | null;

  constructor(data: Map<string, GuzzlerBucket[]>, options: { withBoard?: boolean } = {}) {
    this.data = data;
    this.board = options.withBoard === false ? null : boardFor(data);
  }

  async loadAll(): Promise<Map<string, GuzzlerBucket[]>> {
    return new Map([...this.data].map(([address, buckets]) => [address, buckets.map((b) => ({ ...b }))]));
  }
  async loadSender(address: string): Promise<GuzzlerBucket[] | null> {
    const buckets = this.data.get(address.toLowerCase());
    return buckets ? buckets.map((b) => ({ ...b })) : null;
  }
  async putSender(): Promise<void> {}
  async removeSenders(): Promise<void> {}
  async saveLeaderboards(): Promise<void> {}
  async loadLeaderboards(): Promise<GuzzlerLeaderboards | null> {
    return this.board;
  }
  async stats(): Promise<{ entryCount: number; totalBytes: number }> {
    let totalBytes = 0;
    for (const buckets of this.data.values()) {
      totalBytes += Buffer.byteLength(JSON.stringify(buckets), "utf8");
    }
    return { entryCount: this.data.size, totalBytes };
  }
  async close(): Promise<void> {}
}

const emptyStorage = {} as ScannerStorage;

/** A valid lowercase 20-byte hex address. */
const ADDRESS = `0x${"ab".repeat(20)}`;

describe("GET /guzzlers", () => {
  test("ranks active senders by gas used in every window", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        ["0xsmall", [bucket(NOW - 1000, "100", "10")]],
        ["0xbig", [bucket(NOW - 500, "900", "90")]],
      ]),
    );

    const response = await handleRequest(
      new Request("http://example.test/guzzlers"),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as GuzzlersResponseBody;
    expect(body.limit).toBe(100);
    expect(body.retentionMs).toBe(24 * HOUR);
    expect(body.windows.map((w) => w.label)).toEqual(["5m", "20m", "1h", "6h", "24h"]);

    // Both transactions are seconds old, so they appear in every window.
    for (const window of body.windows) {
      expect(window.count).toBe(2);
      expect(window.guzzlers.map((g) => g.address)).toEqual(["0xbig", "0xsmall"]);
      expect(window.guzzlers[0]).toMatchObject({ totalGasUsed: "900", transactionCount: 1 });
    }
  });

  test("omits senders whose buckets have aged past retention", async () => {
    const store = new FakeGuzzlerStore(
      new Map([["0xold", [bucket(NOW - 25 * HOUR, "100", "10")]]]),
    );

    const response = await handleRequest(
      new Request("http://example.test/guzzlers"),
      emptyStorage,
      { guzzlerStore: store },
    );
    const body = (await response.json()) as GuzzlersResponseBody;
    for (const window of body.windows) {
      expect(window.count).toBe(0);
      expect(window.guzzlers).toEqual([]);
    }
  });

  test("buckets a transaction only into the windows that contain it", async () => {
    // 2 hours old: outside 5m/20m/1h, inside 6h/24h.
    const store = new FakeGuzzlerStore(
      new Map([["0xmid", [bucket(NOW - 2 * HOUR, "100", "10")]]]),
    );

    const response = await handleRequest(
      new Request("http://example.test/guzzlers"),
      emptyStorage,
      { guzzlerStore: store },
    );
    const body = (await response.json()) as GuzzlersResponseBody;
    const counts = Object.fromEntries(body.windows.map((w) => [w.label, w.count]));
    expect(counts).toEqual({ "5m": 0, "20m": 0, "1h": 0, "6h": 1, "24h": 1 });
  });

  test("honours the limit query parameter", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        ["0xa", [bucket(NOW - 1000, "100", "10")]],
        ["0xb", [bucket(NOW - 1000, "200", "20")]],
        ["0xc", [bucket(NOW - 1000, "300", "30")]],
      ]),
    );

    const response = await handleRequest(
      new Request("http://example.test/guzzlers?limit=1"),
      emptyStorage,
      { guzzlerStore: store },
    );
    const body = (await response.json()) as GuzzlersResponseBody;
    expect(body.limit).toBe(1);
    const five = body.windows.find((w) => w.label === "5m");
    expect(five?.count).toBe(3);
    expect(five?.guzzlers.map((g) => g.address)).toEqual(["0xc"]);
  });

  test("rejects a limit above the 250 maximum", async () => {
    const store = new FakeGuzzlerStore(new Map());
    const response = await handleRequest(
      new Request("http://example.test/guzzlers?limit=251"),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "limit must be at most 250" });
  });

  test("serves an empty board before the first refresh", async () => {
    const store = new FakeGuzzlerStore(new Map(), { withBoard: false });
    const response = await handleRequest(
      new Request("http://example.test/guzzlers"),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as GuzzlersResponseBody;
    expect(body.windows.map((w) => w.label)).toEqual(["5m", "20m", "1h", "6h", "24h"]);
    for (const window of body.windows) {
      expect(window.count).toBe(0);
      expect(window.guzzlers).toEqual([]);
    }
  });

  test("returns 503 when guzzler tracking is disabled", async () => {
    const response = await handleRequest(new Request("http://example.test/guzzlers"), emptyStorage);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Guzzler tracking is disabled" });
  });
});

describe("GET /guzzler/:address", () => {
  test("returns a sender's minute-bucket history ordered oldest-first", async () => {
    const store = new FakeGuzzlerStore(
      new Map([
        [ADDRESS, [bucket(NOW - 2 * MINUTE, "200", "20"), bucket(NOW - 5 * MINUTE, "100", "10")]],
      ]),
    );

    const response = await handleRequest(
      new Request(`http://example.test/guzzler/${ADDRESS}`),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as GuzzlerHistoryResponseBody;
    expect(body.address).toBe(ADDRESS);
    expect(body.bucketMs).toBe(MINUTE);
    expect(body.retentionMs).toBe(24 * HOUR);
    expect(body.count).toBe(2);
    expect(body.points.map((p) => p.totalGasUsed)).toEqual(["100", "200"]);
    expect(body.points[0]?.startTime).toBe(
      new Date(Math.floor((NOW - 5 * MINUTE) / MINUTE) * MINUTE).toISOString(),
    );
  });

  test("uppercase addresses resolve to the same history", async () => {
    const store = new FakeGuzzlerStore(new Map([[ADDRESS, [bucket(NOW - MINUTE, "100", "10")]]]));

    const response = await handleRequest(
      new Request(`http://example.test/guzzler/${ADDRESS.toUpperCase().replace("0X", "0x")}`),
      emptyStorage,
      { guzzlerStore: store },
    );
    const body = (await response.json()) as GuzzlerHistoryResponseBody;
    expect(body.address).toBe(ADDRESS);
    expect(body.count).toBe(1);
  });

  test("omits buckets aged past retention", async () => {
    const store = new FakeGuzzlerStore(
      new Map([[ADDRESS, [bucket(NOW - 25 * HOUR, "999"), bucket(NOW - MINUTE, "100")]]]),
    );

    const response = await handleRequest(
      new Request(`http://example.test/guzzler/${ADDRESS}`),
      emptyStorage,
      { guzzlerStore: store },
    );
    const body = (await response.json()) as GuzzlerHistoryResponseBody;
    expect(body.points.map((p) => p.totalGasUsed)).toEqual(["100"]);
  });

  test("returns an empty history for an unknown sender", async () => {
    const store = new FakeGuzzlerStore(new Map());

    const response = await handleRequest(
      new Request(`http://example.test/guzzler/${ADDRESS}`),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as GuzzlerHistoryResponseBody;
    expect(body.address).toBe(ADDRESS);
    expect(body.count).toBe(0);
    expect(body.points).toEqual([]);
  });

  test("rejects an invalid address", async () => {
    const store = new FakeGuzzlerStore(new Map());
    const response = await handleRequest(
      new Request("http://example.test/guzzler/not-an-address"),
      emptyStorage,
      { guzzlerStore: store },
    );
    expect(response.status).toBe(400);
  });

  test("returns 503 when guzzler tracking is disabled", async () => {
    const response = await handleRequest(
      new Request(`http://example.test/guzzler/${ADDRESS}`),
      emptyStorage,
    );
    expect(response.status).toBe(503);
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
        ["0xa", [bucket(NOW, "100", "10")]],
        ["0xb", [bucket(NOW, "200", "20")]],
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
