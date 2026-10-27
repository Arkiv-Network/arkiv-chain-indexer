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
- Calldata is never persisted, and neither is the content of any `bytes` attribute — only Arkiv operation
  metadata (attribute names, type ids, indexed flags, values of the non-bytes types, sizes, and a bytes value's
  keccak256), the transaction hash, and receipt event logs (address, topics, ABI data — `transaction_logs`). The raw
  `input` field must never reach the database; a decoder response carrying a bytes value is refused.
- One database per chain and data model. Tables are created in their final shape and never migrated: do not add
  `ADD COLUMN IF NOT EXISTS` / legacy index drops. `scanner_state.data_model` (`DATA_MODEL` in `src/storage.ts`)
  marks the model and `scanner_state.genesis_hash` the chain; `ScannerStorage.open` refuses a schema with data but
  no (or another) marker before any DDL, the scanner and gap filler refuse a node whose block 0 is not the recorded
  one (`bindGenesisHash`), and the backend checks the recorded hash against the stored block 0. Bump `DATA_MODEL`
  whenever the stored shape changes.
- Rent is not gas. `transaction_fee_wei` (and every "fee" field) stays `gasUsed × effectiveGasPrice` —
  `eth_feeHistory` and the priority-fee oracle depend on it; the receipt's `rentFee` goes to `rent_fee_wei` /
  `total_rent_fee_wei`, `total_burned_wei = burnt_fees_wei + total_rent_fee_wei`, and API rows add `totalCostWei`.
- Keep network-dependent tests opt-in. Normal `bun test` should not require an RPC endpoint **or** a database;
  storage / aggregator / server tests skip themselves unless `TEST_DATABASE_URL` is set.

## Metric Conventions

- `burnt_fees_wei` is `baseFeePerGas × Σ receipt.gasUsed`, never the header's `gasUsed`: Arkiv blocks charge
  their expiry sweep's gas to the header, and no balance pays it. `total_gas_used` stays the header's value.

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
- `src/arkivOperations.ts` POSTs `{"data": calldata}` to the external arkiv-transaction-decoder (Bun, v0.3)
  microservice at `<DECODER_URL>/decode` (compose service `decoder`, defaulted by compose to
  `http://decoder:28884`). It reads only the UDC contract — `{"format": "udc", "operations": [...]}`, every
  operation carrying every field (`null` where it does not apply), attributes as
  `{name, typeId, type, indexed, value, size, keccak256?, error?}` with values in the node's `arkiv_query`
  encoding — and anything else throws a `DecoderContractError` naming the decoder version (`GET /version`), so the
  block retries instead of storing a guess. "Anything else" is strict: an ABI word wider than its type (`salt` over
  uint128, `expiresAt` / `minLifetime` over uint64), an unflagged triple whose value is not exactly the node's
  encoding of its typeId's type, a bytes typeId (`typeId & 0x7f == 7`) with a value, and — on a *successful*
  transaction only — any decoder `error` on an operation or a triple (the node refuses those before mining; on a
  reverted transaction they are kept). The fold likewise stops (`EntityFoldError`) on an applied triple it cannot
  store or an event word wider than the engine's, instead of dropping it. Decoded operation metadata (exact `expires_at` / `min_lifetime` /
  `salt` as NUMERIC, `creation_flags`, `new_owner`, `bytes_size`, `schema_name` = the indexed str `arkiv.schema`,
  attributes JSONB) is stored in `transaction_operations` in the same transaction as the block's transaction rows.
  A decoder HTTP 400 means "not an Arkiv execute() call" (skip); any other decoder failure makes the whole block
  retry. The decoder's `permanent` flag is not stored: permanence is a property of the *resolved* expiry,
  `max(expiresAt, block + minLifetime)` capped at 2^64 − 1 (`resolveOperationExpiry`), which the API serves as
  `resolvedExpiresAt` / `permanent`. The HTTP API attaches `operations` to `GET /transaction/<hash>` and
  `operationsSummary` to `GET /transactions` rows that have stored operations.
- `src/storage.ts` uses the pooled Bun SQL client through `src/db.ts`. The whole storage API is async;
  `db.transaction()` wraps `sql.begin()` so every write uses the same transaction connection. Storage optionally
  takes a `schema` so tests can run in isolated schemas against a shared database.
