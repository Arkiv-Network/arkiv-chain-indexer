import { describe, expect, test } from "bun:test";
import type { StorageLike } from "./src/localStorage";
import {
  ARKIV_READ_METHODS,
  BACKEND_INDEX_RPC_PATH,
  BACKEND_RPC_PATH,
  RpcCallError,
  callRpc,
  checkRpcSource,
  describeRpcEndpoint,
  isMethodNotFound,
  isValidRpcUrl,
  missingBackendMethods,
  readStoredRpcSource,
  rpcEndpointUrl,
  rpcLinkValue,
  rpcSourceFromLinkValue,
  writeStoredRpcSource,
  type RpcSource,
} from "./src/dataRpc";

const BACKEND: RpcSource = { kind: "backend", customUrl: "" };
const CUSTOM: RpcSource = { kind: "custom", customUrl: "https://rpc.example.test/ark_live_secret" };

interface RecordedCall {
  url: string;
  method: string;
  params: unknown[];
}

type Answer = (call: RecordedCall) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(answer: Answer): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: number };
    const call = { url: String(input), method: body.method, params: body.params };
    calls.push(call);
    const response = await answer(call);
    // Echo the request id the way a real node would; tests only look at result/error.
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A node that answers every method the connection check asks for. */
function healthyNode(overrides: Partial<Record<string, (call: RecordedCall) => unknown>> = {}): Answer {
  const handlers: Record<string, (call: RecordedCall) => unknown> = {
    eth_chainId: () => "0x7614d1",
    web3_clientVersion: () => "reth/v2.2.0-88505c7/x86_64-unknown-linux-gnu",
    arkiv_getBlockTiming: () => ({ current_block: 95495, current_block_time: 1788382095, duration: 2 }),
    arkiv_getEntityCount: () => 7155,
    arkiv_query: () => ({
      data: [{ key: `0x${"cb".repeat(32)}`, owner: `0x${"8f".repeat(20)}` }],
      blockNumber: "0x1750b",
      cursor: "b64:UMrWcqekeDUAAAAAAAIJIA",
    }),
    ...overrides,
  };
  return (call) => {
    const handler = handlers[call.method];
    if (!handler) {
      return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `the method ${call.method} does not exist/is not available` } });
    }
    return jsonResponse({ jsonrpc: "2.0", id: 1, result: handler(call) });
  };
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("rpc source selection", () => {
  test("the backend source is the proxied shadow-rpc path", () => {
    expect(rpcEndpointUrl(BACKEND)).toBe(BACKEND_RPC_PATH);
    expect(rpcEndpointUrl(BACKEND)).toBe("/api/shadow-rpc");
    expect(describeRpcEndpoint(BACKEND)).toBe("/api/shadow-rpc");
  });

  test("the experimental index source is the backend's experimental path", () => {
    const index: RpcSource = { kind: "index", customUrl: "ignored" };
    expect(rpcEndpointUrl(index)).toBe(BACKEND_INDEX_RPC_PATH);
    expect(rpcEndpointUrl(index)).toBe("/api/shadow-rpc/experimental");
    expect(describeRpcEndpoint(index)).toBe("/api/shadow-rpc/experimental");
  });

  test("links carry the custom URL, the word index, or nothing", () => {
    expect(rpcLinkValue(BACKEND)).toBe("");
    expect(rpcLinkValue({ kind: "index", customUrl: "" })).toBe("index");
    expect(rpcLinkValue({ kind: "custom", customUrl: " https://rpc.example.test/ " })).toBe("https://rpc.example.test/");
    expect(rpcSourceFromLinkValue("")).toBeNull();
    expect(rpcSourceFromLinkValue(" index ")).toEqual({ kind: "index", customUrl: "" });
    expect(rpcSourceFromLinkValue("https://rpc.example.test/")).toEqual({ kind: "custom", customUrl: "https://rpc.example.test/" });
    expect(rpcSourceFromLinkValue("not a url")).toBeNull();
    expect(rpcSourceFromLinkValue("backend")).toBeNull();
  });

  test("a custom source is used as typed, trimmed", () => {
    expect(rpcEndpointUrl({ kind: "custom", customUrl: "  https://rpc.example.test/  " })).toBe("https://rpc.example.test/");
  });

  test("only absolute http(s) URLs are valid custom endpoints", () => {
    expect(isValidRpcUrl("https://rpc.example.test/key")).toBe(true);
    expect(isValidRpcUrl("http://localhost:8545")).toBe(true);
    expect(isValidRpcUrl("")).toBe(false);
    expect(isValidRpcUrl("rpc.example.test")).toBe(false);
    expect(isValidRpcUrl("ws://rpc.example.test")).toBe(false);
    expect(isValidRpcUrl("/api/shadow-rpc")).toBe(false);
  });

  test("describing a custom endpoint strips basic-auth credentials but keeps the path", () => {
    expect(describeRpcEndpoint({ kind: "custom", customUrl: "https://user:pw@rpc.example.test/path" })).toBe(
      "https://rpc.example.test/path",
    );
    expect(describeRpcEndpoint({ kind: "custom", customUrl: "not a url" })).toBe("not a url");
  });

  test("the choice round-trips through storage and falls back to the backend", () => {
    const storage = memoryStorage();
    expect(readStoredRpcSource(storage)).toEqual({ kind: "backend", customUrl: "" });

    writeStoredRpcSource(CUSTOM, storage);
    expect(readStoredRpcSource(storage)).toEqual(CUSTOM);

    storage.setItem("gas-price-tracker:data.rpcSourceKind", "index");
    expect(readStoredRpcSource(storage).kind).toBe("index");

    storage.setItem("gas-price-tracker:data.rpcSourceKind", "bogus");
    expect(readStoredRpcSource(storage).kind).toBe("backend");
    expect(readStoredRpcSource(storage).customUrl).toBe(CUSTOM.customUrl);
  });

  test("missing backend methods are computed from the health feature list", () => {
    expect(missingBackendMethods(false)).toEqual([...ARKIV_READ_METHODS]);
    expect(missingBackendMethods(undefined)).toEqual([...ARKIV_READ_METHODS]);
    expect(missingBackendMethods(["eth_sendRawTransaction"])).toEqual([...ARKIV_READ_METHODS]);
    expect(missingBackendMethods(["eth_sendRawTransaction", "arkiv_query", "arkiv_getBlockTiming"])).toEqual([
      "arkiv_getEntityCount",
    ]);
    expect(missingBackendMethods([...ARKIV_READ_METHODS, "eth_sendRawTransaction"])).toEqual([]);
  });
});

