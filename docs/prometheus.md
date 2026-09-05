# Prometheus metrics

The backend serves Prometheus text metrics on `GET /metrics`. The full metric list lives in the
README under [`GET /metrics`](../README.md#get-metrics); this page covers scraping and a few starter
queries.

## Scraping

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
    # Only when METRICS_BEARER_TOKEN is set on the backend:
    # authorization:
    #   credentials: "<token>"
```

Several compose stacks on one host (e.g. `BACKEND_PORT=3001` for a second network) are separate
targets with their own `network` label.

Check it by hand:

```sh
curl -s http://127.0.0.1:3000/metrics | head -40
```

## Starter queries

Requests per second by endpoint:

```promql
sum by (route) (rate(http_requests_total[5m]))
```

p95 latency per endpoint:

```promql
histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))
```

Error ratio per endpoint (5xx over everything):

```promql
sum by (route) (rate(http_requests_total{status=~"5.."}[5m]))
  / sum by (route) (rate(http_requests_total[5m]))
```

Egress per endpoint, in bytes per second on the wire:

```promql
sum by (route, encoding) (rate(http_response_bytes_total[5m]))
```

JSON-RPC calls per method, and which side answered them:

```promql
sum by (rpc_method, source) (rate(jsonrpc_requests_total[5m]))
```

Share of a route's time spent in Postgres:

```promql
sum by (route) (rate(db_query_duration_seconds_sum[5m]))
  / sum by (route) (rate(http_request_duration_seconds_sum[5m]))
```

Cache hit ratio:

```promql
sum by (cache) (rate(cache_requests_total{result="hit"}[5m]))
  / sum by (cache) (rate(cache_requests_total{result=~"hit|miss"}[5m]))
```

Index lag, for alerting:

```promql
indexer_lag_blocks > 50 or indexer_head_age_seconds > 120
```

## Notes

- Scrapes of `/metrics` are excluded from the traffic metrics.
- Routes are templates (`/transaction/:hash`), never raw paths; unknown paths are `other`, unknown
  JSON-RPC method names are `unknown`. Query strings are never labels.
- `cache_requests_total` and `cache_evictions_total` mirror the caches' own counters at scrape time,
  so they reset with the process like any counter.
- The scanner, aggregator and gap-filler processes do not expose metrics yet; `indexer_*` gauges are
  read from `scanner_state` by the backend.
