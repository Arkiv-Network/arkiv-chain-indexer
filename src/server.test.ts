import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createBlockServer,
  parseFilterFromQuery,
  parseRangeFilterFromQuery,
  type BlocksResponseBody,
  type RangesResponseBody,
} from "./server";
import { type ScannerStorage } from "./storage";
import { DEFAULT_RANGE_SIZE } from "./ranges";
import {
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { BlockMetrics } from "./types";

const RANGE_SIZE = DEFAULT_RANGE_SIZE;

const cleanups: Array<() => Promise<void>> = [];

async function withStorage(): Promise<ScannerStorage> {
  const { storage, cleanup } = await createIsolatedStorage("server");
  cleanups.push(cleanup);
  return storage;
}

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending) {
    await cleanup();
  }
});

afterAll(async () => {
  await closeTestPools();
});

describe("parseFilterFromQuery", () => {
  test("parses all four filters", () => {
    const params = new URLSearchParams(
      "blockGt=10&blockLt=20&dateGt=2024-01-01T00:00:00Z&dateLt=2024-12-31T00:00:00Z",
    );
    const filter = parseFilterFromQuery(params);
    expect(filter.blockGt).toBe(10n);
    expect(filter.blockLt).toBe(20n);
    expect(filter.dateGt).toBe("2024-01-01T00:00:00.000Z");
    expect(filter.dateLt).toBe("2024-12-31T00:00:00.000Z");
  });

  test("omits absent filters", () => {
    const filter = parseFilterFromQuery(new URLSearchParams(""));
    expect(filter).toEqual({});
  });

  test("rejects non-numeric block params", () => {
    expect(() => parseFilterFromQuery(new URLSearchParams("blockGt=abc"))).toThrow(
      /blockGt must be a non-negative integer/,
    );
  });

  test("rejects invalid date params", () => {
    expect(() => parseFilterFromQuery(new URLSearchParams("dateGt=not-a-date"))).toThrow(
      /dateGt must be a valid ISO-8601 date string/,
    );
  });
});

describe("parseRangeFilterFromQuery", () => {
  test("parses range size, start, and date filters", () => {
    const filter = parseRangeFilterFromQuery(
      new URLSearchParams(
        "rangeSize=50&rangeStartGt=100&rangeStartLt=500&dateGt=2024-01-01T00:00:00Z&dateLt=2024-12-31T00:00:00Z",
      ),
    );
    expect(filter.rangeSize).toBe(50n);
    expect(filter.rangeStartGt).toBe(100n);
    expect(filter.rangeStartLt).toBe(500n);
    expect(filter.dateGt).toBe("2024-01-01T00:00:00.000Z");
    expect(filter.dateLt).toBe("2024-12-31T00:00:00.000Z");
  });

  test("omits rangeSize when absent", () => {
    const filter = parseRangeFilterFromQuery(new URLSearchParams(""));
    expect(filter.rangeSize).toBeUndefined();
  });

  test("rejects non-numeric range params", () => {
    expect(() =>
      parseRangeFilterFromQuery(new URLSearchParams("rangeStartGt=abc")),
    ).toThrow(/rangeStartGt must be a non-negative integer/);
  });

  test("rejects unsupported rangeSize values", () => {
    expect(() =>
      parseRangeFilterFromQuery(new URLSearchParams("rangeSize=7")),
    ).toThrow(/rangeSize/);
  });
});

