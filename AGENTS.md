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
- Transaction payloads/calldata are never persisted — only Arkiv operation metadata, the payload size, the
  transaction hash, and receipt event logs (address, topics, ABI data — `transaction_logs`). The decoder's `payload.hex` / `payload.text` and the raw `input` field must never reach the
  database. This holds under reference mode too: we persist the payload reference's receipt metadata
  (`payload_reference`) and the verification verdict (`reference_verification`), but never the referenced entity
  bytes (the bytes live in the payload provider, not on-chain).
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
- `src/arkivOperations.ts` POSTs to the external arkiv-transaction-decoder (Bun) microservice at
  `<DECODER_URL>/decode` (compose service `decoder`, defaulted by compose to `http://decoder:28884`). It sends the
  chain id obtained once from `eth_chainId` so a decoder that verifies v1 payload references uses the right
  trusted-signer allowlist; arkiv-transaction-decoder does not parse references and ignores it. Decoded operation
  metadata — including `is_reference`, the parsed `payload_reference`, the offline `reference_verification` verdict,
  and `reference_error` — is stored in `transaction_operations` (no payloads) in the same transaction as the block's
  transaction rows. A decoder HTTP 400 means "not an Arkiv execute() call" (skip); any other decoder failure makes
  the whole block retry. The HTTP API attaches `operations` to `GET /transaction/<hash>` and `operationsSummary` to
  `GET /transactions` rows that have stored operations.
- `src/storage.ts` uses `pg` (node-postgres) with a connection pool. The whole storage API is async. Optionally
  takes a `schema` so tests can run in isolated schemas against a shared database.
- `src/scanner.ts` owns retry and resume behavior.
- `src/metrics.ts` owns all block metric calculations.
- `src/server.ts` exposes `GET /blocks` and `GET /ranges` (built on `Bun.serve`) plus a `GET /health` probe.
  CORS headers are returned on every response so the static frontend can fetch from a different origin. All
  filters combine additively; results are always capped at the smallest 10,000 matching rows. Entry point:
  `src/serve.ts` (`bun run serve`). List endpoints (`/blocks`, `/ranges`, `/transactions`,
  `/transaction-records`, `/senders`, `/guzzlers`, and `/entity/:entityKey` operations) send compact rows —
  one `names` array plus per-row value arrays, so keys are not repeated per row — and negotiate
  `Content-Encoding`, preferring `zstd` and falling back to `gzip` (a CDN in front of the origin typically
  asks for gzip only, so without that fallback list bodies leave the process uncompressed);
  `frontend/src/api.ts` expands rows back into objects, so the compact wire format
  stays invisible to view components.
- `GET /entity/:entityKey` returns the most recent `ENTITY_HISTORY_LIMIT` (default 100) operations plus
  `totalOperations`/`truncated`, and `firstOperation` when the create fell outside the slice. Responses
  (including 404s) are cached in a `ResponseCache` (`src/responseCache.ts`) — bounded by entries (default
  10,000), bytes (default 64 MiB), and a TTL backstop (default 5 min); any set to 0 disables caching.
  Writers queue one Postgres `pg_notify` per changed entity key inside the block-write transaction
  (schema-scoped channel, `ScannerStorage.entityOperationsChannel()`); `serve.ts` LISTENs and evicts on
  delivery, so cached entries go stale only if the LISTEN connection drops, and then at most for the TTL.
- Every committed block write also notifies `ScannerStorage.storedBlocksChannel()`. `serve.ts` uses it two
  ways: `GET /sync` is served from an actively precomputed body (`src/precomputedResponse.ts`) that
  recomputes right after each stored block (bursts coalesced to one recompute per 500ms) plus a
  `SYNC_REFRESH_MS` (default 5s) periodic refresh so lag keeps growing when the scanner stalls; and a
  second `ResponseCache` holds `GET /blocks` / `GET /ranges` bodies keyed by query string + encoding (each
  compressed variant is derived from the cached plain JSON, so the row query and compression run once per
  key), cleared on every stored-block notification with a `LIST_CACHE_TTL_MS` (default 5s) backstop.
- `GET /transactions` is the only paged endpoint (`page` + `limit`, max 1,000/page; `/blocks`, `/ranges` and
  `/senders` instead cap at 10,000 and are walked with `blockLt`/`blockGt`). Both orderings it uses —
  `(block_number, position)` and, for an address, `(nonce, block_number, position)` — end in the primary key,
  so they are total orders and pages cannot overlap. Any page past the first is served by a deferred join:
  a subquery selects only the key columns (an index-only scan, so skipped rows cost no heap access) and the
  returned page is joined back to the full rows, ~6x faster by the deepest page. Keep the outer `ORDER BY`
  — a join does not preserve the subquery's order — and keep page 1 on the simple plan.
