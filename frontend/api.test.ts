import { afterEach, describe, expect, test } from "bun:test";
import {
  BLOCK_RESPONSE_NAMES,
  fetchBlockByNumber,
  deleteBaseloadConfig,
  fetchBlocks,
  fetchBlockInspect,
  fetchBaseloadConfigs,
  fetchBaseloadState,
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
