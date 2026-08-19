import { readFile } from "node:fs/promises";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  BLOCK_RESPONSE_NAMES,
  RANGE_RESPONSE_NAMES,
  createBlockServer,
  handleRequest,
  parseFilterFromQuery,
  parseRangeFilterFromQuery,
  type RangeResponseRow,
  parseSenderStatsFilterFromQuery,
  parseTransactionFilterFromQuery,
  parseTransactionRecordsFilterFromQuery,
  type BlockInspectResponseBody,
  type BlockResponseRow,
  type BlocksResponseBody,
  type HealthResponseBody,
  type RangesResponseBody,
  type SendersResponseBody,
  type SyncStatusResponseBody,
  type TransactionByHashResponseBody,
  type TransactionRecordsResponseBody,
  type TransactionsResponseBody,
} from "./server";
import type { ArkivOperation, ArkivOperationSummaryEntry } from "./arkivOperations";
import { BaseloadRuntime } from "./baseloadRuntime";
import { type BaseloadConfig } from "./baseloadConfig";
import type { ScannerStorage, StoredTransactionRecord } from "./storage";
import { DEFAULT_RANGE_SIZE } from "./ranges";
import { PayloadProviderPaymentResolver } from "./payloadProviderPayments";
import {
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { BlockMetrics } from "./types";
import type { ScanSample } from "./syncStatus";

const RANGE_SIZE = DEFAULT_RANGE_SIZE;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

const cleanups: Array<() => Promise<void>> = [];

function blockNumbersFromRows(rows: BlockResponseRow[]): number[] {
  const blockNumberIndex = BLOCK_RESPONSE_NAMES.indexOf("blockNumber");
  return rows.map((row) => row[blockNumberIndex] as number);
}

function rangeValue(
  row: RangeResponseRow,
  name: (typeof RANGE_RESPONSE_NAMES)[number],
): number | string | null {
  return row[RANGE_RESPONSE_NAMES.indexOf(name)] ?? null;
}

async function readZstdJson<T>(response: Response): Promise<T> {
  const decompressed = Bun.zstdDecompressSync(Buffer.from(await response.arrayBuffer()));
  return JSON.parse(Buffer.from(decompressed).toString("utf8")) as T;
}

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

  test("defaults block queries to newest first when filters are absent", () => {
    const filter = parseFilterFromQuery(new URLSearchParams(""));
    expect(filter).toEqual({ order: "desc" });
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

  test("parses a valid limit", () => {
    const filter = parseFilterFromQuery(new URLSearchParams("limit=250"));
    expect(filter.limit).toBe(250);
  });

  test("honors explicit ascending block order", () => {
    const filter = parseFilterFromQuery(new URLSearchParams("order=asc"));
    expect(filter.order).toBe("asc");
  });

  test("rejects an invalid order", () => {
    expect(() => parseFilterFromQuery(new URLSearchParams("order=newest"))).toThrow(
      /order must be either asc or desc/,
    );
  });

  test("rejects a non-numeric limit", () => {
    expect(() => parseFilterFromQuery(new URLSearchParams("limit=abc"))).toThrow(
      /limit must be a positive integer/,
    );
  });

  test("rejects zero limit", () => {
    expect(() => parseFilterFromQuery(new URLSearchParams("limit=0"))).toThrow(
      /limit must be a positive integer/,
    );
  });

  test("rejects a limit greater than the hard cap", () => {
    expect(() => parseFilterFromQuery(new URLSearchParams("limit=10001"))).toThrow(
      /limit must be at most 10000/,
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

  test("defaults range queries to newest first and omits rangeSize when absent", () => {
    const filter = parseRangeFilterFromQuery(new URLSearchParams(""));
    expect(filter.rangeSize).toBeUndefined();
    expect(filter.order).toBe("desc");
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

  test("parses a valid limit", () => {
    const filter = parseRangeFilterFromQuery(new URLSearchParams("limit=42"));
    expect(filter.limit).toBe(42);
  });

  test("honors explicit ascending range order", () => {
    const filter = parseRangeFilterFromQuery(new URLSearchParams("order=asc"));
    expect(filter.order).toBe("asc");
  });

  test("rejects an invalid order", () => {
    expect(() => parseRangeFilterFromQuery(new URLSearchParams("order=newest"))).toThrow(
      /order must be either asc or desc/,
    );
  });

  test("rejects a limit greater than the hard cap", () => {
    expect(() =>
      parseRangeFilterFromQuery(new URLSearchParams("limit=10001")),
    ).toThrow(/limit must be at most 10000/);
  });
});

describe("parseTransactionFilterFromQuery", () => {
  test("parses exact block, range, date, limit, and order filters", () => {
    const filter = parseTransactionFilterFromQuery(
      new URLSearchParams(
        "block=42&blockGt=10&blockLt=50&address=0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&nonceGt=3&nonceLt=9&dateGt=2024-01-01T00:00:00Z&dateLt=2024-01-02T00:00:00Z&limit=25&page=2&order=desc",
      ),
    );

    expect(filter.blockNumber).toBe(42n);
    expect(filter.blockGt).toBe(10n);
    expect(filter.blockLt).toBe(50n);
    expect(filter.fromAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(filter.nonceGt).toBe(3n);
    expect(filter.nonceLt).toBe(9n);
    expect(filter.dateGt).toBe("2024-01-01T00:00:00.000Z");
    expect(filter.dateLt).toBe("2024-01-02T00:00:00.000Z");
    expect(filter.limit).toBe(25);
    expect(filter.page).toBe(2);
    expect(filter.order).toBe("desc");
  });

  test("defaults transaction queries to newest first", () => {
    const filter = parseTransactionFilterFromQuery(new URLSearchParams(""));
    expect(filter.order).toBe("desc");
  });

  test("honors explicit ascending transaction order", () => {
    const filter = parseTransactionFilterFromQuery(new URLSearchParams("order=asc"));
    expect(filter.order).toBe("asc");
  });

  test("rejects transaction limits above 1000", () => {
    expect(() =>
      parseTransactionFilterFromQuery(new URLSearchParams("limit=1001")),
    ).toThrow(/limit must be at most 1000/);
  });

  test("rejects invalid address and page filters", () => {
    expect(() =>
      parseTransactionFilterFromQuery(new URLSearchParams("address=0x1234")),
    ).toThrow(/address must be a 20-byte hex address/);
    expect(() =>
      parseTransactionFilterFromQuery(new URLSearchParams("page=0")),
    ).toThrow(/page must be a positive integer/);
  });
});

describe("parseTransactionRecordsFilterFromQuery", () => {
  test("parses record limits", () => {
    const filter = parseTransactionRecordsFilterFromQuery(new URLSearchParams("limit=12"));
    expect(filter.limit).toBe(12);
  });

  test("rejects record limits above the response cap", () => {
    expect(() =>
      parseTransactionRecordsFilterFromQuery(new URLSearchParams("limit=21")),
    ).toThrow(/limit must be at most 20/);
  });
});

describe("zstd JSON compression", () => {
  test("compresses block list responses when zstd is accepted", async () => {
    const storage = {
      queryBlocks: async () => [],
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/blocks?limit=1", {
        headers: { "accept-encoding": "gzip, zstd" },
      }),
      storage,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("zstd");
    const body = await readZstdJson<BlocksResponseBody>(response);
    expect(body.blocks).toEqual([]);
    expect(body.names).toEqual(BLOCK_RESPONSE_NAMES);
  });

  test("compresses range list responses when zstd is accepted", async () => {
    const storage = {
      queryBlockRanges: async () => [],
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/ranges?limit=1", {
        headers: { "accept-encoding": "zstd" },
      }),
      storage,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("zstd");
    const body = await readZstdJson<RangesResponseBody>(response);
    expect(body.ranges).toEqual([]);
    expect(body.names).toEqual(RANGE_RESPONSE_NAMES);
  });

  test("does not compress when zstd is explicitly refused", async () => {
    const storage = {
      queryBlocks: async () => [],
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/blocks?limit=1", {
        headers: { "accept-encoding": "zstd;q=0, gzip" },
      }),
      storage,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    const body = (await response.json()) as BlocksResponseBody;
    expect(body.blocks).toEqual([]);
  });
});

describe("parseSenderStatsFilterFromQuery", () => {
  test("defaults sender stats to most active first", () => {
    const filter = parseSenderStatsFilterFromQuery(new URLSearchParams(""));
    expect(filter.order).toBe("desc");
  });

  test("parses sender stats limit and order", () => {
    const filter = parseSenderStatsFilterFromQuery(new URLSearchParams("limit=25&order=asc"));
    expect(filter.limit).toBe(25);
    expect(filter.order).toBe("asc");
  });

  test("rejects sender stats limits above the hard cap", () => {
    expect(() =>
      parseSenderStatsFilterFromQuery(new URLSearchParams("limit=10001")),
    ).toThrow(/limit must be at most 10000/);
  });
});

describe("GET /blocks/:blockNumber", () => {
  test("returns 404 when the block is not stored", async () => {
    const storage = {
      queryBlocks: async () => [],
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/blocks/42"),
      storage,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Block 42 was not found in storage",
    });
  });

  test("returns the single stored block when present", async () => {
    const storage = {
      queryBlocks: async (filter: { blockGt?: bigint; blockLt?: bigint; limit?: number }) => {
        expect(filter.blockGt).toBe(41n);
        expect(filter.blockLt).toBe(43n);
        expect(filter.limit).toBe(1);
        return [
          {
            blockNumber: 42,
            blockDate: "2024-01-01T00:00:00.000Z",
            baseBlockFeeWei: "100",
            totalGasUsed: "21000",
            maxGasInBlock: "30000000",
            transactionCount: 0,
          },
        ];
      },
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/blocks/42"),
      storage,
    );
    const body = (await response.json()) as BlockResponseRow;

    expect(response.status).toBe(200);
    expect(body[BLOCK_RESPONSE_NAMES.indexOf("blockNumber")]).toBe(42);
    expect(body[BLOCK_RESPONSE_NAMES.indexOf("blockDate")]).toBe("2024-01-01T00:00:00.000Z");
  });

  test("rejects non-numeric block numbers via the catch-all 404", async () => {
    const response = await handleRequest(
      new Request("http://example.test/blocks/not-a-number"),
      {} as ScannerStorage,
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /blocks", () => {
  test("returns column names and block value rows", async () => {
    const storage = {
      queryBlocks: async () => [
        {
          blockNumber: 42,
          blockDate: "2024-01-01T00:00:00.000Z",
          blockTimeSeconds: "2",
          baseBlockFeeWei: "100",
          totalGasUsed: "21000",
          maxGasInBlock: "30000000",
          transactionCount: 1,
          averageFeePriceWei: "100",
          averageTransactionFeeWei: "2100000",
          averageTransactionGasUsed: "21000",
          averagePriorityFeeWeightedWei: "0",
          averagePriorityFeeWei: "0",
        },
      ],
    } as unknown as ScannerStorage;

    const response = await handleRequest(new Request("http://example.test/blocks"), storage);
    const body = (await response.json()) as BlocksResponseBody;

    expect(response.status).toBe(200);
    expect(body.names).toEqual(BLOCK_RESPONSE_NAMES);
    expect(body.blocks).toEqual([
      [
        42,
        "2024-01-01T00:00:00.000Z",
        "2",
        "100",
        "21000",
        null,
        null,
        "30000000",
        1,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "100",
        "2100000",
        "21000",
        null,
        null,
        "0",
        "0",
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    ]);
  });
});

describe("GET /llms.txt", () => {
  test("serves the repository llms.txt as plain text", async () => {
    const response = await handleRequest(
      new Request("http://example.test/llms.txt"),
      {} as ScannerStorage,
    );
    const expected = await readFile(new URL("../llms.txt", import.meta.url), "utf8");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toBe(expected);
  });
});

describe("GET /block/:blockNumber", () => {
  test("returns 404 when the block is not stored", async () => {
    const storage = {
      getInspectedBlock: async () => undefined,
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/block/42"),
      storage,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Block 42 was not found in storage",
    });
  });

  test("returns inspected block data from storage", async () => {
    const storage = {
      getInspectedBlock: async (blockNumber: bigint) => ({
        blockNumber: Number(blockNumber),
        blockNumberDecimal: blockNumber.toString(),
        blockDate: "2024-01-01T00:00:00.000Z",
        baseBlockFeeWei: "100",
        totalGasUsed: "21000",
        maxGasInBlock: "30000000",
        transactionCount: 0,
        transactions: [],
      }),
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/block/42"),
      storage,
    );
    const body = (await response.json()) as BlockInspectResponseBody;

    expect(response.status).toBe(200);
    expect(body.cached).toBe(false);
    expect(body.block.blockNumberDecimal).toBe("42");
  });

  test("returns 404 when transaction data is disabled", async () => {
    const response = await handleRequest(
      new Request("http://example.test/block/42"),
      {} as ScannerStorage,
      { transactionDataEnabled: false },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Transaction data is disabled",
    });
  });
});

describe("Baseload API", () => {
  test("returns backend baseload state", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload"),
      {} as ScannerStorage,
      { baseloadRuntime: runtime },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: false,
      config: { version: 2, workers: [] },
      statuses: {},
    });
  });

  test("updates backend baseload config", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workers: [{ walletNumber: 0 }] }),
      }),
      {} as ScannerStorage,
      { baseloadRuntime: runtime },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.config.workers).toHaveLength(1);
    expect(body.config.workers[0].walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    runtime.stop();
  });

  test("keeps backend baseload state public when admin bearer is configured", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload"),
      {} as ScannerStorage,
      { baseloadRuntime: runtime, baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: false,
      config: { version: 2, workers: [] },
      statuses: {},
    });
    runtime.stop();
  });

  test("requires admin bearer for backend baseload updates when configured", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workers: [{ walletNumber: 0 }] }),
      }),
      {} as ScannerStorage,
      { baseloadRuntime: runtime, baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Admin bearer token is required",
    });
    runtime.stop();
  });

  test("rejects invalid backend baseload admin bearer tokens", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload", {
        method: "PUT",
        headers: {
          "authorization": "Bearer wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workers: [{ walletNumber: 0 }] }),
      }),
      {} as ScannerStorage,
      { baseloadRuntime: runtime, baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Admin bearer token is invalid",
    });
    runtime.stop();
  });

  test("accepts valid backend baseload admin bearer tokens", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload", {
        method: "PUT",
        headers: {
          "authorization": "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workers: [{ walletNumber: 0 }] }),
      }),
      {} as ScannerStorage,
      { baseloadRuntime: runtime, baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.config.workers).toHaveLength(1);
    runtime.stop();
  });

  test("requires admin bearer for saved baseload config endpoints", async () => {
    const response = await handleRequest(
      new Request("http://example.test/baseload/configs"),
      {
        listBaseloadConfigs: async () => [],
      } as unknown as ScannerStorage,
      { baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Admin bearer token is required",
    });
  });

  test("lists saved baseload configs when authorized", async () => {
    const response = await handleRequest(
      new Request("http://example.test/baseload/configs", {
        headers: { authorization: "Bearer secret" },
      }),
      {
        listBaseloadConfigs: async () => [
          {
            name: "low gas",
            workerCount: 2,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          },
        ],
      } as unknown as ScannerStorage,
      { baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      configs: [
        {
          name: "low gas",
          workerCount: 2,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("saves named baseload configs with backend normalization", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    let savedWorkerAddress = "";
    const response = await handleRequest(
      new Request("http://example.test/baseload/configs/low%20gas", {
        method: "PUT",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workers: [{ walletNumber: 0 }] }),
      }),
      {
        saveBaseloadConfig: async (name: string, config: BaseloadConfig) => {
          savedWorkerAddress = config.workers[0]?.walletAddress ?? "";
          return {
            name,
            workerCount: config.workers.length,
            config,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
          };
        },
      } as unknown as ScannerStorage,
      { baseloadRuntime: runtime, baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(200);
    expect(savedWorkerAddress).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    await expect(response.json()).resolves.toMatchObject({
      name: "low gas",
      workerCount: 1,
      config: { workers: [{ walletNumber: 0 }] },
    });
    runtime.stop();
  });

  test("loads saved baseload configs into the runtime", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const savedConfig = runtime.normalizeConfig({ workers: [{ walletNumber: 1 }] });
    const response = await handleRequest(
      new Request("http://example.test/baseload/configs/low%20gas/load", {
        method: "PUT",
        headers: { authorization: "Bearer secret" },
      }),
      {
        getBaseloadConfig: async () => ({
          name: "low gas",
          workerCount: 1,
          config: savedConfig,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        }),
      } as unknown as ScannerStorage,
      { baseloadRuntime: runtime, baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.config.workers[0].walletNumber).toBe(1);
    expect(runtime.getState().config.workers[0]?.walletNumber).toBe(1);
    runtime.stop();
  });

  test("deletes saved baseload configs when authorized", async () => {
    const response = await handleRequest(
      new Request("http://example.test/baseload/configs/low%20gas", {
        method: "DELETE",
        headers: { authorization: "Bearer secret" },
      }),
      {
        deleteBaseloadConfig: async (name: string) => name === "low gas",
      } as unknown as ScannerStorage,
      { baseloadAdminBearerToken: "secret" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deleted: true });
  });

  test("rejects invalid backend baseload configs", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const response = await handleRequest(
      new Request("http://example.test/baseload", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workers: [{ walletNumber: 2 }, { walletNumber: 2 }] }),
      }),
      {} as ScannerStorage,
      { baseloadRuntime: runtime },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Wallet 2 is already attached to another worker",
    });
  });

  test("requires admin bearer for baseload updates through the live server", async () => {
    const runtime = new BaseloadRuntime({ rpcUrl: null, mnemonic: TEST_MNEMONIC });
    const server = createBlockServer({} as ScannerStorage, {
      port: 0,
      hostname: "127.0.0.1",
      baseloadRuntime: runtime,
      baseloadAdminBearerToken: "secret",
    });

    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/baseload`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workers: [{ walletNumber: 0 }] }),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Admin bearer token is required",
      });
    } finally {
      runtime.stop();
      await server.stop();
    }
  });
});

describe("GET /transactions", () => {
  test("returns stored transactions and echoes filters", async () => {
    let queryFilter: unknown;
    const storage = {
      queryTransactions: async (filter: unknown) => {
        queryFilter = filter;
        return [
          {
            blockNumber: 42,
            blockNumberDecimal: "42",
            blockDate: "2024-01-01T00:00:00.000Z",
            baseBlockFeeWei: "100",
            position: 0,
            hash: "0xaaa",
            from: "0x111",
            to: "0x222",
            type: "2",
            nonce: "1",
            valueWei: "0",
            gasLimit: "21000",
            gasUsed: "21000",
            cumulativeGasUsed: "21000",
            gasPriceWei: "110",
            maxFeePerGasWei: "200",
            maxPriorityFeePerGasWei: "10",
            effectiveGasPriceWei: "110",
            priorityFeeWei: "10",
            transactionFeeWei: "2310000",
            status: "1",
            contractAddress: null,
          },
        ];
      },
      countTransactions: async () => 51,
      getOperationsSummaryForTransactions: async () => new Map(),
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request(
        "http://example.test/transactions?block=42&address=0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&nonceGt=0&nonceLt=5&limit=25&page=2",
      ),
      storage,
    );
    const body = (await response.json()) as TransactionsResponseBody;

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.limit).toBe(25);
    expect(body.page).toBe(2);
    expect(body.totalCount).toBe(51);
    expect(body.totalPages).toBe(3);
    expect(body.hasPreviousPage).toBe(true);
    expect(body.hasNextPage).toBe(true);
    expect(body.filters.block).toBe("42");
    expect(body.filters.address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body.filters.nonceGt).toBe("0");
    expect(body.filters.nonceLt).toBe("5");
    expect(body.transactions[0]?.blockNumber).toBe(42);
    expect(body.transactions[0]?.position).toBe(0);
    expect(body.transactions[0]?.operationsSummary).toBeUndefined();
    expect(queryFilter).toMatchObject({ order: "desc" });
  });

  test("attaches operationsSummary only to transactions with stored operations", async () => {
    let requestedKeys: unknown;
    const summary: ArkivOperationSummaryEntry[] = [
      { operation: "create", operationType: 1, count: 2 },
      { operation: "delete", operationType: 5, count: 1 },
    ];
    const storage = {
      queryTransactions: async () => [
        { ...storedTransactionFixture(), position: 0, hash: "0xaaa" },
        { ...storedTransactionFixture(), position: 1, hash: "0xbbb" },
      ],
      countTransactions: async () => 2,
      getOperationsSummaryForTransactions: async (keys: unknown) => {
        requestedKeys = keys;
        return new Map([["42:0", summary]]);
      },
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/transactions?block=42"),
      storage,
    );
    const body = (await response.json()) as TransactionsResponseBody;

    expect(response.status).toBe(200);
    expect(requestedKeys).toEqual([
      { blockNumber: "42", position: 0 },
      { blockNumber: "42", position: 1 },
    ]);
    expect(body.transactions[0]?.operationsSummary).toEqual(summary);
    expect(body.transactions[1]?.operationsSummary).toBeUndefined();
    expect(body.transactions[0]?.operations).toBeUndefined();
  });

  test("rejects invalid transaction filters", async () => {
    const response = await handleRequest(
      new Request("http://example.test/transactions?limit=1001"),
      {} as ScannerStorage,
    );

    expect(response.status).toBe(400);
  });

  test("returns 404 when transaction data is disabled", async () => {
    const response = await handleRequest(
      new Request("http://example.test/transactions?block=42"),
      {} as ScannerStorage,
      { transactionDataEnabled: false },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Transaction data is disabled",
    });
  });
});

describe("GET /transaction/:hash", () => {
  const hash = `0x${"ab".repeat(32)}` as `0x${string}`;

  test("attaches stored Arkiv operations to the transaction", async () => {
    const operations: ArkivOperation[] = [
      {
        opIndex: 0,
        operationType: 1,
        operation: "create",
        entityKey: `0x${"11".repeat(32)}`,
        contentType: "text/plain",
        payloadSizeBytes: 64,
        attributes: [{ key: "project", valueType: 2, valueTypeName: "string", value: "demo" }],
        expiresAtBlocks: 100,
        newOwner: null,
        isReference: false,
        payloadReference: null,
        referenceVerification: null,
        referenceError: null,
      },
    ];
    const requestedHashes: string[] = [];
    const storage = {
      getTransactionByHash: async (requested: string) => ({
        ...storedTransactionFixture(),
        hash: requested,
      }),
      getOperationsByHash: async (requested: string) => {
        requestedHashes.push(requested);
        return operations;
      },
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request(`http://example.test/transaction/${hash}`),
      storage,
    );
    const body = (await response.json()) as TransactionByHashResponseBody;

    expect(response.status).toBe(200);
    expect(requestedHashes).toEqual([hash]);
    expect(body.transaction.hash).toBe(hash);
    expect(body.transaction.operations).toEqual(operations);
  });

  test("attaches payload provider payment breakdown to reference transactions", async () => {
    const operations: ArkivOperation[] = [
      {
        opIndex: 0,
        operationType: 1,
        operation: "create",
        entityKey: `0x${"11".repeat(32)}`,
        contentType: "application/vnd.atlas.payload-reference+json",
        payloadSizeBytes: 64,
        attributes: [],
        expiresAtBlocks: 100,
        newOwner: null,
        isReference: true,
        payloadReference: {
          kind: "atlas.payloadReference",
          version: 1,
          provider: "atlas-payload-provider",
          id: "a".repeat(64),
          namespace: "atlas.test",
          checksum: `sha256:${"b".repeat(64)}`,
          sizeBytes: 64,
          submittedAt: "2026-06-24T15:24:30Z",
          nonce: `0x${"00".repeat(31)}01`,
          payment: 1000,
          signature: {
            scheme: "eip191",
            signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
            receipt: {},
            messageHash: `0x${"cd".repeat(32)}`,
            signature: `0x${"ef".repeat(65)}`,
            r: `0x${"11".repeat(32)}`,
            s: `0x${"22".repeat(32)}`,
            v: 27,
          },
        },
        referenceVerification: {
          valid: true,
          signerTrusted: true,
          chainId: 42069,
          claimedSigner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
          recoveredSigner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
          messageHash: `0x${"cd".repeat(32)}`,
          errors: [],
        },
        referenceError: null,
      },
    ];
    const storage = {
      getTransactionByHash: async () => ({ ...storedTransactionFixture(), blockNumberDecimal: "123" }),
      getOperationsByHash: async () => operations,
    } as unknown as ScannerStorage;
    const resolver = new PayloadProviderPaymentResolver({ providerShareBps: 7000 });

    const response = await handleRequest(
      new Request(`http://example.test/transaction/${hash}`),
      storage,
      { payloadProviderPaymentResolver: resolver },
    );
    const body = (await response.json()) as TransactionByHashResponseBody;

    expect(response.status).toBe(200);
    expect(body.transaction.payloadProviderPayments).toMatchObject({
      enabled: true,
      providerShareBps: 7000,
      totalPaymentGasUnits: "1000",
      totalPaymentWei: "100000",
      totalProviderEarnedWei: "70000",
      totalBurnedWei: "30000",
      source: "configuredShareBps",
    });
  });

  test("returns an empty operations array when none are stored", async () => {
    const storage = {
      getTransactionByHash: async () => storedTransactionFixture(),
      getOperationsByHash: async () => [],
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request(`http://example.test/transaction/${hash}`),
      storage,
    );
    const body = (await response.json()) as TransactionByHashResponseBody;

    expect(response.status).toBe(200);
    expect(body.transaction.operations).toEqual([]);
  });

  test("returns 404 when the transaction is unknown", async () => {
    const storage = {
      getTransactionByHash: async () => null,
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request(`http://example.test/transaction/${hash}`),
      storage,
    );

    expect(response.status).toBe(404);
  });
});

