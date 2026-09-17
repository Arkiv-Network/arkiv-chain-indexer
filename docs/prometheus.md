# Prometheus metrics

The backend serves Prometheus text metrics on `GET /metrics`. The full metric list lives in the
README under [`GET /metrics`](../README.md#get-metrics); this page covers scraping and a few starter
queries.

As of v0.5.11, every metric exposed by the backend starts with `indexer_`, including
histogram buckets, sums and counts. Update existing dashboards, recording rules and alerts by
adding `indexer_` to previously unprefixed names (for example, `http_requests_total` becomes
`indexer_http_requests_total`). Names already starting with `indexer_` are unchanged; old names
are no longer emitted.

## Scraping

`GET /metrics` is open without authentication. Deployment networking and proxy rules control external access.
The public nginx sites return `404` for `/api/metrics`, so scrape the backend on its loopback port
from the same host. With the default compose binding (`BACKEND_HOST=127.0.0.1`, `BACKEND_PORT=3000`):

```yaml
scrape_configs:
  - job_name: arkiv-chain-indexer
    scrape_interval: 15s
    static_configs:
      - targets: ["127.0.0.1:3000"]
        labels:
          network: tiramisu
```

Several compose stacks on one host (e.g. `BACKEND_PORT=3001` for a second network) are separate
targets with their own `network` label.

Check it by hand:

```sh
curl -s http://127.0.0.1:3000/metrics | head -40
```

### From off the host

A scraper that cannot reach loopback uses `GET /admin/metrics`, which the nginx sites do proxy. It
serves the same registry and requires an administrator login session or a generated access token.
Create tokens in the signed-in administrator **Access tokens** panel and replace them before expiry
(maximum 30 days). These tokens grant all administrator API permissions, including Baseload and Shadow RPC.

```yaml
scrape_configs:
  - job_name: arkiv-chain-indexer-kalarepa
    scheme: https
    metrics_path: /api/admin/metrics
    authorization:
      credentials: "<ARKIV_ACCESS_TOKEN>"
    static_configs:
      - targets: ["kalarepa.arkiv-global.net"]
        labels:
          network: tiramisu
```

```sh
curl -s -H "authorization: Bearer $ARKIV_ACCESS_TOKEN" \
  https://kalarepa.arkiv-global.net/api/admin/metrics | head -40
```

Prefer the loopback target where you have it: it keeps the metrics credential off the wire, and it is not
subject to the CDN in front of the public origin.

## Starter queries

Requests per second by endpoint:

```promql
sum by (route) (rate(indexer_http_requests_total[5m]))
```

p95 latency per endpoint:

```promql
histogram_quantile(0.95, sum by (route, le) (rate(indexer_http_request_duration_seconds_bucket[5m])))
```

Error ratio per endpoint (5xx over everything):

```promql
sum by (route) (rate(indexer_http_requests_total{status=~"5.."}[5m]))
  / sum by (route) (rate(indexer_http_requests_total[5m]))
```

Egress per endpoint, in bytes per second on the wire:

```promql
sum by (route, encoding) (rate(indexer_http_response_bytes_total[5m]))
```

JSON-RPC calls per method, and which side answered them:

```promql
sum by (rpc_method, source) (rate(indexer_jsonrpc_requests_total[5m]))
```

Share of a route's time spent in Postgres:

```promql
sum by (route) (rate(indexer_db_query_duration_seconds_sum[5m]))
  / sum by (route) (rate(indexer_http_request_duration_seconds_sum[5m]))
```

Cache hit ratio:

```promql
sum by (cache) (rate(indexer_cache_requests_total{result="hit"}[5m]))
  / sum by (cache) (rate(indexer_cache_requests_total{result=~"hit|miss"}[5m]))
```

Index lag, for alerting:

```promql
indexer_lag_blocks > 50 or indexer_head_age_seconds > 120
```

## Notes

- Successful scrapes of `/metrics` and `/admin/metrics` are excluded from the traffic metrics;
  rejected ones are counted, so `indexer_http_requests_rejected_total{route="/admin/metrics"}` shows anyone
  probing the metrics credential.
- Routes are templates (`/transaction/:hash`), never raw paths; unknown paths are `other`, unknown
  JSON-RPC method names are `unknown`. Query strings are never labels.
- `indexer_cache_requests_total` and `indexer_cache_evictions_total` mirror the caches' own counters at scrape time,
  so they reset with the process like any counter.
- The scanner, aggregator and gap-filler processes do not expose metrics yet; scanner progress gauges are
  read from `scanner_state` by the backend.
- With `ENTITY_QUERY_INDEX` on, `indexer_entity_index_*` gauges report the index floor and projection head, the
  last live-entity count, and the genesis import's `total` / `imported`.
