import { afterEach, describe, expect, test } from "bun:test";
import {
  BLOCK_RESPONSE_NAMES,
  GUZZLER_HISTORY_POINT_RESPONSE_NAMES,
  GUZZLER_STAT_RESPONSE_NAMES,
  RANGE_RESPONSE_NAMES,
  fetchBlockByNumber,
  fetchLatestBlockInspect,
  deleteBaseloadConfig,
  fetchBlocks,
  fetchBlockInspect,
  fetchBaseloadConfigs,
  fetchBaseloadState,
  fetchGuzzlerHistory,
  fetchGuzzlers,
  fetchRanges,
  fetchTransactionRecords,
  fetchSenders,
  loadBaseloadConfig,
  saveBaseloadConfig,
  updateBaseloadConfig,
} from "./src/api";
import { EMPTY_BASELOAD_CONFIG } from "./src/baseloadConfig";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("frontend API helpers", () => {
  test("does not attach admin bearer tokens to readonly baseload requests", async () => {
    let observedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({
        enabled: true,
        config: EMPTY_BASELOAD_CONFIG,
        statuses: {},
        balances: {},
      });
    }) as typeof fetch;

    await fetchBaseloadState();

    expect(observedHeaders?.get("authorization")).toBeNull();
  });

  test("attaches admin bearer tokens to baseload updates", async () => {
    let observedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({
        enabled: true,
        config: EMPTY_BASELOAD_CONFIG,
        statuses: {},
        balances: {},
      });
    }) as typeof fetch;

    await updateBaseloadConfig(EMPTY_BASELOAD_CONFIG, "secret");

    expect(observedHeaders?.get("authorization")).toBe("Bearer secret");
    expect(observedHeaders?.get("content-type")).toBe("application/json");
  });

  test("attaches admin bearer tokens to saved config management requests", async () => {
    const observed: Array<{ input: string; method: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observed.push({
        input: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      if (String(input).endsWith("/baseload/configs")) {
        return Response.json({ configs: [] });
      }
      if (String(input).endsWith("/load")) {
        return Response.json({
          enabled: true,
          config: EMPTY_BASELOAD_CONFIG,
          statuses: {},
          balances: {},
        });
      }
      return Response.json({
        name: "low gas",
        workerCount: 0,
        config: EMPTY_BASELOAD_CONFIG,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        deleted: true,
      });
    }) as typeof fetch;

    await fetchBaseloadConfigs("secret");
    await saveBaseloadConfig("low gas", EMPTY_BASELOAD_CONFIG, "secret");
    await loadBaseloadConfig("low gas", "secret");
    await deleteBaseloadConfig("low gas", "secret");

    expect(observed).toEqual([
      { input: "/api/baseload/configs", method: "GET", authorization: "Bearer secret" },
      { input: "/api/baseload/configs/low%20gas", method: "PUT", authorization: "Bearer secret" },
      { input: "/api/baseload/configs/low%20gas/load", method: "PUT", authorization: "Bearer secret" },
      { input: "/api/baseload/configs/low%20gas", method: "DELETE", authorization: "Bearer secret" },
    ]);
  });

  test("fetches sender stats with query parameters", async () => {
    let observedInput = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInput = String(input);
      return Response.json({
        count: 0,
        limit: 25,
        truncated: false,
        filters: { order: "desc" },
        senders: [],
      });
    }) as typeof fetch;

    await fetchSenders(new URLSearchParams("limit=25&order=desc"));

    expect(observedInput).toBe("/api/senders?limit=25&order=desc");
  });

  test("fetches transaction records with query parameters", async () => {
    let observedInput = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInput = String(input);
      return Response.json({
        limit: 20,
        records: {
          gas_used: [],
          transaction_fee: [],
          effective_fee: [],
        },
      });
    }) as typeof fetch;

    await fetchTransactionRecords(new URLSearchParams("limit=20"));

    expect(observedInput).toBe("/api/transaction-records?limit=20");
  });

  test("reports debug metadata for block range requests", async () => {
    const body = JSON.stringify({
      count: 0,
      limit: 1,
      truncated: false,
      filters: { blockGt: null, blockLt: null, dateGt: null, dateLt: null },
      names: BLOCK_RESPONSE_NAMES,
      blocks: [],
    });
    const samples: Array<{
      ok: boolean;
      status: number | null;
      durationMs: number;
      transferredBytes: number;
    }> = [];
    let observedInput = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInput = String(input);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await fetchBlocks(new URLSearchParams("limit=1"), (sample) =>
      samples.push(sample),
    );

    expect(observedInput).toBe("/api/blocks?limit=1");
    expect(result.blocks).toEqual([]);
    expect(samples).toHaveLength(1);
    expect(samples[0].ok).toBe(true);
    expect(samples[0].status).toBe(200);
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(samples[0].transferredBytes).toBe(new TextEncoder().encode(body).length);
  });

  test("decodes compact block list responses into stored block objects", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        count: 1,
        limit: 1,
        truncated: false,
        filters: { blockGt: null, blockLt: null, dateGt: null, dateLt: null },
        names: BLOCK_RESPONSE_NAMES,
        blocks: [compactBlockRow(42)],
      })) as typeof fetch;

    const result = await fetchBlocks(new URLSearchParams("limit=1"));

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      blockNumber: 42,
      blockDate: "2024-01-01T00:00:00.000Z",
      blockTimeSeconds: "0",
      baseBlockFeeWei: "0",
      totalGasUsed: "0",
      maxGasInBlock: "0",
      transactionCount: 1,
      averagePriorityFeeWei: "0",
    });
  });

  test("decodes compact single-block rows", async () => {
    globalThis.fetch = (async () => Response.json(compactBlockRow(43))) as typeof fetch;

    const result = await fetchBlockByNumber(43);

    expect(result?.blockNumber).toBe(43);
    expect(result?.blockDate).toBe("2024-01-01T00:00:00.000Z");
    expect(result?.blockTimeSeconds).toBe("0");
  });

  test("uses latest block list names for compact single-block rows", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          count: 1,
          limit: 1,
          truncated: false,
          filters: { blockGt: null, blockLt: null, dateGt: null, dateLt: null },
          names: ["blockDate", "blockNumber"],
          blocks: [["2024-01-02T00:00:00.000Z", 44]],
        });
      }
      return Response.json(["2024-01-03T00:00:00.000Z", 45]);
    }) as typeof fetch;

    await fetchBlocks(new URLSearchParams("limit=1"));
    const result = await fetchBlockByNumber(45);

    expect(result?.blockNumber).toBe(45);
    expect(result?.blockDate).toBe("2024-01-03T00:00:00.000Z");
  });

  test("counts missing block debug probes as successful requests", async () => {
    const body = "not found";
    const samples: Array<{
      ok: boolean;
      status: number | null;
      durationMs: number;
      transferredBytes: number;
    }> = [];
    globalThis.fetch = (async () => new Response(body, { status: 404 })) as typeof fetch;

    const result = await fetchBlockByNumber(43, (sample) => samples.push(sample));

    expect(result).toBeNull();
    expect(samples).toHaveLength(1);
    expect(samples[0].ok).toBe(true);
    expect(samples[0].status).toBe(404);
    expect(samples[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(samples[0].transferredBytes).toBe(new TextEncoder().encode(body).length);
  });

  test("decodes compact range rows into stored range objects", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        count: 1,
        limit: 1,
        truncated: false,
        filters: {
          rangeSize: "100",
          rangeStartGt: null,
          rangeStartLt: null,
          dateGt: null,
          dateLt: null,
        },
        names: RANGE_RESPONSE_NAMES,
        ranges: [compactRangeRow(100)],
      })) as typeof fetch;

    const result = await fetchRanges(new URLSearchParams("limit=1"));

    expect(result.ranges).toHaveLength(1);
    expect(result.ranges[0]).toMatchObject({
      rangeSize: 100,
      rangeStart: 100,
      rangeEnd: 199,
      minBlockDate: "2024-01-01T00:00:00.000Z",
      averageBlockTimeSeconds: "0",
      minBlockTimeSeconds: "0",
      maxBlockTimeSeconds: "0",
      transactionCount: 12,
      totalGasUsed: "252000",
      minBatcherQueueSize: null,
    });
  });

  test("decodes compact guzzler history rows into point objects", async () => {
    const address = `0x${"ab".repeat(20)}`;
    globalThis.fetch = (async () =>
      Response.json({
        address,
        generatedAt: "2024-01-01T00:02:00.000Z",
        retentionMs: 86_400_000,
        bucketMs: 60_000,
        count: 1,
        names: GUZZLER_HISTORY_POINT_RESPONSE_NAMES,
        points: [compactGuzzlerHistoryPointRow()],
      })) as typeof fetch;

    const result = await fetchGuzzlerHistory(address);

    expect(result.address).toBe(address);
    expect(result.points).toEqual([
      {
        minute: 28_392_480,
        startTime: "2024-01-01T00:00:00.000Z",
        transactionCount: 3,
        totalGasUsed: "63000",
        totalFeeWei: "420000",
        firstSeen: "2024-01-01T00:00:05.000Z",
        lastSeen: "2024-01-01T00:00:55.000Z",
      },
    ]);
  });

  test("decodes compact guzzler leaderboard rows and sends an optional window", async () => {
    let observedInput = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInput = String(input);
      return Response.json({
        generatedAt: "2024-01-01T00:02:00.000Z",
        retentionMs: 86_400_000,
        limit: 10,
        names: GUZZLER_STAT_RESPONSE_NAMES,
        windows: [
          {
            label: "1h",
            windowMs: 3_600_000,
            count: 1,
            guzzlers: [compactGuzzlerStatRow()],
          },
        ],
      });
    }) as typeof fetch;

    const result = await fetchGuzzlers(10, "1h");

    expect(observedInput).toBe("/api/guzzlers?limit=10&window=1h");
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]?.guzzlers).toEqual([
      {
        address: `0x${"ab".repeat(20)}`,
        transactionCount: 3,
        totalGasUsed: "63000",
        totalFeeWei: "420000",
        firstSeen: "2024-01-01T00:00:05.000Z",
        lastSeen: "2024-01-01T00:00:55.000Z",
      },
    ]);
  });

  test("fetches a block inspection from the stored block and transaction APIs", async () => {
    const observedInputs: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInputs.push(String(input));
      if (String(input) === "/api/transactions?block=42&limit=1000&order=asc") {
        return Response.json({
          count: 1,
          limit: 1000,
          truncated: false,
          page: 1,
          pageSize: 1000,
          totalCount: 1,
          totalPages: 1,
          hasPreviousPage: false,
          hasNextPage: false,
          filters: {
            block: "42",
            blockGt: null,
            blockLt: null,
            address: null,
            nonceGt: null,
            nonceLt: null,
            dateGt: null,
            dateLt: null,
          },
          transactions: [
            {
              blockNumber: 42,
              blockNumberDecimal: "42",
              blockDate: "2024-01-01T00:00:00.000Z",
              baseBlockFeeWei: "0",
              position: 0,
              hash: "0xabc",
              from: null,
              to: null,
              type: null,
              nonce: null,
              valueWei: "0",
              gasLimit: "0",
              gasUsed: "0",
              cumulativeGasUsed: null,
              gasPriceWei: null,
              maxFeePerGasWei: null,
              maxPriorityFeePerGasWei: null,
              effectiveGasPriceWei: "0",
              priorityFeeWei: "0",
              transactionFeeWei: "0",
              status: null,
              contractAddress: null,
            },
          ],
        });
      }
      return Response.json(compactBlockRow(42));
    }) as typeof fetch;

    const result = await fetchBlockInspect("42");

    expect(observedInputs).toEqual([
      "/api/blocks/42",
      "/api/transactions?block=42&limit=1000&order=asc",
    ]);
    expect(result.block.blockNumberDecimal).toBe("42");
    expect(result.block.transactions).toHaveLength(1);
  });

  test("fetches the latest block inspection when no block number is provided", async () => {
    const observedInputs: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInputs.push(String(input));
      if (String(input) === "/api/blocks?limit=1") {
        return Response.json({
          count: 1,
          limit: 1,
          truncated: false,
          filters: { blockGt: null, blockLt: null, dateGt: null, dateLt: null },
          names: BLOCK_RESPONSE_NAMES,
          blocks: [compactBlockRow(45)],
        });
      }
      if (String(input) === "/api/transactions?block=45&limit=1000&order=asc") {
        return Response.json({
          count: 0,
          limit: 1000,
          truncated: false,
          page: 1,
          pageSize: 1000,
          totalCount: 0,
          totalPages: 0,
          hasPreviousPage: false,
          hasNextPage: false,
          filters: {
            block: "45",
            blockGt: null,
            blockLt: null,
            address: null,
            nonceGt: null,
            nonceLt: null,
            dateGt: null,
            dateLt: null,
          },
          transactions: [],
        });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    }) as typeof fetch;

    const result = await fetchLatestBlockInspect();

    expect(observedInputs).toEqual([
      "/api/blocks?limit=1",
      "/api/transactions?block=45&limit=1000&order=asc",
    ]);
    expect(result.block.blockNumberDecimal).toBe("45");
    expect(result.block.transactions).toEqual([]);
  });

  test("reports an empty latest block lookup clearly", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        count: 0,
        limit: 1,
        truncated: false,
        filters: { blockGt: null, blockLt: null, dateGt: null, dateLt: null },
        names: BLOCK_RESPONSE_NAMES,
        blocks: [],
      })) as typeof fetch;

    await expect(fetchLatestBlockInspect()).rejects.toThrow("No blocks were found in storage");
  });

  test("keeps block inspection available when transaction rows cannot be loaded", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/transactions")) {
        return Response.json({ error: "Transaction data is disabled" }, { status: 404 });
      }
      return Response.json(compactBlockRow(42));
    }) as typeof fetch;

    const result = await fetchBlockInspect("42");

    expect(result.block.blockNumber).toBe(42);
    expect(result.block.transactions).toEqual([]);
    expect(result.transactionLoadError).toContain("HTTP 404");
  });
});