describe("GET /transaction-records", () => {
  test("returns grouped record transactions while transaction data is disabled", async () => {
    let queryFilter: unknown;
    const storage = {
      queryTransactionRecords: async (filter: unknown) => {
        queryFilter = filter;
        return {
          gas_used: [
            {
              ...transactionRecordFixture(),
              category: "gas_used",
              recordValue: "30000",
              gasUsed: "30000",
            },
          ],
          transaction_fee: [
            {
              ...transactionRecordFixture(),
              category: "transaction_fee",
              recordValue: "9000000",
              transactionFeeWei: "9000000",
            },
          ],
          effective_fee: [
            {
              ...transactionRecordFixture(),
              category: "effective_fee",
              recordValue: "300",
              effectiveGasPriceWei: "300",
            },
          ],
        };
      },
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/transaction-records?limit=10"),
      storage,
      { transactionDataEnabled: false },
    );
    const body = (await response.json()) as TransactionRecordsResponseBody;

    expect(response.status).toBe(200);
    expect(queryFilter).toEqual({ limit: 10 });
    expect(body.limit).toBe(10);
    expect(body.records.gas_used[0]?.recordValue).toBe("30000");
    expect(body.records.transaction_fee[0]?.recordValue).toBe("9000000");
    expect(body.records.effective_fee[0]?.recordValue).toBe("300");
  });

  test("rejects invalid record limits", async () => {
    const response = await handleRequest(
      new Request("http://example.test/transaction-records?limit=21"),
      {} as ScannerStorage,
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /senders", () => {
  test("returns sender stats ordered by activity and echoes filters", async () => {
    let queryFilter: unknown;
    const storage = {
      querySenderStats: async (filter: unknown) => {
        queryFilter = filter;
        return [
          {
            address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            latestNonce: "8",
            transactionCount: "2",
            totalGasUsed: "63000",
            totalTransactionFeeWei: "6930000",
            totalValueWei: "3000",
            averageGasUsed: "31500",
            averageTransactionFeeWei: "3465000",
            firstBlockNumber: 100,
            firstBlockNumberDecimal: "100",
            lastBlockNumber: 101,
            lastBlockNumberDecimal: "101",
            firstBlockDate: "2024-01-01T00:00:00.000Z",
            lastBlockDate: "2024-01-02T00:00:00.000Z",
            aggregatedAt: "2024-01-02T00:00:01.000Z",
          },
        ];
      },
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/senders?limit=25"),
      storage,
    );
    const body = (await response.json()) as SendersResponseBody;

    expect(response.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.limit).toBe(25);
    expect(body.truncated).toBe(false);
    expect(body.filters.order).toBe("desc");
    expect(body.senders[0]?.address).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(body.senders[0]?.transactionCount).toBe("2");
    expect(queryFilter).toEqual({ limit: 25, order: "desc" });
  });

  test("rejects invalid sender filters", async () => {
    const response = await handleRequest(
      new Request("http://example.test/senders?limit=10001"),
      {} as ScannerStorage,
    );

    expect(response.status).toBe(400);
  });

  test("returns 404 when transaction data is disabled", async () => {
    const response = await handleRequest(
      new Request("http://example.test/senders"),
      {} as ScannerStorage,
      { transactionDataEnabled: false },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Transaction data is disabled",
    });
  });
});

describe("GET /health", () => {
  test("returns scanner progress and build metadata", async () => {
    const storage = {
      getScannerProgress: async () => ({
        lastSuccessfulBlock: 100n,
        lastSuccessfulBlockDate: "2024-01-01T00:00:00.000Z",
        lastSuccessfulScannedAt: "2024-01-01T00:00:05.000Z",
        backfillNextBlock: 90n,
        latestObservedBlock: 110n,
        safeHeadBlock: 107n,
        latestObservedAt: "2024-01-01T00:00:10.000Z",
      }),
      getForwardScanSamples: async () => [],
      getDatabaseStats: async () => ({
        totalSizeBytes: "65536",
        tables: [
          {
            tableName: "blocks",
            rowCount: "100",
            tableSizeBytes: "32768",
            indexesSizeBytes: "16384",
            totalSizeBytes: "49152",
          },
        ],
      }),
    } as unknown as ScannerStorage;

    const response = await handleRequest(new Request("http://example.test/health"), storage);
    const body = (await response.json()) as HealthResponseBody;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.serverTimeUtc).toMatch(/Z$/);
    expect(body.scanner.lastSuccessfulBlock).toBe("100");
    expect(body.scanner.backfillNextBlock).toBe("90");
    expect(body.scanner.latestObservedBlock).toBe("110");
    expect(body.scanner.safeHeadBlock).toBe("107");
    expect(body.scanner.headLagBlocks).toBe("10");
    expect(body.scanner.safeHeadLagBlocks).toBe("7");
    expect(body.scanner.lastBlockAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.features.transactionData).toBe(true);
    expect(body.sync.lagBlocks).toBe("10");
    expect(body.sync.state).toBe("stalled");
    expect(body.database.totalSizeBytes).toBe("65536");
    expect(body.database.tables[0]).toEqual({
      tableName: "blocks",
      rowCount: "100",
      tableSizeBytes: "32768",
      indexesSizeBytes: "16384",
      totalSizeBytes: "49152",
    });
  });

  test("reports disabled transaction data feature", async () => {
    const storage = {
      getScannerProgress: async () => ({}),
      getForwardScanSamples: async () => [],
      getDatabaseStats: async () => ({
        totalSizeBytes: "0",
        tables: [],
      }),
    } as unknown as ScannerStorage;

    const response = await handleRequest(
      new Request("http://example.test/health"),
      storage,
      { transactionDataEnabled: false },
    );
    const body = (await response.json()) as HealthResponseBody;

    expect(response.status).toBe(200);
    expect(body.features.transactionData).toBe(false);
  });
});

describe("GET /sync", () => {
  /** Storage double serving a scanner that trails the head but is closing in. */
  function catchingUpStorage(now: Date): ScannerStorage {
    const samples: ScanSample[] = [];
    for (let index = 100; index >= 0; index -= 1) {
      samples.push({
        blockNumber: BigInt(1000 - index),
        // Chain block time 2s; the scanner stores 10 blocks per second.
        blockDate: new Date(now.getTime() - 100_000 - index * 2000).toISOString(),
        scannedAtUtc: new Date(now.getTime() - index * 100).toISOString(),
      });
    }
    return {
      getScannerProgress: async () => ({
        lastSuccessfulBlock: 1000n,
        lastSuccessfulBlockDate: new Date(now.getTime() - 100_000).toISOString(),
        lastSuccessfulScannedAt: now.toISOString(),
        latestObservedBlock: 1050n,
        safeHeadBlock: 1047n,
        latestObservedAt: now.toISOString(),
      }),
      getForwardScanSamples: async () => samples,
    } as unknown as ScannerStorage;
  }

  test("reports lag, throughput, and an ETA", async () => {
    const response = await handleRequest(
      new Request("http://example.test/sync"),
      catchingUpStorage(new Date()),
    );
    const body = (await response.json()) as SyncStatusResponseBody;

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sync.state).toBe("catching-up");
    expect(body.sync.lagBlocks).toBe("50");
    // The rate window runs to "now", so the measurement drifts by the
    // milliseconds the request itself takes; assert the value, not the clock.
    expect(body.sync.scanBlocksPerSecond).toBeCloseTo(10, 1);
    expect(body.sync.chainBlockTimeSeconds).toBeCloseTo(2, 3);
    expect(body.sync.speedupFactor).toBeCloseTo(20, 1);
    expect(body.sync.etaSeconds).toBeCloseTo(50 / 9.5, 1);
    expect(body.sync.etaUtc).toMatch(/Z$/);
    expect(body.sync.summary).toContain("catching up");
  });

  test("is unknown for an empty database", async () => {
    const storage = {
      getScannerProgress: async () => ({}),
      getForwardScanSamples: async () => [],
    } as unknown as ScannerStorage;

    const response = await handleRequest(new Request("http://example.test/sync"), storage);
    const body = (await response.json()) as SyncStatusResponseBody;

    expect(body.sync.state).toBe("unknown");
    expect(body.sync.lagBlocks).toBeNull();
  });
});

