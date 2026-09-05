/**
 * The HTTP backend's Prometheus metrics, exposed on `GET /metrics`.
 *
 * Traffic is labelled by *route template*, never by the raw path: a request
 * for `/transaction/0xabc…` lands on `/transaction/:hash`, and any path the
 * router does not know collapses to `other`. That keeps series cardinality
 * bounded no matter what clients send. Query strings are never labels for
 * the same reason.
 *
 * Everything here is process-global on purpose: the metrics describe the one
 * server in this process, and `src/db.ts` reads the current request's route
 * from `requestContext` to attribute query time without threading a handle
 * through every storage call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readBuildInfo } from "./buildInfo";
import { Registry, PROMETHEUS_CONTENT_TYPE } from "./prometheus";
import type { ResponseCacheStats } from "./responseCache";
import type { ValueCacheStats } from "./valueCache";

export { PROMETHEUS_CONTENT_TYPE };

export const metricsRegistry = new Registry();

/** Route label for paths the router does not recognise. */
export const OTHER_ROUTE = "other";

/**
 * The scrape endpoints. Their own requests are left out of the traffic
 * metrics so a scrape never shows up as traffic it then reports.
 */
const SCRAPE_ROUTES: ReadonlySet<string> = new Set(["/metrics", "/admin/metrics"]);

/**
 * Known routes as `[regex, template]`, first match wins. Keep this in step
 * with `routeRequest` in src/server.ts; an unlisted route is still counted,
 * just under `other`.
 */
const ROUTE_TEMPLATES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/metrics$/, "/metrics"],
  [/^\/admin\/metrics$/, "/admin/metrics"],
  [/^\/health$/, "/health"],
  [/^\/sync$/, "/sync"],
  [/^\/llms\.txt$/, "/llms.txt"],
  [/^\/admin\/verify$/, "/admin/verify"],
  [/^\/baseload$/, "/baseload"],
  [/^\/baseload\/configs$/, "/baseload/configs"],
  [/^\/baseload\/configs\/[^/]+\/load$/, "/baseload/configs/:name/load"],
  [/^\/baseload\/configs\/[^/]+$/, "/baseload/configs/:name"],
  [/^\/shadow-rpc$/, "/shadow-rpc"],
  [/^\/shadow-rpc\/experimental$/, "/shadow-rpc/experimental"],
  [/^\/guzzlers$/, "/guzzlers"],
  [/^\/guzzler\/.+$/, "/guzzler/:address"],
  [/^\/blocks$/, "/blocks"],
  [/^\/blocks\/\d+$/, "/blocks/:number"],
  [/^\/block\/\d+$/, "/block/:number"],
  [/^\/ranges$/, "/ranges"],
  [/^\/transactions$/, "/transactions"],
  [/^\/transaction\/0x[0-9a-fA-F]{64}$/, "/transaction/:hash"],
  [/^\/entity\/0x[0-9a-fA-F]{64}$/, "/entity/:key"],
  [/^\/transaction-records$/, "/transaction-records"],
  [/^\/balances$/, "/balances"],
  [/^\/senders$/, "/senders"],
];

/** Map a request path to its bounded route label. */
export function routeTemplate(pathname: string): string {
  for (const [pattern, template] of ROUTE_TEMPLATES) {
    if (pattern.test(pathname)) return template;
  }
  return OTHER_ROUTE;
}

// ---------------------------------------------------------------------------
// HTTP traffic

export const httpRequestsTotal = metricsRegistry.counter(
  "http_requests_total",
  "HTTP requests handled, by route template, method and status code.",
  ["route", "method", "status"],
);

export const httpRequestDurationSeconds = metricsRegistry.histogram(
  "http_request_duration_seconds",
  "Time from request receipt to response, by route template and method.",
  ["route", "method"],
);

export const httpResponseBytesTotal = metricsRegistry.counter(
  "http_response_bytes_total",
  "Response body bytes sent, by route template and Content-Encoding on the wire.",
  ["route", "encoding"],
);

export const httpRequestsInFlight = metricsRegistry.gauge(
  "http_requests_in_flight",
  "Requests currently being handled, by route template.",
  ["route"],
);

export const httpRequestsRejectedTotal = metricsRegistry.counter(
  "http_requests_rejected_total",
  "Requests answered with a client error, by route template and reason.",
  ["route", "reason"],
);

// ---------------------------------------------------------------------------
// JSON-RPC (one path, many methods)

export const jsonRpcRequestsTotal = metricsRegistry.counter(
  "jsonrpc_requests_total",
  "JSON-RPC calls (batch entries counted individually), by path, method, where it was answered, and outcome.",
  ["path", "rpc_method", "source", "outcome"],
);

export const jsonRpcRequestDurationSeconds = metricsRegistry.histogram(
  "jsonrpc_request_duration_seconds",
  "Time to answer one JSON-RPC call, by path and method.",
  ["path", "rpc_method"],
);

