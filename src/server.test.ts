import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  createBlockServer,
  handleRequest,
  parseFilterFromQuery,
  parseRangeFilterFromQuery,
  parseSenderStatsFilterFromQuery,
  parseTransactionFilterFromQuery,
  parseTransactionRecordsFilterFromQuery,
  type BlockInspectResponseBody,
  type BlocksResponseBody,
  type HealthResponseBody,
  type RangesResponseBody,
  type SendersResponseBody,
  type TransactionRecordsResponseBody,
  type TransactionsResponseBody,
} from "./server";
import { BaseloadRuntime } from "./baseloadRuntime";
import { type BaseloadConfig } from "./baseloadConfig";
import type { ScannerStorage, StoredTransactionRecord } from "./storage";
import { DEFAULT_RANGE_SIZE } from "./ranges";
import {
  closeTestPools,
  createIsolatedStorage,
  hasPostgresForTests,
} from "./testPostgres";
import type { BlockMetrics } from "./types";

const RANGE_SIZE = DEFAULT_RANGE_SIZE;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

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
    const body = (await response.json()) as { blockNumber: number };

    expect(response.status).toBe(200);
    expect(body.blockNumber).toBe(42);
  });

  test("rejects non-numeric block numbers via the catch-all 404", async () => {
    const response = await handleRequest(
      new Request("http://example.test/blocks/not-a-number"),
      {} as ScannerStorage,
    );
    expect(response.status).toBe(404);
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
      config: { version: 1, workers: [] },
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
      config: { version: 1, workers: [] },
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
    expect(queryFilter).toMatchObject({ order: "desc" });
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
              recordValueWei: "30000",
              gasUsed: "30000",
            },
          ],
          transaction_fee: [
            {
              ...transactionRecordFixture(),
              category: "transaction_fee",
              recordValueWei: "9000000",
              transactionFeeWei: "9000000",
            },
          ],
          effective_fee: [
            {
              ...transactionRecordFixture(),
              category: "effective_fee",
              recordValueWei: "300",
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
    expect(body.records.gas_used[0]?.recordValueWei).toBe("30000");
    expect(body.records.transaction_fee[0]?.recordValueWei).toBe("9000000");
    expect(body.records.effective_fee[0]?.recordValueWei).toBe("300");
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

if (!hasPostgresForTests()) {
  describe.skip("createBlockServer (skipped: set TEST_DATABASE_URL to run)", () => {
    test("placeholder", () => {
      expect(true).toBe(true);
    });
  });
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
        expect(body.blocks.map((row) => row.blockNumber)).toEqual([3, 2, 1]);
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
        expect(body.blocks.map((row) => row.blockNumber)).toEqual([5, 4]);
      });
    });

    test("honors ascending block order for limited windows", async () => {
      const storage = await openStorageWithBlocks([1n, 2n, 3n, 4n, 5n]);
      await withServer(storage, async (url) => {
        const response = await fetch(`${url}/blocks?limit=2&order=asc`);
        expect(response.status).toBe(200);
        const body = (await response.json()) as BlocksResponseBody;
        expect(body.blocks.map((row) => row.blockNumber)).toEqual([1, 2]);
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
        expect(body.blocks.map((row) => row.blockNumber)).toEqual([12, 11]);
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
        expect(body.ranges[0]).toMatchObject({
          minBaseFeeWei: "100",
          maxBaseFeeWei: "100",
          minMaxGasInBlock: "30000000",
          maxMaxGasInBlock: "30000000",
        });
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
        expect(body.ranges.map((row) => row.rangeStart)).toEqual([100, 50, 0]);
        expect(body.ranges.every((row) => row.rangeSize === 50)).toBe(true);
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
        expect(body.ranges.map((row) => row.rangeStart)).toEqual([200, 100]);
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
    averagePriorityFeeWeightedWei: "10",
    averagePriorityFeeWei: "10",
    ...overrides,
  };
}

function transactionRecordFixture(
  overrides: Partial<StoredTransactionRecord> = {},
): StoredTransactionRecord {
  return {
    category: "gas_used",
    recordValueWei: "21000",
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
