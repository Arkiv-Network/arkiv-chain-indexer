import { testAuth, testAdminHeaders } from "./testAuth";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  cacheBytes,
  cacheEntries,
  cacheEvictionsTotal,
  cacheRequestsTotal,
  chainHeadBlock,
  collectIndexerProgress,
  collectResponseCache,
  collectValueCache,
  currentRoute,
  httpRequestDurationSeconds,
  httpRequestsInFlight,
  httpRequestsRejectedTotal,
  httpRequestsTotal,
  httpResponseBytesTotal,
  indexerHeadAgeSeconds,
  indexerHeadBlock,
  indexerLagBlocks,
  jsonRpcBatchSize,
  jsonRpcRequestDurationSeconds,
  jsonRpcRequestsTotal,
  metricsRegistry,
  observeHttpRequest,
  recordResponseBytes,
  routeTemplate,
} from "./serverMetrics";
import { handleJsonRpcBody, type JsonRpcDataSource } from "./jsonRpc";
import { handleRequest } from "./server";
import type { ScannerStorage } from "./storage";

const HASH = `0x${"ab".repeat(32)}`;

beforeEach(() => {
  metricsRegistry.resetAll();
});

describe("routeTemplate", () => {
  test("maps concrete paths to bounded templates", () => {
    expect(routeTemplate("/blocks")).toBe("/blocks");
    expect(routeTemplate("/blocks/123")).toBe("/blocks/:number");
    expect(routeTemplate("/block/123")).toBe("/block/:number");
    expect(routeTemplate(`/transaction/${HASH}`)).toBe("/transaction/:hash");
    expect(routeTemplate(`/entity/${HASH}`)).toBe("/entity/:key");
    expect(routeTemplate("/guzzler/0xabc")).toBe("/guzzler/:address");
    expect(routeTemplate("/baseload/configs/night/load")).toBe("/baseload/configs/:name/load");
    expect(routeTemplate("/baseload/configs/night")).toBe("/baseload/configs/:name");
    expect(routeTemplate("/shadow-rpc/experimental")).toBe("/shadow-rpc/experimental");
    expect(routeTemplate("/metrics")).toBe("/metrics");
    expect(routeTemplate("/admin/metrics")).toBe("/admin/metrics");
  });

  test("collapses anything unknown to other", () => {
    expect(routeTemplate("/")).toBe("other");
    expect(routeTemplate("/transaction/0x1234")).toBe("other");
    expect(routeTemplate("/wp-admin.php")).toBe("other");
  });
});