export const jsonRpcBatchSize = metricsRegistry.histogram(
  "jsonrpc_batch_size",
  "Number of calls per JSON-RPC HTTP request (1 for a non-batch request).",
  ["path"],
  [1, 2, 5, 10, 20, 50, 100],
);

export const jsonRpcGetLogsBlocksTotal = metricsRegistry.counter(
  "jsonrpc_get_logs_blocks_total",
  "Blocks covered by eth_getLogs ranges that reached storage.",
);

export const jsonRpcGetLogsReturnedTotal = metricsRegistry.counter(
  "jsonrpc_get_logs_returned_total",
  "Log entries returned by eth_getLogs.",
);

// ---------------------------------------------------------------------------
// Caches

export const cacheRequestsTotal = metricsRegistry.counter(
  "cache_requests_total",
  "Cache lookups by cache and result (hit, miss, coalesced onto an in-flight load).",
  ["cache", "result"],
);

export const cacheEntries = metricsRegistry.gauge(
  "cache_entries",
  "Entries currently held, by cache.",
  ["cache"],
);

export const cacheBytes = metricsRegistry.gauge(
  "cache_bytes",
  "Bytes of cached bodies currently held, by cache.",
  ["cache"],
);

export const cacheEvictionsTotal = metricsRegistry.counter(
  "cache_evictions_total",
  "Entries dropped, by cache and reason (invalidation, ttl, capacity).",
  ["cache", "reason"],
);

// ---------------------------------------------------------------------------
// Database

export const dbQueryDurationSeconds = metricsRegistry.histogram(
  "db_query_duration_seconds",
  "Postgres query time, attributed to the HTTP route that issued it (none outside a request).",
  ["route"],
);

export const dbQueriesTotal = metricsRegistry.counter(
  "db_queries_total",
  "Postgres queries issued, by route and outcome.",
  ["route", "outcome"],
);

export const dbQueriesInFlight = metricsRegistry.gauge(
  "db_queries_in_flight",
  "Postgres queries currently awaiting a result.",
);

// ---------------------------------------------------------------------------
// Indexer state and process

export const indexerHeadBlock = metricsRegistry.gauge(
  "indexer_head_block",
  "Last block stored by the scanner (what /shadow-rpc calls latest).",
);

export const chainHeadBlock = metricsRegistry.gauge(
  "chain_head_block",
  "Latest block number the scanner has observed on the node.",
);

export const indexerLagBlocks = metricsRegistry.gauge(
  "indexer_lag_blocks",
  "chain_head_block minus indexer_head_block.",
);

export const indexerHeadAgeSeconds = metricsRegistry.gauge(
  "indexer_head_age_seconds",
  "Seconds since the last stored block was sealed on chain.",
);

export const processStartTimeSeconds = metricsRegistry.gauge(
  "process_start_time_seconds",
  "Unix time the server process started.",
);

export const processResidentMemoryBytes = metricsRegistry.gauge(
  "process_resident_memory_bytes",
  "Resident set size of the server process.",
);

export const processHeapUsedBytes = metricsRegistry.gauge(
  "process_heap_used_bytes",
  "JavaScript heap in use.",
);

export const buildInfo = metricsRegistry.gauge(
  "build_info",
  "Always 1; the labels carry the build commit and date.",
  ["commit", "built_at"],
);

const PROCESS_START_SECONDS = Date.now() / 1000 - process.uptime();

metricsRegistry.collect(() => {
  processStartTimeSeconds.set(undefined, PROCESS_START_SECONDS);
  const memory = process.memoryUsage();
  processResidentMemoryBytes.set(undefined, memory.rss);
  processHeapUsedBytes.set(undefined, memory.heapUsed);
  const info = readBuildInfo();
  buildInfo.set({ commit: info.commit ?? "unknown", built_at: info.builtAtUtc ?? "unknown" }, 1);
});

// ---------------------------------------------------------------------------
// Request context (for attributing DB time to a route)

export interface RequestContext {
  route: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Route of the request currently being handled, or `none` outside one. */
export function currentRoute(): string {
  return requestContext.getStore()?.route ?? "none";
}

// ---------------------------------------------------------------------------
// Response body sizes

/**
 * Bun's `Response` does not expose its body length, and reading it back would
 * copy every body. The few constructors in src/server.ts that build responses
 * register the byte count here instead; the request wrapper looks it up.
 */
const responseBodyBytes = new WeakMap<Response, number>();

export function recordResponseBytes<R extends Response>(response: R, bytes: number): R {
  responseBodyBytes.set(response, bytes);
  return response;
}

export function responseBytes(response: Response): number | undefined {
  return responseBodyBytes.get(response);
}

function rejectionReason(status: number): string | undefined {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return status >= 400 && status < 500 ? "client_error" : undefined;
  }
}

/**
 * Handle `request` through `handler` while recording the traffic metrics.
 * A successful scrape is passed through unrecorded, so a scrape never shows up
 * as the traffic it then reports; a *rejected* one is still counted, because
 * `/admin/metrics` is reachable from the public origin and a run of 401s there
 * is worth seeing. Throws propagate after being counted as a 500.
 */