describe("callRpc", () => {
  test("posts a JSON-RPC 2.0 envelope to the selected endpoint and returns the result", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x7614d1" }));
    const result = await callRpc(CUSTOM, "eth_chainId", [], { fetchImpl });
    expect(result).toBe("0x7614d1");
    expect(calls).toEqual([{ url: CUSTOM.customUrl, method: "eth_chainId", params: [] }]);
  });

  test("a node error becomes an RpcCallError carrying the code and method", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "the method arkiv_query does not exist" } }),
    );
    const error = await callRpc(BACKEND, "arkiv_query", ["*"], { fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcCallError);
    const rpcError = error as RpcCallError;
    expect(rpcError.method).toBe("arkiv_query");
    expect(rpcError.code).toBe(-32601);
    expect(rpcError.message).toBe("arkiv_query was rejected (-32601): the method arkiv_query does not exist");
    expect(isMethodNotFound(rpcError)).toBe(true);
    expect(isMethodNotFound(new Error("x"))).toBe(false);
  });

  test("a non-2xx transport answer reports the HTTP status and any node message", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: "RATE_LIMITED" }, 429));
    const error = (await callRpc(BACKEND, "eth_chainId", [], { fetchImpl }).catch((e: unknown) => e)) as RpcCallError;
    expect(error.httpStatus).toBe(429);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("eth_chainId answered HTTP 429: RATE_LIMITED");
  });

  test("a network failure is reported without leaking the endpoint URL", async () => {
    const { fetchImpl } = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const error = (await callRpc(CUSTOM, "eth_chainId", [], { fetchImpl }).catch((e: unknown) => e)) as RpcCallError;
    expect(error).toBeInstanceOf(RpcCallError);
    expect(error.message).toContain("could not reach the endpoint (Failed to fetch)");
    expect(error.message).not.toContain("ark_live_secret");
  });

  test("a body that is not JSON-RPC is rejected", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>login</html>", { status: 200 }));
    const error = (await callRpc(BACKEND, "eth_chainId", [], { fetchImpl }).catch((e: unknown) => e)) as RpcCallError;
    expect(error.message).toBe("eth_chainId answered with something that is not JSON-RPC");
  });
});