- The same notification clears a `ValueCache` (`src/valueCache.ts`, the scalar sibling of `ResponseCache`)
  holding `GET /transactions` pagination totals keyed by filter only, so all pages of one query share one
  count. This matters more than it looks: an unfiltered `COUNT(*)` scans every transaction row, and load
  testing showed it single-handedly capping the whole backend — every other Postgres-backed endpoint queues
  behind it. Keep the key free of `limit`/`page`/`order`, and prefer fixing the count over adding indexes.
- `src/prometheus.ts` is a dependency-free Prometheus client (Counter/Gauge/Histogram/Registry + text
  renderer); `src/serverMetrics.ts` defines the backend's metrics on a process-global registry and serves them at
  `GET /metrics`. `handleRequest` wraps every request in `observeHttpRequest`, which labels traffic by a *route
  template* from `ROUTE_TEMPLATES` (never the raw path or query) — add a line there when adding a route, or it
  is counted under `other`. Response constructors in `src/server.ts` call `recordResponseBytes` so egress can be
  counted without re-reading bodies. `src/db.ts` times every query and attributes it to the current route via
  `AsyncLocalStorage`. JSON-RPC calls are counted per method in `handleSingle`; unknown method names are labelled
  `unknown` so clients cannot mint series. Cache stats and scanner progress are mirrored by collectors registered
  in `serve.ts` and refreshed at scrape time. The nginx site configs return 404 for `/api/metrics`; scrape the
  loopback backend port, or set `METRICS_BEARER_TOKEN`. `GET /admin/metrics` renders the same registry for
  off-host scrapers and is proxied publicly, so it always demands `BASELOAD_ADMIN_BEARER_TOKEN` and answers 503
  when none is set — never let that path fall open. Successful scrapes of either path are excluded from the traffic metrics; rejected ones are counted so admin-token probing is visible.
- `src/jsonRpc.ts` serves `POST /shadow-rpc` (`JSON_RPC_PATH` in `src/server.ts`; `/api/shadow-rpc` publicly,
  once nginx and the frontend proxy strip `/api`), an Ethereum JSON-RPC 2.0 surface answered from stored
  data — the only path to a node is the opt-in passthrough below. `latest` means the indexed head (`scanner_state.last_successful_block`);
  `eth_syncing` exposes the gap. Block/transaction/receipt objects keep the standard shape and set every
  field the scanner does not persist to `null` (roots, signatures, logs; `input` is always null by the
  calldata invariant). `blocks.block_hash` / `parent_hash` are filled for blocks scanned after the columns
  were added and deliberately not backfilled (older rows stay null and hash lookups of them return null).
  Receipt logs follow the same rule: `transaction_logs` rows are written with the block's transaction rows
  (`replaceTransactionsForBlock`), `transactions.log_count` is null for pre-logs rows so receipts can answer
  `logs: null` instead of `[]`, and `eth_getLogs` is capped at 10,000 blocks / 10,000 logs per call. The
  method handlers take a `JsonRpcDataSource` (a structural subset of `ScannerStorage`) so they unit-test
  against an in-memory fake; `eth_feeHistory` reproduces geth's gas-weighted percentile walk and the
  gas-price oracle its 60th-percentile-of-per-block-minimum-tip rule. The scanner persists `chain_id` into
  `scanner_state` at startup so `eth_chainId` needs no node. New methods go in `JSON_RPC_METHODS` and, when
  they read transaction rows, in `TRANSACTION_DATA_METHODS` so the transaction-data gate covers them.
  Inputs are parsed as leniently as a node parses them — `"params": null` counts as no parameters, and
  quantities may carry leading zeros (`0x01`) — because being stricter than the node only rejects callers
  that work against one; **outputs stay canonical** (`quantity()` emits minimal hex). `eth_getLogs` resolves
  the block hash of every returned log through one `getBlockHashesByNumber` call: doing it per block cost a
  round trip per distinct block in the result (~420ms for a 1,000-block query, versus ~10ms batched).