- `src/scanner.ts` owns retry and resume behavior.
- `src/metrics.ts` owns all block metric calculations.
- `src/server.ts` exposes `GET /blocks` and `GET /ranges` (built on `Bun.serve`) plus a `GET /health` probe.
  Public reads return permissive CORS headers; auth/admin responses use private headers and exact Origin checks. All
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
  loopback backend port or `/api/admin/metrics`. `/metrics` is open without authentication or forwarding-header
  checks; deployment controls external exposure. `/admin/metrics` requires an administrator session or
  generated temporary access token. Successful scrapes are excluded from traffic metrics; rejected ones are counted.
- `src/jsonRpc.ts` serves `POST /shadow-rpc` (`JSON_RPC_PATH` in `src/server.ts`; `/api/shadow-rpc` publicly,
  once nginx and the frontend proxy strip `/api`), an Ethereum JSON-RPC 2.0 surface answered from stored
  data, with an allowlisted node passthrough below. The path demands administrator authentication: a session
  with configured Origin and X-CSRF-Token, or a temporary access token (it spends the upstream's quota).
  `/shadow-rpc/experimental` is open
  and explicitly receives no passthrough forwarder. The entity explorer uses neither: it queries the indexed
  chain's node through the Arkiv SDK and the `/entity-explorer/rpc` relay (see the entity explorer note below).
  `latest` means the indexed head (`scanner_state.last_successful_block`);
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
  `SHADOW_RPC_UPSTREAM` (see `serverConfig.ts`) relays an allowlist — `eth_sendRawTransaction` and the four
  `ARKIV_READ_METHODS` by default — to a real node and returns its answers unchanged. With no explicit upstream, it resolves the
  scanner-recorded node; until a node is available, forwarded methods return `-32000`. Three rules hold: **allowlist only**, never an open proxy; a
  listed method **outranks the local handler and the transaction-data gate**, which makes the list a general
  escape hatch (list `eth_getTransactionCount` to serve the node's live nonce instead of the indexed one);
  and **nothing about the upstream leaks** — the URL may embed a key, so only the node's own JSON-RPC `error`
  object is relayed, while transport failures answer a fixed `-32000` and log the cause. Forwarded calls are
  rate limited endpoint-wide (`600/min`) because a public endpoint fronting a metered node is a way to spend
  someone else's quota. With no `SHADOW_RPC_UPSTREAM` the relay follows the node the scanner recorded in
  `scanner_state` (`scanner_rpc_url`, written by `src/index.ts` at startup), resolved on first use. `jsonRpc.ts`
  declares the `JsonRpcForwarder` interface so the dependency points one way; `/health` lists the forwarded
  methods under `features.jsonRpcPassthrough`.
- The entity index (on by default; `ENTITY_QUERY_INDEX=false` turns it off; `POST /shadow-rpc/experimental`,
  `JSON_RPC_EXPERIMENTAL_PATH` in `server.ts`) answers the UDC node's `arkiv_*` reads (`arkiv_query`,
  `arkiv_getEntityCount`, `arkiv_getBlockTiming`; there is no `arkiv_getEntity`) from PostgreSQL on a path of
  its own, so `/shadow-rpc` keeps relaying them to the node and the two stay comparable
  (`scripts/compareEntityQuery.ts`). The wire contract is arkiv-state-db-experiment's `signed/rpc_reads.rs`:
  `select` takes exactly the SDK's `RpcSelect` keys (`payload`/`contentType` are `-32602`), `key` defaults on,
  quantities are JSON integers or canonical `0x` hex, every parameter fault is `-32602` `InvalidParams`, query
  and cursor/block errors use the node's `query rejected (<kind>): …` envelope — check the live node before
  changing any of it. The pieces: `entityQueryLanguage.ts` is a byte-offset port of the `arkiv-query` crate
  (`~/arkiv-network/arkiv`) with the UDC node's system-attribute rules (`$payload`/`$contentType` are the node's
  exact `-32002`); its other messages still follow the older crate (language parity is deferred);
  `entityValues.ts` holds the type ids, bounds and wire encodings (`dec` is stored as 18-place units, `u256`
  as `numeric`, strings compared bytewise via `value_text`, `bytes` as keccak256 + size); `entityIndex.ts`
  folds one key's operations into versions (`foldEntityVersions`, pure — patch mutations apply in order, a
  typed one sets value, type *and* indexed flag, a tombstone unsets, reverted transactions apply nothing,
  expiry comes from the `EntityCreated`/`ExpiryExtended` event when a log is stored and exactly
  `max(expiresAt, block + minLifetime)` otherwise); `entityQuerySql.ts` compiles the AST to correlated `EXISTS`
  over `entity_version_attributes` **with `AND a.indexed`** — a predicate never matches an unindexed attribute,
  as on the node; `entityIndexStorage.ts` owns the tables and the paging query (`ORDER BY created_at ASC,
  created_position ASC, created_op_index ASC` — the UDC node's entity-id order, creation order with operations
  in calldata order); `entityProjector.ts` folds forward in chunks and
  refolds keys whose operations landed below the fold point (`transaction_operations.scanned_at`), lowering
  the floor when a backfill brings keyed creates in below it, and runs the genesis import for seeded chains:
  `entityGenesis.ts` walks the node at block 0 oldest-first with every `RpcSelect` key (the indexed flag is only
  in `attributeSchema`), restarting the walk when the node forgot its cursor (`-32005`: UDC cursors are
  process-local) — rows are deterministic and written idempotently; `entityGenesisDump.ts` +
  `entityGenesisDumpImport.ts` load a payload-era seed's `state.jsonl` offline through
  `scripts/importGenesisState.ts` — the only script that writes to Postgres; no UDC codec reader exists yet —
  and `genesisProgress.ts` is the progress document both write; genesis
  rows are version 0 with `created_at = 0` and `created_position` = entity id, `foldEntityVersions` takes such a
  row as the base, one state row (`genesis_import`) tracks both importers, and the projector never folds while
  an import is `running`; `arkivJsonRpc.ts` is the method layer
  (projection, cursors, options, errors) and plugs into `jsonRpc.ts` through `localOverrides`. Invariants:
  never store `bytes` contents (their wire value from the index is `null`); every attribute is stored with its
  flag, indexed or not; `latest` is the projection head, never the scanner or chain head; blocks outside
  `[floor, head]` are `-32006`, never a silently partial answer. `GET /entity/:key` adds the index's newest
  state uncached (the projector folds after the scanner's NOTIFY). The node evaluates `$createdAt` ranges
  by scanning, so the comparison drops pre-floor entities from node walks instead of windowing every query.
  Index every address column paired with `expires_at`, never alone: an address keeps a row for every entity it ever owned and most of them have expired, so `(owner, expires_at)` turned a 95ms scan of 167k rows at a past block into 1ms.
- Account balances (`account_balances`, `SCANNER_TRACK_BALANCES`, default off) are **readings, never sums**.
  For each block the scanner takes the addresses that appeared as `from` or `to` and asks the node what they
  hold at that block (`EthereumRpcClient.getBalances`, batched `eth_getBalance` requests per block of at most
  `MAX_RPC_BATCH_SIZE` = 64 calls, the Arkiv node's batch cap — never
  one request per address: the scanner's request count is what its share of the RPC key quota buys). Do not
  replace this with arithmetic over `value_wei`: balances also move through contract-internal transfers, fee
  payments and withdrawals that a block's transaction list does not show, and the index has no genesis anchor
  to sum forward from, so a derived balance would drift silently. Rows are written in the block's own
  transaction and replaced wholesale on a rescan; nothing is backfilled, so coverage starts where the flag was
  switched on and the series is sparse (a row exists only where an address was touched). `getBalanceAt` takes
  the newest reading at or before a block; when there is none, `eth_getBalance` and `GET /balances` say so
  rather than answering `0x0` — an unindexed account and an empty one are different facts, and conflating them
  is the `eth_getLogs`-below-the-floor mistake again. Tracking reads each block's state, so it needs a node that
  serves past state; Jalebi serves only its head, and a failed read retries the block forever. For that case
  `GET /balances/live?address=` asks the indexed chain's node (the `/shadow-rpc` relay's node and key, allowlisted
  to `eth_getBalance` at `latest`, same rate limit) what an account holds now, uncached and with no history;
  the frontend's wallet page shows it.
- The frontend entity explorer (`/entity-explorer`, code in `frontend/src/entityExplorer/`) speaks the
  user-defined column format: entities carry typed attributes (indexed or stored only, zero or more `bytes`
  blobs, an `arkiv.schema` tag) instead of a payload and content type. It queries the node through
  `@arkiv-network/sdk@next`, by way of the backend's `POST /entity-explorer/rpc` (`/api/entity-explorer/rpc`
  publicly): a pure relay — `builtInMethods: false`, so nothing is answered from the index — of
  `ENTITY_EXPLORER_RPC_METHODS` (exactly what the frontend calls there: `arkiv_query`, `arkiv_getBlockTiming`;
  the transaction and entity pages' "Load from node" for a bytes value, `nodeBytes.ts`, is an `arkiv_query` too),
  built on `JsonRpcPassthrough`. The relay is open and only rate limited (issue #121 tracks its auth). It reads the indexed chain's own node — the one `/shadow-rpc` relays to
  (`SHADOW_RPC_UPSTREAM`, else the node the scanner recorded), with that relay's key, timeout and rate limit — so
  the explorer and the indexer always look at the same chain and there is nothing extra to configure; the
  frontend pins no chain. A key embedded in the node's URL (Jalebi accepts one as the last path segment, e.g.
  `…/sdk_test`) stays on the server. The node caps a page at 100 entities, and `select: "*"`
  leaves out `$attributeSchema`, so the explorer names every field it needs (`EXPLORER_SELECT`). It does not use
  `/shadow-rpc` or the entity index (query-language parity between the two is deferred, so the node is the
  reference). An entity's card links to its indexed history (`/entity/<key>`: versions, operations, rent),
  and that page links back to the explorer. Search sends a bare entity key to the explorer
  (`fullHashHref`). It fetches with TanStack Query and keeps `q`, `pageSize` and
  `expiration` in the URL with nuqs; the nuqs adapter wraps the page inside its lazy chunk, since no
  other page uses it. Layout: `EntityExplorerView.tsx` composes the page, `hooks/` holds the run
  (`useEntitySearch`) and saved queries, `components/` the UI, `lib/` the framework-free logic the frontend
  tests cover. `/data`, the page's old path, still resolves to it.
- Frontend data fetching goes through TanStack Query (`useQuery` / `useInfiniteQuery`), never `fetch` inside a
  `useEffect`. The one `QueryClient` is `frontend/src/queryClient.ts` (no retries, no refetch on focus), provided
  app-wide in `frontend/src/main.tsx`. Older views still fetch in effects; move them over when touching them.
- `src/ranges.ts` owns the parameterized aggregation math. Supported range sizes are
  `2, 5, 10, 20, 50, 100, 200, 500, 1000`; range boundaries are `[k * M, k * M + M - 1]`.
- `src/aggregator.ts` + `src/aggregate.ts` host the one-shot single-range aggregator
  (`bun run aggregate -- --range N`). The scanner does NOT aggregate inline.
- `src/aggregateAll.ts` (`bun run aggregate-all`) walks every supported range size on a loop, sleeping
  `AGGREGATE_INTERVAL_MS` (default 30s) between sweeps. This is the entry point the compose `aggregator` service
  uses.
- `src/collectStatistics.ts` (`bun run collect-statistics`, Compose `statistics`) gathers a read-only,
  repeatable-read snapshot of existing tables on a separate one-connection worker. It atomically replaces
  `STATISTICS_FILE`, shared read-only with the backend, for `GET /statistics` and the frontend Statistics page.
  Never fall back to full-table aggregation on an HTTP request. No database rows/schema are added for these
  statistics. Counts/bytes stay decimal strings; active entities are evaluated at the declared projection
  block, and unavailable entity state is null. See `docs/statistics.md` for coverage and measurement limits.
- `block_ranges` rows are keyed by `(range_size, range_start)` so multiple range sizes can coexist.
- `src/testPostgres.ts` provides `createIsolatedStorage()` for the integration tests — each test gets its own
  random schema and a cleanup function that drops it.

## Docker Compose

- `Dockerfile` (root) builds a single Bun image used by `scanner`, `aggregator`, and `backend` services. The
  service-specific entry point is picked via `command:` in `docker-compose.yml`. The image carries `src/` and
  `scripts/`, so the offline genesis importer runs in it (`docker compose run --rm backend bun run
  scripts/importGenesisState.ts ...`).
- `frontend/Dockerfile` builds the static UI and serves it with `frontend/server.js`. Its build context is
  `frontend/` plus a second context named `shared` for the repository's `src/` (declared in
  `docker-compose.yml` and `.github/workflows/publish-images.yml`), because `frontend/src` imports shared
  modules such as `src/omniSearchTypes.ts` from `../src`.