describe("checkRpcSource", () => {
  test("a healthy node passes every step and the report carries the decoded facts", async () => {
    const { fetchImpl, calls } = fakeFetch(healthyNode());
    let clock = 1_000;
    const report = await checkRpcSource(BACKEND, { fetchImpl, now: () => (clock += 10) });

    expect(report.ok).toBe(true);
    expect(report.arkivOk).toBe(true);
    expect(report.endpoint).toBe("/api/shadow-rpc");
    expect(report.chainId).toBe(7738577);
    expect(report.clientVersion).toBe("reth/v2.2.0-88505c7/x86_64-unknown-linux-gnu");
    expect(report.timing).toEqual({ currentBlock: 95495, currentBlockTime: 1788382095, blockDurationSeconds: 2 });
    expect(report.entityCount).toBe(7155);
    expect(report.sampleEntityKey).toBe(`0x${"cb".repeat(32)}`);
    expect(report.sampleEntityOwner).toBe(`0x${"8f".repeat(20)}`);

    expect(calls.map((call) => call.method)).toEqual([
      "eth_chainId",
      "web3_clientVersion",
      "arkiv_getBlockTiming",
      "arkiv_getEntityCount",
      "arkiv_query",
    ]);
    // The probe query asks for one entity and only the two cheap fields; never payloads.
    expect(calls[4]!.params).toEqual(["*", { limit: "0x1", select: { key: true, owner: true } }]);

    expect(report.steps.map((step) => [step.method, step.status, step.durationMs])).toEqual([
      ["eth_chainId", "ok", 10],
      ["web3_clientVersion", "ok", 10],
      ["arkiv_getBlockTiming", "ok", 10],
      ["arkiv_getEntityCount", "ok", 10],
      ["arkiv_query", "ok", 10],
    ]);
    expect(report.steps[2]!.summary).toBe("block 95495 at 2026-09-02T20:48:15.000Z, 2s per block");
    expect(report.steps[4]!.summary).toBe(`first entity 0x${"cb".repeat(32)} at block 95499, more pages available`);
  });

  test("a node without the arkiv methods keeps going and reports each failure with its code", async () => {
    const { fetchImpl } = fakeFetch(
      healthyNode({
        arkiv_getBlockTiming: undefined,
        arkiv_getEntityCount: undefined,
        arkiv_query: undefined,
      }),
    );
    const report = await checkRpcSource(CUSTOM, { fetchImpl });

    expect(report.ok).toBe(false);
    expect(report.arkivOk).toBe(false);
    expect(report.chainId).toBe(7738577);
    expect(report.timing).toBeNull();
    expect(report.entityCount).toBeNull();
    expect(report.sampleEntityKey).toBeNull();
    expect(report.steps).toHaveLength(5);
    const failed = report.steps.filter((step) => step.status === "fail");
    expect(failed.map((step) => [step.method, step.code])).toEqual([
      ["arkiv_getBlockTiming", -32601],
      ["arkiv_getEntityCount", -32601],
      ["arkiv_query", -32601],
    ]);
    expect(failed[0]!.summary).toContain("does not exist");
    expect(report.endpoint).toBe(CUSTOM.customUrl);
  });

  test("a plain Ethereum failure with working arkiv reads is a partial pass", async () => {
    const { fetchImpl } = fakeFetch(healthyNode({ web3_clientVersion: undefined }));
    const report = await checkRpcSource(BACKEND, { fetchImpl });
    expect(report.ok).toBe(false);
    expect(report.arkivOk).toBe(true);
    expect(report.clientVersion).toBeNull();
    expect(report.entityCount).toBe(7155);
  });

  test("an empty chain reports no sample entity rather than failing the query step", async () => {
    const { fetchImpl } = fakeFetch(
      healthyNode({ arkiv_getEntityCount: () => 0, arkiv_query: () => ({ data: [], blockNumber: "0x10" }) }),
    );
    const report = await checkRpcSource(BACKEND, { fetchImpl });
    expect(report.ok).toBe(true);
    expect(report.sampleEntityKey).toBeNull();
    expect(report.steps[4]!.summary).toBe("no entities at block 16");
  });

  test("a malformed result fails its own step only", async () => {
    const { fetchImpl } = fakeFetch(healthyNode({ arkiv_getBlockTiming: () => ({ nope: true }) }));
    const report = await checkRpcSource(BACKEND, { fetchImpl });
    expect(report.arkivOk).toBe(false);
    const step = report.steps.find((s) => s.method === "arkiv_getBlockTiming")!;
    expect(step.status).toBe("fail");
    expect(step.code).toBeUndefined();
    expect(step.summary).toContain("unexpected block timing shape");
    expect(report.entityCount).toBe(7155);
  });
});