if (!hasPostgresForTests()) {
  describe.skip("createBlockServer (skipped: set TEST_DATABASE_URL to run)", () => {});
} else {
  describe("createBlockServer", () => {
    test("returns newest stored blocks when no filters are supplied", async () => {
      const storage = await openStorageWithBlocks([1n, 2n, 3n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as BlocksResponseBody;
        expect(body.count).toBe(3);
        expect(body.limit).toBe(10_000);
        expect(body.truncated).toBe(false);
        expect(body.names).toEqual(BLOCK_RESPONSE_NAMES);
        expect(blockNumbersFromRows(body.blocks)).toEqual([3, 2, 1]);
        expect(body.filters).toEqual({ blockGt: null, blockLt: null, dateGt: null, dateLt: null });
      });
    });

    test("honors the limit query parameter and reports truncation", async () => {
      const storage = await openStorageWithBlocks([1n, 2n, 3n, 4n, 5n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks?limit=2`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as BlocksResponseBody;
        expect(body.count).toBe(2);
        expect(body.limit).toBe(2);
        expect(body.truncated).toBe(true);
        expect(blockNumbersFromRows(body.blocks)).toEqual([5, 4]);
      });
    });

    test("honors ascending block order for limited windows", async () => {
      const storage = await openStorageWithBlocks([1n, 2n, 3n, 4n, 5n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks?limit=2&order=asc`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as BlocksResponseBody;
        expect(blockNumbersFromRows(body.blocks)).toEqual([1, 2]);
      });
    });

    test("returns 400 for a limit above the hard cap", async () => {
      const storage = await openStorageWithBlocks([1n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks?limit=10001`);
        expect(response.status).toBe(400);
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
        expect(blockNumbersFromRows(body.blocks)).toEqual([12, 11]);
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
        expect(body.names).toEqual(RANGE_RESPONSE_NAMES);
        expect(body.ranges.map((row) => rangeValue(row, "rangeStart"))).toEqual([100]);
        expect(rangeValue(body.ranges[0]!, "minBaseFeeWei")).toBe("100");
        expect(rangeValue(body.ranges[0]!, "maxBaseFeeWei")).toBe("100");
        expect(rangeValue(body.ranges[0]!, "minMaxGasInBlock")).toBe("30000000");
        expect(rangeValue(body.ranges[0]!, "maxMaxGasInBlock")).toBe("30000000");
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
        expect(body.ranges.map((row) => rangeValue(row, "rangeStart"))).toEqual([100, 50, 0]);
        expect(body.ranges.every((row) => rangeValue(row, "rangeSize") === 50)).toBe(true);
        expect(body.filters.rangeSize).toBe("50");
      });
    });

    test("returns newest ranges first for limited windows", async () => {
      const storage = await withStorage();
      await saveCompleteRange(storage, 0n);
      await saveCompleteRange(storage, 100n);
      await saveCompleteRange(storage, 200n);

      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/ranges?limit=2`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as RangesResponseBody;
        expect(body.ranges.map((row) => rangeValue(row, "rangeStart"))).toEqual([200, 100]);
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
        expect(body.names).toEqual(RANGE_RESPONSE_NAMES);
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
        expect(body.names).toEqual(RANGE_RESPONSE_NAMES);
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
    blockTimeSeconds: "2",
    baseBlockFeeWei: "100",
    totalGasUsed: "21000",
    totalInputDataSizeBytes: "0",
    totalInputDataCompressedSizeBytes: "0",
    maxGasInBlock: "30000000",
    transactionCount: 1,
    blockRewardWei: "210000",
    burntFeesWei: "2100000",
    totalTransactionFeeWei: "2310000",
    feePriceSumWei: "110",
    priorityFeeSumWei: "10",
    priorityFeeWeightedNumeratorWei: "23100000",
    priorityFeeGasWeightedNumeratorWei: "210000",
    averageFeePriceWei: "110",
    averageTransactionFeeWei: "2310000",
    averageTransactionGasUsed: "21000",
    averageTransactionInputDataSizeBytes: "0",
    averageTransactionInputDataCompressedSizeBytes: "0",
    averagePriorityFeeWeightedWei: "10",
    averagePriorityFeeWei: "10",
    ...overrides,
  };
}

function storedTransactionFixture() {
  return {
    blockNumber: 42,
    blockNumberDecimal: "42",
    blockDate: "2024-01-01T00:00:00.000Z",
    baseBlockFeeWei: "100",
    position: 0,
    hash: "0xaaa",
    from: "0x111",
    to: "0x222",
    type: "2",
    nonce: "1",
    valueWei: "0",
    gasLimit: "21000",
    gasUsed: "21000",
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
    cumulativeGasUsed: "21000",
    gasPriceWei: "110",
    maxFeePerGasWei: "200",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "110",
    priorityFeeWei: "10",
    transactionFeeWei: "2310000",
    status: "1",
    contractAddress: null,
  };
}

function transactionRecordFixture(
  overrides: Partial<StoredTransactionRecord> = {},
): StoredTransactionRecord {
  return {
    category: "gas_used",
    recordValue: "21000",
    rank: 1,
    recordedAt: "2024-01-01T00:00:01.000Z",
    blockNumber: 42,
    blockNumberDecimal: "42",
    blockDate: "2024-01-01T00:00:00.000Z",
    baseBlockFeeWei: "100",
    position: 0,
    hash: "0xaaa",
    from: "0x111",
    to: "0x222",
    type: "2",
    nonce: "1",
    valueWei: "0",
    gasLimit: "21000",
    gasUsed: "21000",
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
    cumulativeGasUsed: "21000",
    gasPriceWei: "110",
    maxFeePerGasWei: "200",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "110",
    priorityFeeWei: "10",
    transactionFeeWei: "2310000",
    status: "1",
    contractAddress: null,
    ...overrides,
  };
}
