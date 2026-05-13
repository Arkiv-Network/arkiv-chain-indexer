import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBlockServer,
  parseFilterFromQuery,
  parseRangeFilterFromQuery,
  type BlocksResponseBody,
  type RangesResponseBody,
} from "./server";
import { ScannerStorage } from "./storage";
import { RANGE_SIZE } from "./ranges";
import type { BlockMetrics } from "./types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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

describe("createBlockServer", () => {
  test("returns smallest stored blocks when no filters are supplied", async () => {
    const storage = openStorageWithBlocks([1n, 2n, 3n]);
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
    storage.close();
  });

  test("combines block and date filters additively", async () => {
    const storage = ScannerStorage.open(tempDbPath());
    const samples = [
      { blockNumber: 10n, blockDate: "2024-01-10T00:00:00.000Z" },
      { blockNumber: 11n, blockDate: "2024-01-11T00:00:00.000Z" },
      { blockNumber: 12n, blockDate: "2024-01-12T00:00:00.000Z" },
      { blockNumber: 13n, blockDate: "2024-01-13T00:00:00.000Z" },
    ];
    for (const sample of samples) storage.saveBlockMetrics(blockMetricsFixture(sample));

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
    storage.close();
  });

  test("returns 400 for invalid blockGt", async () => {
    const storage = openStorageWithBlocks([1n]);
    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/blocks?blockGt=abc`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/blockGt/);
    });
    storage.close();
  });

  test("returns 400 for invalid dateLt", async () => {
    const storage = openStorageWithBlocks([1n]);
    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/blocks?dateLt=not-a-date`);
      expect(response.status).toBe(400);
    });
    storage.close();
  });

  test("returns 404 for unknown paths", async () => {
    const storage = openStorageWithBlocks([1n]);
    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/unknown`);
      expect(response.status).toBe(404);
    });
    storage.close();
  });

  test("returns 405 for non-GET methods", async () => {
    const storage = openStorageWithBlocks([1n]);
    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/blocks`, { method: "POST" });
      expect(response.status).toBe(405);
    });
    storage.close();
  });
});

describe("parseRangeFilterFromQuery", () => {
  test("parses range start and date filters", () => {
    const filter = parseRangeFilterFromQuery(
      new URLSearchParams(
        "rangeStartGt=100&rangeStartLt=500&dateGt=2024-01-01T00:00:00Z&dateLt=2024-12-31T00:00:00Z",
      ),
    );
    expect(filter.rangeStartGt).toBe(100n);
    expect(filter.rangeStartLt).toBe(500n);
    expect(filter.dateGt).toBe("2024-01-01T00:00:00.000Z");
    expect(filter.dateLt).toBe("2024-12-31T00:00:00.000Z");
  });

  test("rejects non-numeric range params", () => {
    expect(() =>
      parseRangeFilterFromQuery(new URLSearchParams("rangeStartGt=abc")),
    ).toThrow(/rangeStartGt must be a non-negative integer/);
  });
});

describe("GET /ranges", () => {
  test("returns aggregated ranges with filters echoed back", async () => {
    const storage = ScannerStorage.open(tempDbPath());
    saveCompleteRange(storage, 0n);
    saveCompleteRange(storage, 100n);
    saveCompleteRange(storage, 200n);

    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/ranges?rangeStartGt=0&rangeStartLt=200`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as RangesResponseBody;
      expect(body.count).toBe(1);
      expect(body.limit).toBe(10_000);
      expect(body.truncated).toBe(false);
      expect(body.ranges.map((row) => row.rangeStart)).toEqual([100]);
      expect(body.filters).toEqual({
        rangeStartGt: "0",
        rangeStartLt: "200",
        dateGt: null,
        dateLt: null,
      });
    });
    storage.close();
  });

  test("returns 400 on invalid rangeStartGt", async () => {
    const storage = ScannerStorage.open(tempDbPath());
    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/ranges?rangeStartGt=abc`);
      expect(response.status).toBe(400);
    });
    storage.close();
  });

  test("returns empty list when no ranges match", async () => {
    const storage = ScannerStorage.open(tempDbPath());
    await withServer(storage, async (url) => {
      const response = await fetch(`${url}/ranges`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as RangesResponseBody;
      expect(body.count).toBe(0);
      expect(body.ranges).toEqual([]);
    });
    storage.close();
  });
});

function saveCompleteRange(storage: ScannerStorage, rangeStart: bigint): void {
  for (let offset = 0n; offset < RANGE_SIZE; offset += 1n) {
    storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: rangeStart + offset }));
  }
  storage.aggregateRangeIfComplete(rangeStart);
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

function openStorageWithBlocks(blockNumbers: bigint[]): ScannerStorage {
  const storage = ScannerStorage.open(tempDbPath());
  for (const blockNumber of blockNumbers) {
    storage.saveBlockMetrics(blockMetricsFixture({ blockNumber }));
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

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gas-price-tracker-server-"));
  tempDirs.push(dir);
  return join(dir, "scanner.sqlite");
}