export async function observeHttpRequest(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  const route = routeTemplate(new URL(request.url).pathname);
  if (SCRAPE_ROUTES.has(route)) {
    const response = await handler();
    if (response.status >= 400) {
      httpRequestsTotal.inc({ route, method: request.method, status: String(response.status) });
      const reason = rejectionReason(response.status);
      if (reason) httpRequestsRejectedTotal.inc({ route, reason });
    }
    return response;
  }
  const method = request.method;
  const routeLabels = { route };
  const timerLabels = { route, method };
  httpRequestsInFlight.inc(routeLabels);
  const stopTimer = httpRequestDurationSeconds.startTimer(timerLabels);
  let status = 500;
  let response: Response | undefined;
  try {
    response = await requestContext.run({ route }, handler);
    status = response.status;
    return response;
  } finally {
    stopTimer();
    httpRequestsInFlight.dec(routeLabels);
    httpRequestsTotal.inc({ route, method, status: String(status) });
    const reason = rejectionReason(status);
    if (reason) {
      httpRequestsRejectedTotal.inc({ route, reason });
    }
    if (response) {
      const bytes = responseBytes(response);
      if (bytes !== undefined) {
        const encoding = response.headers.get("Content-Encoding") ?? "identity";
        httpResponseBytesTotal.inc({ route, encoding }, bytes);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Collectors for state owned by serve.ts

/** Mirror a ResponseCache's counters and gauges under the given cache label. */
export function collectResponseCache(name: string, stats: () => ResponseCacheStats): () => void {
  return metricsRegistry.collect(() => {
    const snapshot = stats();
    cacheRequestsTotal.assign({ cache: name, result: "hit" }, snapshot.hits);
    cacheRequestsTotal.assign({ cache: name, result: "miss" }, snapshot.misses);
    cacheRequestsTotal.assign({ cache: name, result: "coalesced" }, snapshot.coalesced);
    cacheEntries.set({ cache: name }, snapshot.entries);
    cacheBytes.set({ cache: name }, snapshot.bytes);
    cacheEvictionsTotal.assign({ cache: name, reason: "invalidation" }, snapshot.invalidations);
    cacheEvictionsTotal.assign({ cache: name, reason: "ttl" }, snapshot.expirations);
    cacheEvictionsTotal.assign({ cache: name, reason: "capacity" }, snapshot.evictions);
  });
}

/** Same for a ValueCache (no byte accounting). */
export function collectValueCache(name: string, stats: () => ValueCacheStats): () => void {
  return metricsRegistry.collect(() => {
    const snapshot = stats();
    cacheRequestsTotal.assign({ cache: name, result: "hit" }, snapshot.hits);
    cacheRequestsTotal.assign({ cache: name, result: "miss" }, snapshot.misses);
    cacheRequestsTotal.assign({ cache: name, result: "coalesced" }, snapshot.coalesced);
    cacheEntries.set({ cache: name }, snapshot.entries);
    cacheEvictionsTotal.assign({ cache: name, reason: "invalidation" }, snapshot.invalidations);
    cacheEvictionsTotal.assign({ cache: name, reason: "ttl" }, snapshot.expirations);
    cacheEvictionsTotal.assign({ cache: name, reason: "capacity" }, snapshot.evictions);
  });
}

export interface IndexerProgressSnapshot {
  lastSuccessfulBlock?: bigint;
  /** ISO timestamp (as stored) or a Date. */
  lastSuccessfulBlockDate?: string | Date;
  latestObservedBlock?: bigint;
}

/** Refresh the indexer head/lag gauges from scanner progress at scrape time. */
export function collectIndexerProgress(
  progress: () => Promise<IndexerProgressSnapshot>,
  now: () => Date = () => new Date(),
): () => void {
  return metricsRegistry.collect(async () => {
    const snapshot = await progress();
    if (snapshot.lastSuccessfulBlock !== undefined) {
      indexerHeadBlock.set(undefined, Number(snapshot.lastSuccessfulBlock));
    }
    if (snapshot.latestObservedBlock !== undefined) {
      chainHeadBlock.set(undefined, Number(snapshot.latestObservedBlock));
    }
    if (snapshot.lastSuccessfulBlock !== undefined && snapshot.latestObservedBlock !== undefined) {
      const lag = snapshot.latestObservedBlock - snapshot.lastSuccessfulBlock;
      indexerLagBlocks.set(undefined, Number(lag < 0n ? 0n : lag));
    }
    if (snapshot.lastSuccessfulBlockDate) {
      const sealedAt = new Date(snapshot.lastSuccessfulBlockDate).getTime();
      if (Number.isFinite(sealedAt)) {
        indexerHeadAgeSeconds.set(undefined, Math.max(0, (now().getTime() - sealedAt) / 1000));
      }
    }
  });
}