- Frontend UDC conventions: attributes from every source (decoded operation, index state, `arkiv_query`) go
  through `frontend/src/attributes.ts` (`AttributeView`, canonical text, EIP-55, query conditions only for
  indexed attributes, the `arkiv.schema` badge, patch diffs) and render in `components/attribute-table.tsx`.
  Permanence is `isPermanentExpiry` (exactly 2^64 − 1), never a lifetime estimate. Entity versions and a
  patch's old values come from folding `/entity/<key>` in `entityHistory.ts`. bytes contents are loaded on
  demand in the browser from the node (`nodeBytes.ts`, through the `/entity-explorer/rpc` relay, which stores
  nothing) and checked against the recorded keccak256; the index never holds them. The permanence tooltip names
  the node's rent cap only when `VITE_NODE_STATUS_URL` points at the node's `/signed/v1/status`. Query
  conditions (the attribute table's filter menu, the schema badge) open the entity explorer with `q`. The
  decoder link is off unless `VITE_TRANSACTION_DECODER_BASE_URL` is set.
- The `decoder` image this repo publishes is built by `.github/workflows/publish-images.yml` from
  arkiv-transaction-decoder's source at a pinned commit, with `--build-arg PORT=28884`. Deployments probe that
  port and never pass `PORT`, so it has to be baked in; the decoder binds 3000 on its own. v0.3.0 (the UDC
  format) is not tagged upstream, so both pin its commit (896e341): compose builds the `decoder` service from
  that git ref unless `ARKIV_DECODER_IMAGE` names another image, and sets `PORT` itself. Keep the two refs in
  lockstep.
- All required env vars live in `.env.example`.

## Google login and administrator access

- `src/auth.ts`, `authStorage.ts`, `googleOidc.ts`, and `authConfig.ts` implement Google OIDC code flow,
  PKCE/state/nonce and server-managed PostgreSQL sessions. The openid-client adapter explicitly enables
  signature/JWKS checks. Google access/ID tokens are discarded after identity validation.
- Google `sub` identifies users. Compute roles per request from the current allowlist, verified email and
  signed `hd=golem.network`; the sole initial administrator is `sieciech.czajka@golem.network`.
  Other Google users have public access plus identity/logout. Disabled users and revoked/expired sessions fail closed.
- Protected surfaces: all saved Baseload config routes, PUT /baseload, /shadow-rpc, /admin/metrics.
  Cookie writes and protected RPC require the configured exact Origin and session X-CSRF-Token. Auth/admin
  responses are no-store, without wildcard CORS or conditional GET. Public reads do not load auth storage.
- Host-only HttpOnly Secure SameSite=Lax cookies use `__Host-arkiv_session`; DB stores token hashes only.
  Login attempts are atomically consumed and rate capped across instances; expiry cleanup runs each minute.
  HTTP localhost cookies require explicit AUTH_INSECURE_LOCALHOST=true and a localhost AUTH_PUBLIC_ORIGIN.
- Administrator sessions can create/revoke temporary access tokens under `/auth/access-tokens`. Only hashes
  are stored in `auth_access_tokens`; validity is 1–30 days, enforced by the service and database. Tokens grant
  all administrator API permissions except token management (session only). Recheck owner role/disabled state,
  expiry and revocation on every request. Reject ambiguous bearer+session requests. The legacy environment
  credentials METRICS_BEARER_TOKEN and BASELOAD_AUTOMATION_TOKEN no longer grant access.
- Kalarepa alone opts into AUTH_TOKEN_LOGIN_ENABLED=true plus AUTH_TOKEN_LOGIN_TOKEN (default disabled).
  POST /auth/token-login exchanges JSON email/token for a session, requires exact Origin, bounds the body,
  and shares the database login rate cap. The entered email uses the current admin allowlist; all others are
  ordinary users. Keep provider=token identities separate from Google, with email_verified=false. Token
  sessions require the current token fingerprint on every lookup, so disabling or rotating the token rejects them.
  This is an explicit testing option, never a bearer API fallback; keep it disabled on proper deployments.
- `/auth/session` returns role/user/csrfToken/expiresAt/loginAvailable/tokenLoginAvailable. The frontend never stores credentials;
  custom node fetches omit cookies and CSRF even for application-origin URLs. Gate direct admin views as well
  as navigation; logout/role loss stops privileged polling and debug state.
- Normal tests only use TEST_DATABASE_URL when explicitly provided, never DATABASE_URL. Run with
  `bun --no-env-file test` when local .env contains real application credentials. OAuth fixture tests mock
  discovery/JWKS with signed tokens; real account login and HTTPS callback validation remain opt-in manual checks.
- See docs/google-login.md for configuration, rollout and scraper migration. Auth callback request queries
  must not be logged by proxies. Do not expose client secrets, tokens, authorization codes or state in logs.
