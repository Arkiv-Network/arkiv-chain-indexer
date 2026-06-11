# AGENTS.md

## Project Overview

This repository contains a Bun + TypeScript Ethereum block scanner. It stores one row per block in
**PostgreSQL** and tracks scanner progress so restarts continue from the last successfully stored block. A
docker-compose stack runs Postgres, the scanner, a periodic aggregator, the HTTP backend, and a small static
frontend.

## Commands

```sh
bun install
bun test
DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \
  bun run scan
DATABASE_URL=postgres://gas:gas@localhost:5432/gas bun run aggregate -- --range 50
DATABASE_URL=postgres://gas:gas@localhost:5432/gas bun run aggregate-all -- --once
DATABASE_URL=postgres://gas:gas@localhost:5432/gas bun run serve
docker compose up --build
```

## Important Invariants

- Do not skip failed block reads. A failed block must be retried until it succeeds or the process is stopped.
- Do not advance `scanner_state.last_successful_block` unless the block metrics row was also written successfully.
- Keep block writes and progress updates in the same PostgreSQL transaction (single pooled client, `BEGIN` /
  `COMMIT` / `ROLLBACK`).
- Preserve wei and gas precision. Store large integer values as decimal strings and use `bigint` for calculations.
- Fetch transaction receipts sequentially for the current block so the scanner handles transactions one by one.
- Transaction payloads/calldata are never persisted — only Arkiv operation metadata, the payload size, and the
  transaction hash. The decoder's `payload.hex` / `payload.text` and the raw `input` field must never reach the
  database.
- Keep network-dependent tests opt-in. Normal `bun test` should not require an RPC endpoint **or** a database;
  storage / aggregator / server tests skip themselves unless `TEST_DATABASE_URL` is set.

## Metric Conventions

- `base_block_fee_wei` comes from block `baseFeePerGas`; use `0` if the network does not provide it.
- `max_gas_in_block` is block `gasLimit`.
- Transaction fee size is `receipt.gasUsed * receipt.effectiveGasPrice`.
- Priority fee is `max(effectiveGasPrice - baseFeePerGas, 0)`.
- Weighted priority fee is weighted by receipt gas used.
- Average fee price is the simple per-transaction average of `effectiveGasPrice`.
- Average transaction size is the simple per-transaction average of `receipt.gasUsed`.
- Empty blocks store `0` for average values.

## Implementation Notes

- Runtime code lives in `src/`.
- `src/rpc.ts` intentionally uses raw JSON-RPC over `fetch` to avoid runtime dependencies.
- `src/arkivOperations.ts` talks to the external arkiv-transaction-decoder microservice (compose service
  `decoder`, env `DECODER_URL`, defaulted by compose to `http://decoder:3000`). Decoded operation metadata is
  stored in `transaction_operations` (no payloads) in the same transaction as the block's transaction rows. A
  decoder HTTP 400 means "not an Arkiv execute() call" (skip); any other decoder failure makes the whole block
  retry. The HTTP API attaches `operations` to `GET /transaction/<hash>` and `operationsSummary` to
  `GET /transactions` rows that have stored operations.
- `src/storage.ts` uses `pg` (node-postgres) with a connection pool. The whole storage API is async. Optionally
  takes a `schema` so tests can run in isolated schemas against a shared database.
- `src/scanner.ts` owns retry and resume behavior.
- `src/metrics.ts` owns all block metric calculations.
- `src/server.ts` exposes `GET /blocks` and `GET /ranges` (built on `Bun.serve`) plus a `GET /health` probe.
  CORS headers are returned on every response so the static frontend can fetch from a different origin. All
  filters combine additively; results are always capped at the smallest 10,000 matching rows. Entry point:
  `src/serve.ts` (`bun run serve`).
- `src/ranges.ts` owns the parameterized aggregation math. Supported range sizes are
  `2, 5, 10, 20, 50, 100, 200, 500, 1000`; range boundaries are `[k * M, k * M + M - 1]`.
- `src/aggregator.ts` + `src/aggregate.ts` host the one-shot single-range aggregator
  (`bun run aggregate -- --range N`). The scanner does NOT aggregate inline.
- `src/aggregateAll.ts` (`bun run aggregate-all`) walks every supported range size on a loop, sleeping
  `AGGREGATE_INTERVAL_MS` (default 60s) between sweeps. This is the entry point the compose `aggregator` service
  uses.
- `block_ranges` rows are keyed by `(range_size, range_start)` so multiple range sizes can coexist.
- `src/testPostgres.ts` provides `createIsolatedStorage()` for the integration tests — each test gets its own
  random schema and a cleanup function that drops it.

## Docker Compose

- `Dockerfile` (root) builds a single Bun image used by `scanner`, `aggregator`, and `backend` services. The
  service-specific entry point is picked via `command:` in `docker-compose.yml`.
- `frontend/Dockerfile` builds an nginx image serving the static UI.
- All required env vars live in `.env.example`.