describe("observeHttpRequest", () => {
  test("counts the request, its duration, bytes and encoding by route template", async () => {
    const request = new Request(`http://x/transaction/${HASH}`);
    const response = recordResponseBytes(
      new Response("abc", { headers: { "Content-Encoding": "gzip" } }),
      3,
    );
    let routeInside = "";
    const result = await observeHttpRequest(request, async () => {
      routeInside = currentRoute();
      expect(httpRequestsInFlight.get({ route: "/transaction/:hash" })).toBe(1);
      return response;
    });

    expect(result).toBe(response);
    expect(routeInside).toBe("/transaction/:hash");
    expect(currentRoute()).toBe("none");
    expect(httpRequestsInFlight.get({ route: "/transaction/:hash" })).toBe(0);
    expect(
      httpRequestsTotal.get({ route: "/transaction/:hash", method: "GET", status: "200" }),
    ).toBe(1);
    expect(httpRequestDurationSeconds.get({ route: "/transaction/:hash", method: "GET" }).count).toBe(
      1,
    );
    expect(httpResponseBytesTotal.get({ route: "/transaction/:hash", encoding: "gzip" })).toBe(3);
  });

  test("uses identity for unencoded bodies and skips bytes it cannot measure", async () => {
    await observeHttpRequest(new Request("http://x/blocks"), async () =>
      recordResponseBytes(new Response("{}"), 2),
    );
    await observeHttpRequest(new Request("http://x/blocks"), async () => new Response("unknown"));
    expect(httpResponseBytesTotal.get({ route: "/blocks", encoding: "identity" })).toBe(2);
  });

  test("records client errors with a reason", async () => {
    await observeHttpRequest(new Request("http://x/nope"), async () =>
      recordResponseBytes(new Response("{}", { status: 404 }), 2),
    );
    await observeHttpRequest(new Request("http://x/baseload", { method: "PUT" }), async () =>
      recordResponseBytes(new Response("{}", { status: 401 }), 2),
    );
    expect(httpRequestsTotal.get({ route: "other", method: "GET", status: "404" })).toBe(1);
    expect(httpRequestsRejectedTotal.get({ route: "other", reason: "not_found" })).toBe(1);
    expect(httpRequestsRejectedTotal.get({ route: "/baseload", reason: "unauthorized" })).toBe(1);
  });

  test("a throwing handler counts as a 500 and rethrows", async () => {
    await expect(
      observeHttpRequest(new Request("http://x/sync"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(httpRequestsTotal.get({ route: "/sync", method: "GET", status: "500" })).toBe(1);
    expect(httpRequestsInFlight.get({ route: "/sync" })).toBe(0);
  });

  test("scrapes of /metrics are not traffic", async () => {
    await observeHttpRequest(new Request("http://x/metrics"), async () => new Response("ok"));
    expect(httpRequestsTotal.get({ route: "/metrics", method: "GET", status: "200" })).toBe(0);
  });

  test("scrapes of /admin/metrics are not traffic either", async () => {
    await observeHttpRequest(new Request("http://x/admin/metrics"), async () => new Response("ok"));
    expect(httpRequestsTotal.get({ route: "/admin/metrics", method: "GET", status: "200" })).toBe(0);
  });

  test("but a rejected scrape is counted, so token probing is visible", async () => {
    await observeHttpRequest(
      new Request("http://x/admin/metrics"),
      async () => new Response("no", { status: 401 }),
    );
    expect(httpRequestsTotal.get({ route: "/admin/metrics", method: "GET", status: "401" })).toBe(1);
    expect(httpRequestsRejectedTotal.get({ route: "/admin/metrics", reason: "unauthorized" })).toBe(1);
  });
});

for (const path of ["/metrics","/admin/metrics"]) describe(`GET ${path}`, () => {
  const storage={} as ScannerStorage;
  const get=(headers:Record<string,string>={...testAdminHeaders},extra={})=>handleRequest(new Request(`http://x${path}`,{headers}),storage,{auth:testAuth(),...extra});
  test("renders registry for an administrator without counting the scrape",async()=>{
    httpRequestsTotal.inc({route:"/blocks",method:"GET",status:"200"},5);
    const response=await get();expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain('http_requests_total{route="/blocks",method="GET",status="200"} 5');
    expect(httpRequestsTotal.get({route:path,method:"GET",status:"200"})).toBe(0);
  });
  if (path === "/admin/metrics") test("rejects anonymous and legacy credentials, including proxy requests",async()=>{
    expect((await get({})).status).toBe(401);
    expect((await get({Authorization:"Bearer old-secret"},{metricsBearerToken:"old-secret"})).status).toBe(401);
    expect((await get({"X-Forwarded-For":"1"})).status).toBe(401);
    expect((await handleRequest(new Request(`http://x${path}`),storage)).status).toBe(503);
  });
  if (path === "/metrics") test("is open without login configuration, regardless of forwarding headers or credentials",async()=>{
    for (const headers of [{}, {"X-Forwarded-For":"1", "X-Forwarded-Proto":"https"}, {Authorization:"Bearer ignored"}]) {
      const response=await handleRequest(new Request("http://x/metrics",{headers}),storage);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/plain");
    }
    expect((await get({})).status).toBe(200);
  });
  test("can be disabled and only answers GET",async()=>{
    expect((await get({...testAdminHeaders},{metricsEnabled:false})).status).toBe(404);
    expect((await handleRequest(new Request(`http://x${path}`,{method:"POST",headers:testAdminHeaders}),storage,{auth:testAuth()})).status).toBe(405);
  });
});

describe("JSON-RPC metrics", () => {
  const source = {
    getChainId: async () => 1337n,
  } as unknown as JsonRpcDataSource;

  test("labels each call by path, method, source and outcome", async () => {
    await handleJsonRpcBody(
      [
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_chainId", params: ["extra"] },
        { jsonrpc: "2.0", id: 3, method: "no_such_method_9f1c", params: [] },
        { jsonrpc: "2.0", id: 4, method: 42 },
      ],
      source,
      { path: "/shadow-rpc" },
    );

    const labels = (rpc_method: string, sourceLabel: string, outcome: string) => ({
      path: "/shadow-rpc",
      rpc_method,
      source: sourceLabel,
      outcome,
    });
    expect(jsonRpcRequestsTotal.get(labels("eth_chainId", "stored", "ok"))).toBe(1);
    expect(jsonRpcRequestsTotal.get(labels("eth_chainId", "stored", "invalid_params"))).toBe(1);
    // Unknown method names never become label values.
    expect(jsonRpcRequestsTotal.get(labels("unknown", "none", "method_not_found"))).toBe(1);
    expect(jsonRpcRequestsTotal.get(labels("invalid", "none", "invalid_request"))).toBe(1);
    expect(
      jsonRpcRequestDurationSeconds.get({ path: "/shadow-rpc", rpc_method: "eth_chainId" }).count,
    ).toBe(2);
    expect(jsonRpcBatchSize.get({ path: "/shadow-rpc" })).toEqual({ count: 1, sum: 4 });
  });

  test("a single request observes a batch size of 1 and the default path", async () => {
    await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, source);
    expect(jsonRpcBatchSize.get({ path: "/shadow-rpc" })).toEqual({ count: 1, sum: 1 });
  });

  test("attributes forwarded calls to upstream and overrides to override", async () => {
    const passthrough = {
      methods: new Set(["eth_sendRawTransaction"]),
      forward: async () => "0x1",
    };
    await handleJsonRpcBody(
      [
        { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"] },
        { jsonrpc: "2.0", id: 2, method: "arkiv_query", params: [] },
      ],
      source,
      {
        path: "/shadow-rpc/experimental",
        passthrough,
        localOverrides: { arkiv_query: async () => [] },
      },
    );
    expect(
      jsonRpcRequestsTotal.get({
        path: "/shadow-rpc/experimental",
        rpc_method: "eth_sendRawTransaction",
        source: "upstream",
        outcome: "ok",
      }),
    ).toBe(1);
    expect(
      jsonRpcRequestsTotal.get({
        path: "/shadow-rpc/experimental",
        rpc_method: "arkiv_query",
        source: "override",
        outcome: "ok",
      }),
    ).toBe(1);
  });
});

describe("collectors", () => {
  test("mirror response cache stats", async () => {
    const stop = collectResponseCache("list", () => ({
      entries: 3,
      bytes: 1024,
      hits: 10,
      misses: 4,
      coalesced: 1,
      invalidations: 2,
      evictions: 5,
      expirations: 6,
    }));
    await metricsRegistry.render();
    stop();
    expect(cacheRequestsTotal.get({ cache: "list", result: "hit" })).toBe(10);
    expect(cacheRequestsTotal.get({ cache: "list", result: "miss" })).toBe(4);
    expect(cacheRequestsTotal.get({ cache: "list", result: "coalesced" })).toBe(1);
    expect(cacheEntries.get({ cache: "list" })).toBe(3);
    expect(cacheBytes.get({ cache: "list" })).toBe(1024);
    expect(cacheEvictionsTotal.get({ cache: "list", reason: "invalidation" })).toBe(2);
    expect(cacheEvictionsTotal.get({ cache: "list", reason: "ttl" })).toBe(6);
    expect(cacheEvictionsTotal.get({ cache: "list", reason: "capacity" })).toBe(5);
  });

  test("mirror value cache stats", async () => {
    const stop = collectValueCache("transaction_count", () => ({
      entries: 2,
      hits: 7,
      misses: 1,
      coalesced: 0,
      invalidations: 0,
      evictions: 0,
      expirations: 3,
    }));
    await metricsRegistry.render();
    stop();
    expect(cacheRequestsTotal.get({ cache: "transaction_count", result: "hit" })).toBe(7);
    expect(cacheEntries.get({ cache: "transaction_count" })).toBe(2);
    expect(cacheEvictionsTotal.get({ cache: "transaction_count", reason: "ttl" })).toBe(3);
  });

  test("derive head, lag and age from scanner progress", async () => {
    const now = new Date("2026-09-05T12:00:10Z");
    const stop = collectIndexerProgress(
      async () => ({
        lastSuccessfulBlock: 100n,
        lastSuccessfulBlockDate: "2026-09-05T12:00:00Z",
        latestObservedBlock: 104n,
      }),
      () => now,
    );
    await metricsRegistry.render();
    stop();
    expect(indexerHeadBlock.get()).toBe(100);
    expect(chainHeadBlock.get()).toBe(104);
    expect(indexerLagBlocks.get()).toBe(4);
    expect(indexerHeadAgeSeconds.get()).toBe(10);
  });

  test("clamp negative lag to zero and skip unknown fields", async () => {
    const stop = collectIndexerProgress(async () => ({
      lastSuccessfulBlock: 100n,
      latestObservedBlock: 98n,
    }));
    await metricsRegistry.render();
    stop();
    expect(indexerLagBlocks.get()).toBe(0);
    expect(indexerHeadAgeSeconds.get()).toBe(0);
  });
});
