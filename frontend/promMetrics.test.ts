import { describe, expect, test } from "bun:test";
import {
  cacheStats,
  gauge,
  parsePrometheusText,
  processStats,
  routeTraffic,
  rpcTraffic,
  sumBy,
} from "./src/promMetrics";

/** A trimmed but literal slice of what `GET /api/admin/metrics` returns. */
const SAMPLE = `# HELP indexer_http_requests_total HTTP requests handled, by route template, method and status code.
# TYPE indexer_http_requests_total counter
indexer_http_requests_total{route="/blocks",method="GET",status="200"} 85
indexer_http_requests_total{route="/blocks",method="GET",status="500"} 2
indexer_http_requests_total{route="other",method="GET",status="404"} 168
# TYPE indexer_http_request_duration_seconds histogram
indexer_http_request_duration_seconds_bucket{route="/blocks",method="GET",le="0.005"} 80
indexer_http_request_duration_seconds_bucket{route="/blocks",method="GET",le="+Inf"} 87
indexer_http_request_duration_seconds_sum{route="/blocks",method="GET"} 0.435
indexer_http_request_duration_seconds_count{route="/blocks",method="GET"} 87
indexer_http_response_bytes_total{route="/blocks",encoding="identity"} 681035
indexer_http_response_bytes_total{route="/blocks",encoding="zstd"} 1000
indexer_http_requests_in_flight{route="/blocks"} 1
indexer_http_requests_rejected_total{route="other",reason="not_found"} 168
indexer_jsonrpc_requests_total{path="/shadow-rpc",rpc_method="eth_chainId",source="stored",outcome="ok"} 168
indexer_jsonrpc_requests_total{path="/shadow-rpc",rpc_method="unknown",source="none",outcome="method_not_found"} 84
indexer_jsonrpc_request_duration_seconds_sum{path="/shadow-rpc",rpc_method="eth_chainId"} 0.336
indexer_jsonrpc_request_duration_seconds_count{path="/shadow-rpc",rpc_method="eth_chainId"} 168
indexer_cache_requests_total{cache="list",result="hit"} 139
indexer_cache_requests_total{cache="list",result="miss"} 61
indexer_cache_requests_total{cache="list",result="coalesced"} 3
indexer_cache_entries{cache="list"} 2
indexer_cache_bytes{cache="list"} 231680
indexer_cache_evictions_total{cache="list",reason="ttl"} 4
indexer_cache_evictions_total{cache="list",reason="capacity"} 1
indexer_db_query_duration_seconds_sum{route="/blocks"} 0.174
indexer_db_query_duration_seconds_count{route="/blocks"} 174
indexer_db_query_duration_seconds_sum{route="none"} 2.709
indexer_db_query_duration_seconds_count{route="none"} 813
indexer_lag_blocks 4
indexer_process_start_time_seconds 1000
indexer_process_resident_memory_bytes 169058304
indexer_process_heap_used_bytes 20017327
indexer_build_info{commit="42a3317",built_at="2026-09-05T14:39:20Z"} 1
`;

const samples = parsePrometheusText(SAMPLE);

describe("parsePrometheusText", () => {
  test("skips comments and keeps name, labels and value", () => {
    expect(samples.some((sample) => sample.name.startsWith("#"))).toBe(false);
    const blocks = samples.find(
      (sample) => sample.name === "indexer_http_requests_total" && sample.labels.status === "200",
    );
    expect(blocks).toEqual({
      name: "indexer_http_requests_total",
      labels: { route: "/blocks", method: "GET", status: "200" },
      value: 85,
    });
  });

  test("reads unlabelled series and +Inf", () => {
    expect(gauge(samples, "indexer_lag_blocks")).toBe(4);
    const inf = samples.find(
      (sample) => sample.name === "indexer_http_request_duration_seconds_bucket" && sample.labels.le === "+Inf",
    );
    expect(inf?.value).toBe(87);
  });

  test("sumBy totals across label sets, with an optional filter", () => {
    expect(sumBy(samples, "indexer_http_requests_total")).toBe(255);
    expect(sumBy(samples, "indexer_http_requests_total", (labels) => labels.route === "/blocks")).toBe(87);
  });

  test("tolerates junk lines", () => {
    expect(parsePrometheusText("not a metric line\n\nfoo_total 3")).toEqual([
      { name: "foo_total", labels: {}, value: 3 },
    ]);
  });
});