if (!hasPostgresForTests()) {
  describe.skip("createBlockServer (skipped: set TEST_DATABASE_URL to run)", () => {
    test("placeholder", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("createBlockServer", () => {
    test("returns smallest stored blocks when no filters are supplied", async () => {
      const storage = await openStorageWithBlocks([1n, 2n, 3n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as BlocksResponseBody;
        expect(body.count).toBe(3);
        expect(body.limit).toBe(10_000);
        expect(body.truncated).toBe(false);
        expect(body.blocks.map((row) => row.blockNumber)).toEqual([1, 2, 3]);
        expect(body.filters).toEqual({ blockGt: null, blockLt: null, dateGt: null, dateLt: null });
      });
    });

    test("combines block and date filters additively", async () => {
      const storage = await withStorage();
      const samples = [
        { blockNumber: 10n, blockDate: "2024-01-10T00:00:00.000Z" },
        { blockNumber: 11n, blockDate: "2024-01-11T00:00:00.000Z" },
        { blockNumber: 12n, blockDate: "2024-01-12T00:00:00.000Z" },
        { blockNumber: 13n, blockDate: "2024-01-13T00:00:00.000Z" },
      ];
      for (const sample of samples) await storage.saveBlockMetrics(blockMetricsFixture(sample));

      await withServer(storage, async (url) => {
        const response = await fetch(
          `${url}/blocks?blockGt=10&blockLt=13&dateGt=2024-01-10T00:00:00Z`,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as BlocksResponseBody;
        expect(body.blocks.map((row) => row.blockNumber)).toEqual([11, 12]);
        expect(body.filters).toEqual({
          blockGt: "10",
          blockLt: "13",
          dateGt: "2024-01-10T00:00:00.000Z",
          dateLt: null,
        });
      });
    });

    test("returns 400 for invalid blockGt", async () => {
      const storage = await openStorageWithBlocks([1n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks?blockGt=abc`);
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error).toMatch(/blockGt/);
      });
    });

    test("returns 400 for invalid dateLt", async () => {
      const storage = await openStorageWithBlocks([1n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks?dateLt=not-a-date`);
        expect(response.status).toBe(400);
      });
    });

    test("returns 404 for unknown paths", async () => {
      const storage = await openStorageWithBlocks([1n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/unknown`);
        expect(response.status).toBe(404);
      });
    });

    test("returns 405 for non-GET methods", async () => {
      const storage = await openStorageWithBlocks([1n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks`, { method: "POST" });
        expect(response.status).toBe(405);
      });
    });
  });

  describe("GET /ranges", () => {
    test("returns aggregated ranges with filters echoed back", async () => {
      const storage = await withStorage();
      await saveCompleteRange(storage, 0n);
      await saveCompleteRange(storage, 100n);
      await saveCompleteRange(storage, 200n);

      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges?rangeStartGt=0&rangeStartLt=200`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as RangesResponseBody;
        expect(body.count).toBe(1);
        expect(body.limit).toBe(10_000);
        expect(body.truncated).toBe(false);
        expect(body.ranges.map((row) => row.rangeStart)).toEqual([100]);
        expect(body.filters).toEqual({
          rangeSize: "100",
          rangeStartGt: "0",
          rangeStartLt: "200",
          dateGt: null,
          dateLt: null,
        });
      });
    });

    test("filters by rangeSize and isolates rows of other sizes", async () => {
      const storage = await withStorage();
      for (let blockNumber = 0n; blockNumber < 200n; blockNumber += 1n) {
        await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
      }
      await storage.aggregateRangeIfComplete(0n, 50n);
      await storage.aggregateRangeIfComplete(50n, 50n);
      await storage.aggregateRangeIfComplete(100n, 50n);
      await storage.aggregateRangeIfComplete(0n, 100n);
      await storage.aggregateRangeIfComplete(100n, 100n);

      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges?rangeSize=50`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as RangesResponseBody;
        expect(body.ranges.map((row) => row.rangeStart)).toEqual([0, 50, 100]);
        expect(body.ranges.every((row) => row.rangeSize === 50)).toBe(true);
        expect(body.filters.rangeSize).toBe("50");
      });
    });

    test("returns empty list when no aggregates exist for the requested rangeSize", async () => {
      const storage = await withStorage();
      await saveCompleteRange(storage, 0n, 100n);

      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges?rangeSize=500`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as RangesResponseBody;
        expect(body.count).toBe(0);
        expect(body.ranges).toEqual([]);
        expect(body.filters.rangeSize).toBe("500");
      });
    });

    test("returns 400 for unsupported rangeSize values", async () => {
      const storage = await withStorage();
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges?rangeSize=7`);
        expect(response.status).toBe(400);
      });
    });

    test("returns 400 on invalid rangeStartGt", async () => {
      const storage = await withStorage();
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges?rangeStartGt=abc`);
        expect(response.status).toBe(400);
      });
    });

    test("returns empty list when no ranges match", async () => {
      const storage = await withStorage();
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as RangesResponseBody;
        expect(body.count).toBe(0);
        expect(body.ranges).toEqual([]);
      });
    });
  });
}

async function saveCompleteRange(
  storage: ScannerStorage,
  rangeStart: bigint,
  rangeSize: bigint = RANGE_SIZE,
): Promise<void> {
  for (let offset = 0n; offset < rangeSize; offset += 1n) {
    await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: rangeStart + offset }));
  }
  await storage.aggregateRangeIfComplete(rangeStart, rangeSize);
}

async function withServer(
  storage: ScannerStorage,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = createBlockServer(storage, { port: 0, hostname: "127.0.0.1" });
  try {
    await fn(`http://${server.hostname}:${server.port}`);
  } finally {
    await server.stop();
  }
}

async function openStorageWithBlocks(blockNumbers: bigint[]): Promise<ScannerStorage> {
  const storage = await withStorage();
  for (const blockNumber of blockNumbers) {
    await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
  }
  return storage;
}

function blockMetricsFixture(overrides: Partial<BlockMetrics> = {}): BlockMetrics {
  return {
    blockDate: "2024-01-01T00:00:00.000Z",
    blockNumber: 1n,
    baseBlockFeeWei: "100",
    totalGasUsed: "21000",
    maxGasInBlock: "30000000",
    transactionCount: 1,
    averageTransactionFeeWei: "2310000",
    averagePriorityFeeWeightedWei: "10",
    averagePriorityFeeWei: "10",
    ...overrides,
  };
}