- `src/jsonRpcPassthrough.ts` is the one hole in that: a transaction has to reach a node's mempool, so
  `SHADOW_RPC_UPSTREAM` (see `serverConfig.ts`) relays an allowlist — `eth_sendRawTransaction` alone by
  default, since wallets sign locally — to a real node and returns its answers unchanged. Unset, nothing is
  forwarded and those methods stay `-32601`. Three rules hold: **allowlist only**, never an open proxy; a
  listed method **outranks the local handler and the transaction-data gate**, which makes the list a general
  escape hatch (list `eth_getTransactionCount` to serve the node's live nonce instead of the indexed one);
  and **nothing about the upstream leaks** — the URL may embed a key, so only the node's own JSON-RPC `error`
  object is relayed, while transport failures answer a fixed `-32000` and log the cause. Forwarded calls are
  rate limited endpoint-wide (`600/min`) because a public endpoint fronting a metered node is a way to spend
  someone else's quota. `jsonRpc.ts` declares the `JsonRpcForwarder` interface so the dependency points one
  way; `/health` lists the forwarded methods under `features.jsonRpcPassthrough`.
- The experimental entity index (`ENTITY_QUERY_INDEX`, `POST /shadow-rpc/experimental`,
  `JSON_RPC_EXPERIMENTAL_PATH` in `server.ts`) answers the `arkiv_*` reads from PostgreSQL on a path of its
  own, so `/shadow-rpc` keeps relaying them to the node and the two stay comparable
  (`scripts/compareEntityQuery.ts`; `scripts/seedEntityQueryFixtures.ts` seeds the fixture suite). The pieces:
  `entityQueryLanguage.ts` is a byte-offset port of the node's `arkiv-query` crate (`~/arkiv-network/arkiv`),
  and its tests pin the node's exact messages and positions — change a message only after checking the node;
  `entityValues.ts` holds the type ids, bounds and wire encodings (`dec` is stored as 18-place units, `u256`
  as `numeric`, strings compared bytewise via `value_text`); `entityIndex.ts` folds one key's operations into
  versions (`foldEntityVersions`, pure — tombstones unset, `$payload`/`$contentType` cells route to fields,
  reverted transactions apply nothing, expiry comes from the `EntityCreated`/`ExpiryExtended` event when a log
  is stored and from calldata otherwise); `entityQuerySql.ts` compiles the AST to correlated `EXISTS` over
  `entity_version_attributes`; `entityIndexStorage.ts` owns the tables and the paging query
  (`ORDER BY created_at DESC, created_position DESC, entity_key DESC` — the node's entity-id order: ids are
  allocated when a transaction commits, walking its staged deltas in **ascending key order**
  (`BTreeMap<EntityAddress, …>` in `arkiv-reth-statemanager`), so inside one transaction the operation index
  plays no part; across transactions it is creation order because a key can never be re-created); `entityProjector.ts` folds forward in chunks and
  refolds keys whose operations landed below the fold point (`transaction_operations.scanned_at`), lowering
  the floor when a backfill brings keyed creates in below it; `arkivJsonRpc.ts` is the method layer
  (projection, cursors, options, errors) and plugs into `jsonRpc.ts` through `localOverrides`. Invariants:
  never store payload bytes (`select.payload` is refused); `latest` is the projection head, never the
  scanner or chain head; blocks outside `[floor, head]` are `-32006`, never a silently partial answer;
  `creationFlags` is `null` rather than guessed for pre-logs creates. The node evaluates `$createdAt` ranges
  by scanning (~10s per page on cheesecake at a past block), so the comparison cuts node walks at the floor
  instead of windowing every query. Index every address column paired with `expires_at`, never alone: an address keeps a row for every entity it ever owned and most of them have expired, so `(owner, expires_at)` turned a 95ms scan of 167k rows at a past block into 1ms.
- Account balances (`account_balances`, `SCANNER_TRACK_BALANCES`, default off) are **readings, never sums**.
  For each block the scanner takes the addresses that appeared as `from` or `to` and asks the node what they
  hold at that block (`EthereumRpcClient.getBalances`, one batched `eth_getBalance` request per block — never
  one request per address: the scanner's request count is what its share of the RPC key quota buys). Do not
  replace this with arithmetic over `value_wei`: balances also move through contract-internal transfers, fee
  payments and withdrawals that a block's transaction list does not show, and the index has no genesis anchor
  to sum forward from, so a derived balance would drift silently. Rows are written in the block's own
  transaction and replaced wholesale on a rescan; nothing is backfilled, so coverage starts where the flag was
  switched on and the series is sparse (a row exists only where an address was touched). `getBalanceAt` takes
  the newest reading at or before a block; when there is none, `eth_getBalance` and `GET /balances` say so
  rather than answering `0x0` — an unindexed account and an empty one are different facts, and conflating them
  is the `eth_getLogs`-below-the-floor mistake again.
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
- The `decoder` image this repo publishes is built by `.github/workflows/publish-images.yml` from
  arkiv-transaction-decoder's source at a pinned commit, with `--build-arg PORT=28884`. Deployments probe that
  port and never pass `PORT`, so it has to be baked in; the decoder binds 3000 on its own. Compose runs the
  released upstream image directly and sets `PORT` itself.
- All required env vars live in `.env.example`.