function compactBlockRow(blockNumber: number): Array<number | string | null> {
  return BLOCK_RESPONSE_NAMES.map((name) => {
    switch (name) {
      case "blockNumber":
        return blockNumber;
      case "blockDate":
        return "2024-01-01T00:00:00.000Z";
      case "transactionCount":
        return 1;
      case "batcherQueueSize":
      case "batcherIntensity":
      case "batcherLowerThreshold":
      case "batcherUpperThreshold":
      case "batcherMaxBlockSize":
      case "batcherMaxTxSize":
      case "blockRewardWei":
      case "burntFeesWei":
      case "totalTransactionFeeWei":
      case "feePriceSumWei":
      case "priorityFeeSumWei":
      case "priorityFeeWeightedNumeratorWei":
      case "priorityFeeGasWeightedNumeratorWei":
        return null;
      default:
        return "0";
    }
  });
}

function compactRangeRow(rangeStart: number): Array<number | string | null> {
  return RANGE_RESPONSE_NAMES.map((name) => {
    switch (name) {
      case "rangeSize":
        return 100;
      case "rangeStart":
        return rangeStart;
      case "rangeEnd":
        return rangeStart + 99;
      case "minBlockDate":
        return "2024-01-01T00:00:00.000Z";
      case "maxBlockDate":
        return "2024-01-01T00:10:00.000Z";
      case "transactionCount":
        return 12;
      case "totalGasUsed":
        return "252000";
      case "minBatcherQueueSize":
      case "maxBatcherQueueSize":
      case "averageBatcherQueueSize":
      case "averageBatcherIntensity":
      case "averageBatcherLowerThreshold":
      case "averageBatcherUpperThreshold":
      case "averageBatcherMaxBlockSize":
      case "averageBatcherMaxTxSize":
        return null;
      default:
        return "100";
    }
  });
}

function compactGuzzlerHistoryPointRow(): Array<number | string | null> {
  return GUZZLER_HISTORY_POINT_RESPONSE_NAMES.map((name) => {
    switch (name) {
      case "minute":
        return 28_392_480;
      case "startTime":
        return "2024-01-01T00:00:00.000Z";
      case "transactionCount":
        return 3;
      case "totalGasUsed":
        return "63000";
      case "totalFeeWei":
        return "420000";
      case "firstSeen":
        return "2024-01-01T00:00:05.000Z";
      case "lastSeen":
        return "2024-01-01T00:00:55.000Z";
    }
    return null;
  });
}

function compactGuzzlerStatRow(): Array<number | string | null> {
  return GUZZLER_STAT_RESPONSE_NAMES.map((name) => {
    switch (name) {
      case "address":
        return `0x${"ab".repeat(20)}`;
      case "transactionCount":
        return 3;
      case "totalGasUsed":
        return "63000";
      case "totalFeeWei":
        return "420000";
      case "firstSeen":
        return "2024-01-01T00:00:05.000Z";
      case "lastSeen":
        return "2024-01-01T00:00:55.000Z";
    }
    return null;
  });
}