describe("routeTraffic", () => {
  const rows = routeTraffic(samples);

  test("orders by request count and splits client from server errors", () => {
    expect(rows.map((row) => row.route)).toEqual(["other", "/blocks"]);
    const blocks = rows.find((row) => row.route === "/blocks");
    expect(blocks?.requests).toBe(87);
    expect(blocks?.serverErrors).toBe(2);
    expect(blocks?.clientErrors).toBe(0);
    expect(rows.find((row) => row.route === "other")?.clientErrors).toBe(168);
  });

  test("means are per request, and egress adds up across encodings", () => {
    const blocks = rows.find((row) => row.route === "/blocks");
    expect(blocks?.meanSeconds).toBeCloseTo(0.005, 6);
    expect(blocks?.meanDbSeconds).toBeCloseTo(0.002, 6);
    expect(blocks?.dbQueriesPerRequest).toBeCloseTo(2, 6);
    expect(blocks?.responseBytes).toBe(682035);
    expect(blocks?.inFlight).toBe(1);
  });

  test("a route with no timings reports no mean rather than zero", () => {
    const other = rows.find((row) => row.route === "other");
    expect(other?.meanSeconds).toBeUndefined();
    expect(other?.meanDbSeconds).toBeUndefined();
  });

  test("background queries under the none route are not invented as a route", () => {
    expect(rows.some((row) => row.route === "none")).toBe(false);
  });
});

describe("rpcTraffic", () => {
  const rows = rpcTraffic(samples);

  test("counts calls per method and names who answered", () => {
    const chainId = rows.find((row) => row.method === "eth_chainId");
    expect(chainId?.calls).toBe(168);
    expect(chainId?.sources).toEqual(["stored"]);
    expect(chainId?.errors).toBe(0);
    expect(chainId?.meanSeconds).toBeCloseTo(0.002, 6);
  });

  test("a non-ok outcome counts as an error", () => {
    const unknown = rows.find((row) => row.method === "unknown");
    expect(unknown?.calls).toBe(84);
    expect(unknown?.errors).toBe(84);
    expect(unknown?.meanSeconds).toBeUndefined();
  });
});

describe("cacheStats", () => {
  test("hit rate ignores coalesced lookups", () => {
    const [list] = cacheStats(samples);
    expect(list?.hitRatio).toBeCloseTo(0.695, 6);
    expect(list?.coalesced).toBe(3);
    expect(list?.entries).toBe(2);
    expect(list?.bytes).toBe(231680);
    expect(list?.evictions).toBe(5);
  });

  test("a cache with no lookups yet has no hit rate", () => {
    const [empty] = cacheStats(parsePrometheusText('indexer_cache_entries{cache="idle"} 0'));
    expect(empty?.hitRatio).toBeUndefined();
  });
});

describe("processStats", () => {
  test("derives uptime from the start time and totals the counters", () => {
    const stats = processStats(samples, new Date(3600 * 1000));
    expect(stats.uptimeSeconds).toBe(2600);
    expect(stats.residentBytes).toBe(169058304);
    expect(stats.totalRequests).toBe(255);
    expect(stats.totalRpcCalls).toBe(252);
  });

  test("an empty registry yields no readings rather than zeros", () => {
    const stats = processStats([], new Date());
    expect(stats.uptimeSeconds).toBeUndefined();
    expect(stats.residentBytes).toBeUndefined();
    expect(stats.totalRequests).toBe(0);
  });
});
