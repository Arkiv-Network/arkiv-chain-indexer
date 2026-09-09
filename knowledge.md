# Arkiv chain indexer knowledge

Consolidated on **2026-09-09** from Claude's 23 project memory notes, the parent
Arkiv workspace's RPC quota note, repository documentation, and local Git history.
Implementation checks refer to **`b473873491e698ce842506d23c4095cdfa066683` on `main`**
(package version `0.4.0`); the paragraphs marked **September 9, evening** cover the
commits through **`8baf173`**, tagged **`v0.5.0`**, and **`9dcfed4`**, tagged **`v0.5.1`**. This is a durable handoff: what was
built, why it works this way, operational lessons, and unfinished work.

**Evidence boundaries:** “code” describes files inspected at that commit;
“recorded” or a dated deployment/benchmark describes Claude's historical notes.
Running containers, remote deployments, credentials, and RPC endpoints were not
probed for this consolidation; the September 9 evening addendum did probe the local
Kalarepa and prefill stacks, and its observations are dated. Historical results are
not fresh health checks.
Credential values, private keys, and mnemonics have been omitted.

Navigation: [discrepancies](#documentation-and-memory-discrepancies) ·
[milestones](#what-was-done-milestones) ·
[deployment](#deployment-and-neighboring-repositories) ·
[API and performance](#http-api-caching-and-performance) ·
[entity engine](#entity-query-engine) · [genesis](#genesis--arkiv-prefill-pr-100) ·
[Baseload](#baseload-behavior-and-operating-lessons) ·
[RPC operations](#rpc-keys-rate-limits-resets-and-incidents) ·
[open work](#open-work-and-uncertainties-carried-forward) ·
[sources](#source-inventory).

## Orientation and decisions to preserve

- Bun + TypeScript scanner, PostgreSQL storage, HTTP/JSON-RPC backend, React/Vite
  explorer, Redis activity leaderboards, and configurable Baseload workers.
- A block and its scanner progress must commit together. Failed forward reads
  must retry rather than create a hole. Amounts use `bigint` and decimal strings.
- Never persist transaction input or entity payload bytes. Operation metadata,
  payload sizes, reference receipt metadata, and receipt event logs are allowed.
- Account balances are node readings for touched addresses, not reconstructed
  sums. Missing coverage must not become an invented zero balance.
- The public JSON-RPC path is `/api/shadow-rpc`; the backend sees `/shadow-rpc`.
  The old `/rpc` was renamed, not retained as an alias. The user chose “shadow”
  to communicate incomplete indexed coverage. WebSockets/subscriptions/filters
  were explicitly outside the requested scope.
- Historical block hashes, receipt logs, and balance readings were added without
  backfilling their old rows. This is separate from the supported historical
  block scanner and genesis entity import; “no backfill” is not a blanket ban on
  those features.
- Local Arkiv entity reads remain experimental on `/shadow-rpc/experimental`.
  The normal path can relay those methods to the node, preserving an independent
  comparison source.
- **Last recorded local setup:** this checkout is Kalarepa/Tiramisu after the
  September 8 consolidation. Older references to a second
  `../arkiv-chain-indexer-tiramisu` checkout are stale.
- **Last recorded RPC decision:** use the bouncer directly. The pooled proxy was
  retired at the user's request on September 8; its continued presence in Compose
  is not evidence that it should be re-enabled.
- Claude recorded a preference for small/medium work directly on `main`, with
  branches/PRs when explicitly requested for larger work (including PRs #95 and
  #100). This is workflow context, not an instruction to publish this document.

## Documentation and memory discrepancies

These were found while comparing the notes with the checkout. They are recorded
here without changing runtime code or `AGENTS.md`; applicable project instructions
still govern future edits.

| Topic | Older claim | Inspected implementation / later evidence |
| --- | --- | --- |
| PostgreSQL client | `AGENTS.md` says `pg` and a node-postgres pool | [src/db.ts](src/db.ts) wraps Bun's `SQL`, `sql.begin()`, and Bun-managed LISTEN; migration `27f49c5` was June 13. |
| Receipt fetching | `AGENTS.md` requires sequential fetching; `.env.example` calls concurrency a legacy no-op | [src/scanner.ts](src/scanner.ts) uses a bounded worker pool, added in `5b2043f`; [src/config.ts](src/config.ts) defaults concurrency to 20. This is an unresolved instructions/code discrepancy. |
| Aggregator interval | `AGENTS.md` says 60 seconds | [src/aggregateAll.ts](src/aggregateAll.ts) defaults to 30 seconds, matching `.env.example`. |
| Database-free tests | Docs say only `TEST_DATABASE_URL` enables integration tests | [src/testPostgres.ts](src/testPostgres.ts) falls back to `DATABASE_URL`. Bun also auto-loads `.env`; an ordinary test invocation may therefore use a database. |
| Passthrough defaults | First-pass memory includes `eth_sendTransaction`; `AGENTS.md` describes only raw submission | [src/jsonRpcPassthrough.ts](src/jsonRpcPassthrough.ts) defaults to `eth_sendRawTransaction` plus all four Arkiv read methods. `eth_sendTransaction` needs explicit configuration. No upstream means no forwarding. |
| Live Baseload configuration | A restart loses the running fleet | Fixed September 5 in `3419a76`: `baseload_live_config` persists it and wins over the startup file. |
| Receipt-wait wedge | Workers silently poll forever as `running` | September 4 code adds a 20-second stall check, `waiting`/`outpriced` states, and a 10-minute timeout when the transaction is not outpriced. |
| List compression | Cloudflare strips zstd, so origin responses are uncompressed | Gzip fallback was added in `34c3664`; the original finding explains that change. |
| Create entity keys | The decoder returns null create keys | Decoder calldata cannot supply generated keys, but `9d7f7f5` added recovery from `EntityCreated` receipt events. Older stored creates can still lack keys. |
| RPC batch cost | An old balance note claims quota charges per HTTP batch | The August 26 capacity test measured `Arkiv-Cost = 10 × N` for an N-call batch. Batching saves HTTP round trips, not necessarily quota. |
| Quota exhaustion | A key stays exhausted until the next calendar month | Later testing saw an exhausted key recover after about two minutes. Treat the response/header as evidence; deployment accounting was not a proven permanent cap. |
| Deployment identity | Pietruszka is this checkout; Kalarepa is a sibling clone | September 8 notes supersede this: one Kalarepa checkout, with the old Tiramisu Compose project name preserved. |
| Genesis watcher | The prefill Index card is not wired yet | A later paragraph of the same note records wiring and a successful Sourcify run; the remaining genesis checks were completed on September 9, evening (see the genesis section). |

## Architecture and data correctness

### Runtime map

| Area | Main files | Responsibility |
| --- | --- | --- |
| Scanner / RPC | [src/index.ts](src/index.ts), [src/scanner.ts](src/scanner.ts), [src/rpc.ts](src/rpc.ts), [src/config.ts](src/config.ts) | Safe head, retry/resume, raw JSON-RPC over `fetch`, receipt collection, optional balances. |
| Storage / DB | [src/storage.ts](src/storage.ts), [src/db.ts](src/db.ts) | Schema, atomic writes, queries, notifications, Bun SQL adapter. |
| Metrics / aggregation | [src/metrics.ts](src/metrics.ts), [src/ranges.ts](src/ranges.ts), [src/aggregator.ts](src/aggregator.ts), [src/aggregateAll.ts](src/aggregateAll.ts) | Exact block math and separately scheduled range aggregates. |
| HTTP backend | [src/serve.ts](src/serve.ts), [src/server.ts](src/server.ts), [src/serverConfig.ts](src/serverConfig.ts) | Startup, feature gates, API routes, caches, projector, Baseload. |
| Arkiv operations | [src/arkivOperations.ts](src/arkivOperations.ts), [src/payloadProviderPayments.ts](src/payloadProviderPayments.ts) | Decoder client, metadata-only normalization, generated keys, reference payment accounting. |
| Shadow RPC | [src/jsonRpc.ts](src/jsonRpc.ts), [src/jsonRpcPassthrough.ts](src/jsonRpcPassthrough.ts), [src/arkivJsonRpc.ts](src/arkivJsonRpc.ts) | Ethereum indexed answers, allowlisted upstream relay, experimental entity methods. |
| Entity index | [src/entityIndex.ts](src/entityIndex.ts), [src/entityIndexStorage.ts](src/entityIndexStorage.ts), [src/entityProjector.ts](src/entityProjector.ts) | Fold operations into historical entity versions, query and maintain projection. |
| Entity language | [src/entityQueryLanguage.ts](src/entityQueryLanguage.ts), [src/entityQuerySql.ts](src/entityQuerySql.ts), [src/entityValues.ts](src/entityValues.ts) | Node-compatible grammar, SQL compilation, typed values. |
| Genesis | [src/entityGenesis.ts](src/entityGenesis.ts), [src/entityGenesisDump.ts](src/entityGenesisDump.ts), [src/entityGenesisDumpImport.ts](src/entityGenesisDumpImport.ts), [src/genesisProgress.ts](src/genesisProgress.ts) | RPC/offline seed imports and shared progress reporting. |
| Baseload | [src/baseloadRuntime.ts](src/baseloadRuntime.ts), [src/baseloadConfig.ts](src/baseloadConfig.ts), [src/baseloadSchedule.ts](src/baseloadSchedule.ts) | Worker lifecycle, wallets, fees, schedules, persistence. |
| Frontend | [frontend/src](frontend/src), [frontend/server.js](frontend/server.js) | Explorer views, query editor, comparisons, static serving and API proxy. |

Compose also runs `backfill-scanner`, `gap-filler`, `sender-aggregator`, and an
optional batcher collector. `rpc-keys` and `rpc-proxy` are optional profiles.
The normal scanner runs forward; historical backfill belongs to its own service.
`SCANNER_DISABLE_BACKFILL=true` makes that service idle. Gap filling revisits
internal holes with per-cycle/per-block load bounds.

Guzzlers aggregates near-head sender activity into one-minute Redis buckets,
retained for 24 hours, and caches top-250 leaderboards once per minute for
`GET /guzzlers`; it does not require a separate PostgreSQL aggregation table.
The optional batcher collector adds queue/threshold readings to blocks that
already exist in scanner storage.

### Atomic writes and precision

- Store block metrics, transaction rows, logs, decoded operations, balance
  readings, and associated progress atomically through one transaction context.
  A rescan replaces the block's dependent rows; it must not leave half a block.
- `scanner_state.last_successful_block` is committed progress; observed chain
  head and safe head are separate facts.
- `src/db.ts` adapts Bun SQL to `{rows, rowCount}`. BIGINT/NUMERIC values arrive as
  strings. Bind JSON objects directly to JSONB: pre-stringifying them produced
  double-encoded JSON, fixed in `873b0f9`. Use `textArrayLiteral()` for PostgreSQL
  array parameters rather than assuming JS arrays serialize as SQL arrays.
- Notifications are queued inside the write transaction, so listeners only see
  committed changes. Channel names are schema-scoped for isolated databases/tests.
- Source uses concurrent receipt retrieval with deterministic output slots and
  hash-based downstream matching. An individual HTTP 429 gets up to five attempts
  with exponential backoff and jitter before the whole-block retry takes over.
  This reduced retry amplification. See the instructions discrepancy above before
  changing concurrency behavior.

### Metric conventions

| Metric | Meaning |
| --- | --- |
| `base_block_fee_wei` | `baseFeePerGas`, or 0 if absent. |
| `max_gas_in_block` | Block `gasLimit`. |
| Transaction fee | `receipt.gasUsed * receipt.effectiveGasPrice`. |
| Priority fee | `max(effectiveGasPrice - baseFeePerGas, 0)`. |
| Average fee price | Simple per-transaction average of `effectiveGasPrice`. |
| Average transaction fee | Simple per-transaction average of fee paid; different units from gas price. |
| Average transaction gas used | Simple per-transaction average of `receipt.gasUsed`. |
| Weighted priority fee | Priority fee weighted by receipt gas used. |

Empty-block averages are 0; `bigint` division truncates fractional wei.
Supported range sizes are `2, 5, 10, 20, 50, 100, 200, 500, 1000`, with boundaries
`[k*M, k*M+M-1]` and primary key `(range_size, range_start)`. Aggregation is not
inline in the scanner. Range averages use transaction-count weighting; weighted
priority uses its exact gas-weighted numerator. Legacy rows missing that numerator
have an approximate fallback, not retroactively exact history. Details:
[gas price weighting report](docs/gas-price-weighting-report.md).

## What was done: milestones

This is a feature/incident chronology, not every commit. Hashes were checked in
local history; infrastructure incidents are dated memory observations.

| Date | Work / finding | Reference |
| --- | --- | --- |
| May 26–30 | Forward scanning stopped skipping near-head blocks; guzzlers and separate backfill idling followed. | `6abe2e9`, `5050ea3`, `9eff0bc` |
| June 11–13 | External Arkiv decoding; PostgreSQL driver moved to Bun SQL; JSONB binding corrected. | `79536fe`, `27f49c5`, `873b0f9` |
| August 7–14 | Pietruszka deployed for scx1; scx1 removed and replaced by Cheesecake; SDK/selector and faucet configuration changed. | `scx1-devnet-setup.md` |
| August 17–18 | Load calibration, key rotation, polling-budget improvements, RPC outages investigated; bounded receipt concurrency added. | `effb02c`, `5b2043f` |
| August 20–21 | Standardized on Arkiv-Network's Bun decoder; fixed new execute ABI handling and the published decoder's 28884 port contract. | `a31c81d`; indexer v0.3.2 → v0.3.3 |
| August 24 | Chart 0.11.0 correlated with empty sealed blocks on two networks; pending payloads still contained transactions. | `chart-0-11-0-empty-blocks.md` |
| August 25 | Create operation keys recovered from receipt logs. | `9d7f7f5` |
| August 26–27 | Entity/history caching, precomputed sync, compact rows, ETags/304s, planner health counts, gzip fallback, shared count cache, deferred transaction paging. | `6e22b7b`, `f9f26f8`, `49a6671`, `d878dbf`, `0473d51`, `34c3664`, `cecd5d7` |
| August 28 | Shadow Ethereum RPC (PR #95), hashes, logs, batched hash lookups, route rename, allowlisted submission relay, sparse balance readings; pooled RPC proxy integrated. | `594b8e7`, `f70a96e`, `b811129`, `4cb5f18`, `9273463`, `6df5113`, `e8cf2d1`, `46e70c7` |
| September 2 | Hub-style UI/BlockExplorer branding; Data page, CodeMirror query editor, results and shared links; per-network Hub keys and Tiramisu calibration. | `749edb7`, `26bb25d`, `b2f0ebb`, `90e0bd5`, `d5329ad` |
| September 3 | Experimental entity engine and index tuning; browser node/index comparison; v0.4.0. Tiramisu reset and rotated credentials the same day. | `7bdf379`, `87352a5`, `c0c5311`, `74fed46`, `a54e449` |
| September 4 | Named workers, UTC daily/hourly schedules, cross-hour windows, traffic projections, fee-aware waiting and receipt timeout. | `2f52778`, `65394cf`, `3467f93`, `4d55811`–`d01ebb7` |
| September 5 | Persistent live fleet, Prometheus metrics, protected off-host scraping, health-page metrics panel; comparison pinned to projection head. | `3419a76`, `4a91998`, `682b8e5`, `a2eacb6`, `ccb35be`, `4445998` |
| September 8 | Retired Cheesecake stack and pooled proxy; moved Kalarepa checkout here; paused fleet/backfill pending direct bouncer credentials. | `kalarepa-single-stack-2026-09-08.md` |
| September 9 | Bounded omni search/typeahead (PR #99); seeded-chain genesis import (PR #100); frontend shared build context; prefill-owned indexer recipe. | `3776af9`, `3223a05`, `ab65dd1`, `b473873` |
| September 9, evening | Genesis checks completed on the Sourcify seed; the app image ships `scripts/` after the offline importer failed with “Module not found” in the container; the genesis walk stops between batches on shutdown; release v0.5.0, deployed to Kalarepa at 20:00 UTC. arkiv-prefill committed its Sourcify run and the indexer integration. | `eef3514`, `5f10367`, `8baf173`, `243a51b`; prefill `024b780` |
| September 9, night | The Data screen is titled “HOME >> DATA / EXPERIMENTAL — USE WITH CAUTION” (also in the browser title); release v0.5.1. Draft PRs to run it on Tiramisu: db-chain-mgr #387 adds `spec.indexer.entityQueryIndex` / `shadowRpc` (chart 0.25.0), db-chain-deployments #25 pins v0.5.1 with both on. | `b8d2f7f`, `9dcfed4` |

## Deployment and neighboring repositories

### Last recorded local layout

| Item | Recorded September 8–9 state |
| --- | --- |
| Checkout | `/home/ubuntu/arkiv-network/arkiv-chain-indexer` |
| Network | Tiramisu, chain ID `7738577` (`0x7614d1`); same ID survived its reset. |
| Compose identity | `arkiv-chain-indexer-tiramisu`, retained through `COMPOSE_PROJECT_NAME`; containers/volumes retain that prefix. |
| Explorer | Kalarepa (`kalarepa.arkiv-global.net`); nginx targets backend loopback port 3001 and frontend 23561. |
| Node RPC | `https://rpc.tiramisu.db-chain.testnet.arkiv.network`, direct bouncer path. |
| Proxy | Retired; `COMPOSE_PROFILES` cleared. Old `rpcproxypool` volume retained. |
| Fleet / backfill | Empty live fleet persisted; `backfill-scanner` stopped to preserve the anonymous RPC budget for tip scanning. |
| Last recorded deployed build | `243a51b` (the v0.5.0 code plus this document), September 9 around 20:00 UTC: `docker compose build` with the exit checked, `up -d --wait --no-deps` for the running app services, `up --no-start backfill-scanner` so the paused backfill was recreated on the new image but not started. `/health` ok, genesis status `none` on unseeded Tiramisu, no errors in the backend log. |
| Retired stack | Cheesecake/Pietruszka removed; backup at `/home/ubuntu/backups/arkiv-chain-indexer-cheesecake-2026-09-08`. Its nginx site was still enabled and returning 502 at the time. |

The Tiramisu admin token needed to provision direct keys was still unavailable in
the latest memory. The saved fleet was at
`/home/ubuntu/backups/kalarepa-baseload-fleet-2026-09-08.json`; a named
`churn-fleet` configuration was another restore source. Those may represent
different fleet revisions (the September 8 snapshot had 21 workers; earlier
`churn-fleet` notes describe 11).

Older chain facts: Cheesecake was chain `7733102` (`0x75ff6e`) with 2-second blocks;
scx2 was `7728681`. scx1 DNS disappeared during the August 14 migration. These are
historical network identities, not an inventory of networks still running.

### Where authoritative information lives

| Repository / local checkout | What it supplies |
| --- | --- |
| `Arkiv-Network/db-chain-deployments` | Per-network deployment manifests (`devnet` / `testnet`), component tags + digests, chart version, bouncer settings. |
| `Arkiv-Network/db-chain-networks` | Network registry/genesis/config/metadata, not deployed component versions. |
| `/home/ubuntu/arkiv-network/db-chain-mgr` | Deployment chart and manager; decoder sidecar/probe contract; network credential provisioning context. |
| `/home/ubuntu/arkiv-network/arkiv` | Authoritative node implementation used for query language, wire types, operation semantics, cursors, and seed layout research. |
| `/home/ubuntu/arkiv-network/arkiv-sdk-js` | Tagged-union execute ABI, notably `src/entity/operations.ts` and `PAYLOAD_PARAMS`. |
| `Arkiv-Network/arkiv-transaction-decoder` | The supported Bun/TypeScript decoder; not `atlas-chain/atlas-transaction-decoder`. |
| `/home/ubuntu/arkiv-network/arkiv-hub` and `bouncer` | Hub key records, per-network control-service projection, RPC auth/quota behavior. |
| `/home/ubuntu/arkiv-network/api-key-generator` | Historical pooled proxy/key minter and quota calibration tooling. |
| `/home/ubuntu/arkiv-network/data-explorer` | Reference for the Data page port and CodeMirror integration. |
| `/home/ubuntu/arkiv-network/arkiv-prefill` | Seeded devnets, Sourcify fixture run, watcher, and its own included indexer Compose stack. |
| `/home/ubuntu/arkiv-network/db-chain-deployments` (cloned September 9) | The manifests themselves; Tiramisu is `testnet/tiramisu.yaml`. |

`web3_clientVersion` historically reported upstream `reth/v2.2.0-88505c7` while
the Arkiv deployment manifest pinned `rethVersion: v0.1.0@sha256:…`. A manifest
digest identifies the actual build; the upstream self-report did not.
Some deployment bot commits had zeroed Git dates; the GitHub activity API gave
usable push timestamps when correlating the August 24 incident.

### Image and deploy contracts

- The root Docker image is shared by scanner/aggregators/backend; commands choose
  the entry point. Released packages are
  `ghcr.io/arkiv-network/arkiv-chain-indexer/{app,frontend,decoder}`. Since `eef3514`
  the image also carries `scripts/`, so `docker compose run --rm backend bun run
  scripts/importGenesisState.ts …` works; images before it, including any `latest`
  pulled before September 9, 19:07 UTC, fail with `Module not found`.
- Kubernetes uses the indexer-published **decoder** package. Compose defaults to
  the upstream `arkiv-transaction-decoder:v0.2.1` package. Indexer decoder release
  tags are indexer versions, not upstream decoder versions.
- The db-chain chart (through 0.24.0) renders the backend with a fixed environment:
  no entity index and no shadow RPC upstream. db-chain-mgr #387 (draft, September 9)
  adds `spec.indexer.entityQueryIndex` and `spec.indexer.shadowRpc` for chart 0.25.0,
  the relay pointed at `scannerRpcNode` with the scanner's key; db-chain-deployments
  #25 (draft) is Tiramisu's first use, with indexer v0.5.1. Neither is merged.
- The published decoder is built from pinned upstream commit
  `9239c4d89c3d9b1b27e10abd3e8d4458f5508fa7` with `PORT=28884`. The deployment chart
  probes 28884 and does not supply `PORT`; losing that baked-in value previously
  caused `Init:CrashLoopBackOff`. Compose explicitly passes `PORT: 28884`.
- [frontend/Dockerfile](frontend/Dockerfile) mirrors the repository layout and
  copies shared modules using `COPY --from=shared`. Both Compose and the publish
  workflow must provide `shared=./src`. A host build passing does not establish
  that a frontend-only Docker context can resolve shared imports.
- A partial `docker compose up -d --build frontend` can also rebuild/restart its
  backend dependency. Export `BUILD_COMMIT` and `BUILD_DATE`, as
  [deploy.sh](deploy.sh) does, or `/health` may report an unknown build.
- Check the build exit code before starting containers. `docker compose build |
  tail` without `pipefail` once hid a frontend failure; backend health showed the
  new commit while the browser still served the old frontend.
- When diagnosing “I don't see it,” compare backend build metadata and the actual
  frontend/container build before investigating application logic. Historical
  instructions to redeploy Pietruszka now apply to the surviving Kalarepa stack.
- A general Compose `up` can restart the intentionally stopped backfill service.
  Preserve the recorded paused state until the RPC budget issue is resolved: deploy
  with `up -d --wait --no-deps <running services>` and then
  `up --no-start --no-deps backfill-scanner`, which recreates it on the new image
  without starting it (used September 9, evening).

## Decoder and Arkiv metadata

The old execute selector `0xba8ccf92` used a single operation struct containing
payload/content type. SDK 0.8's `0x49650044` uses
`execute((uint8 operation, bytes operationData)[])`: `operationData` encodes a
tag-specific struct, payload/content type become `$payload`/`$contentType`
attributes, values are dynamic bytes, and expiry uses `expiresAt`/`minLifetime`
uint64 values. Operation tags remained Create=1 through Delete=5.

On August 20, the old ABI caused every registry transaction to return decoder
HTTP 400: zero operation rows despite about 786,000 scanned transactions. That
failure looked like “not an Arkiv call” because 400 intentionally maps to a skip.
`a31c81d` added per-selector warnings (first refusal and every thousandth).
Other decoder failures make the whole block retry.

- Use Arkiv-Network's Bun decoder per the recorded user decision. Dropped
  Rust-specific configuration is not a reason to switch back to the Atlas decoder.
- `eth_chainId` is fetched at scanner startup and supplied to decode requests so
  a reference-aware decoder can choose the correct signer allowlist.
- The upstream v0.2.1 note records missing v1 payload-reference parsing. The
  indexer's metadata fields still support `is_reference`, `payload_reference`,
  `reference_verification`, and `reference_error`, but a decoder that omits them
  leaves them false/null. Provider-payment views depend on those fields.
- Raw decoder output is normalized: `payload.hex`, `payload.text`, and transaction
  `input` never reach persistence. This includes the legacy decoder path that
  still emits payload bytes.
- Create keys are generated by the engine and absent from create calldata.
  `src/arkivOperations.ts` pairs creates with receipt `EntityCreated` logs; if
  counts disagree it warns and leaves keys null rather than guessing.
- New value type names are SDK tags such as `str`, `u64`, and `dec`, not the old
  `string`/`uint` labels. The entity projection uses the typed representation.
- Historical selector diagnosis used `eth_call` with a bare selector against
  `0x4400000000000000000000000000000000000044`: an invalid-calldata/buffer error
  meant a recognized selector, while “unknown selector” meant ABI mismatch.
  Match SDK and engine capabilities rather than trusting the reth version string.

## HTTP API, caching, and performance

- CORS is returned on every response. List filters combine additively.
  `/blocks`, `/ranges`, and `/senders` cap results at 10,000 and are walked with
  block bounds; `/transactions` uses `page` + `limit`, at most 1,000 per page.
- Large lists use compact `{names, rows}` wire data. [frontend/src/api.ts](frontend/src/api.ts)
  expands rows for views. Compression prefers zstd, with gzip fallback.
- Transaction order is total: `(block_number, position)` or
  `(nonce, block_number, position)` for an address. Pages after the first select
  keys using an index-only deferred join, then fetch full rows. Keep the outer
  `ORDER BY`; joins do not preserve subquery order. The deepest page measured
  roughly six times faster after this change.
- Pagination counts share a `ValueCache` keyed by filters, excluding page, limit,
  and ordering. An unfiltered `COUNT(*)` previously bottlenecked the whole backend
  and queued unrelated queries. Optimize shared counts before adding indexes.
- Entity histories return the newest 100 operations by default, with
  `totalOperations`, `truncated`, and the first stored operation if the create is
  outside the slice. The bounded `ResponseCache` also caches 404s: default 10,000
  entries / 64 MiB / five-minute TTL, with entity-specific NOTIFY eviction.
- Stored-block NOTIFY invalidates list/count caches and triggers precomputed
  `/sync`; bursts coalesce over 500 ms. A five-second refresh keeps lag growing
  even if scanning stalls. List cache defaults are 200 entries / 64 MiB / five
  seconds. TTLs backstop missed notifications; zero cache bounds disable caching.
- ETags support conditional GET and accept weak `W/` forms. The observed
  Cloudflare → Envoy path weakened ETags after recompression and stripped zstd
  from origin negotiation. Gzip fallback avoids plain origin-to-edge traffic.
- Historical Cloudflare responses were `DYNAMIC`, not edge-cached. Warm RTT was
  about 50 ms. `x-envoy-upstream-service-time` helped separate origin time from
  edge/RTT; do not equate end-to-end latency with database cost.
- Historical API `HEAD` probes returned 405. Use GET with the body discarded
  when collecting response headers.

### Metrics

[src/prometheus.ts](src/prometheus.ts) implements the dependency-free registry;
[src/serverMetrics.ts](src/serverMetrics.ts) labels requests using fixed route
templates, not paths or queries. Add routes to `ROUTE_TEMPLATES`. Unknown RPC
method names become `unknown` to bound cardinality. Response constructors record
bytes without re-reading bodies; the DB adapter attributes query time via
`AsyncLocalStorage`. Cache and scanner collectors refresh at scrape time.

- `/metrics` is for the loopback/backend scraper or `METRICS_BEARER_TOKEN` gate.
  Nginx blocks public `/api/metrics` with 404.
- Public `/api/admin/metrics` always requires `BASELOAD_ADMIN_BEARER_TOKEN`; no
  configured admin token means 503, never open access. Its token is independent
  of `METRICS_BEARER_TOKEN`.
- Successful scrapes are excluded from traffic counters; rejected scrapes count
  so probing remains visible. JSON-RPC batch entries count separately.
- The health view's Server metrics panel reads `/api/admin/metrics` in admin mode.

Recorded September 5 load validation used about 2,400 synthetic requests and
found correct labels/counters. `/health` cost about 21 parallel PostgreSQL queries
(~15 ms wall time, ~56 ms summed DB time); `/balances` cost ~51 ms for one query.
An entity query measured ~2.8 ms locally versus ~427 ms relayed; entity count
~3 ms versus ~96 ms. These are dated measurements, not service guarantees.
See [docs/prometheus.md](docs/prometheus.md).

### Omni search (PR #99, narrowed to identifiers)

The feature is documented in [docs/omni-search.md](docs/omni-search.md).
`GET /search` and `/search/suggest` reuse existing block/hash/address/entity
indexes. Attribute names, attribute values, payloads, log topics, and general
text are not searched; unsupported text receives HTTP 400 before database
access. The former attribute lookup and recent metadata sample were removed.
No new search table, DDL, scanner write, provider/node call or backfill is needed.

- Query length ≤256 characters, result limit 1–30; defaults 20 search / 8 suggest.
  Decimal blocks (including single digits) support suggestions; hex prefixes
  start at six digits and are normalized lowercase.
- With the optional entity projection enabled, only its entity keys and
  owner/creator addresses participate. Attributes remain excluded. Recipient-only
  addresses are not indexed by search; a full address can be opened directly.
- At most two distinct searches run concurrently; equal requests coalesce and
  overflow returns 429. Suggestions debounce 220 ms and abort obsolete requests.
- Read-only transactions disable JIT/parallel workers; statement timeout 200 ms,
  lock timeout 50 ms, request budget 800 ms between queries. Bounded results
  report `partial`/`truncated` rather than claiming exhaustive absence.
- Cache: 128 entries / 2 MiB / two seconds. Partial results are not cached.
  Disabled transaction data yields blocks only. Legacy `coverage` fields remain
  false/null/zero for older clients.
- Historical query-plan checks established identifier access paths, not a
  terabyte-scale latency or concurrent-traffic guarantee.

## Shadow Ethereum JSON-RPC and balances

`latest` means `scanner_state.last_successful_block`; `eth_syncing` exposes the
gap. Standard block/transaction/receipt shapes use null for unpersisted fields
(roots, miner, signatures, logsBloom, etc.); input is always null. Persisted chain
ID avoids a node dependency for `eth_chainId`.

- Add methods to `JSON_RPC_METHODS`, and transaction-dependent methods to
  `TRANSACTION_DATA_METHODS` so the feature gate covers them.
- Accept node-compatible input leniency (`params: null`, leading-zero quantities
  such as `0x01`); output quantities remain minimal canonical hex.
- Fee-history reward percentiles follow geth's gas-weighted walk; the gas-price
  oracle follows its 60th-percentile-of-per-block-minimum-tip rule.
- Hashes and receipt logs have coverage floors. A pre-logs transaction has null
  `log_count`, so its receipt says `logs: null` rather than an invented empty list.
- `eth_getLogs` caps both requested block span and returned logs at 10,000; resolve
  all result block hashes with one `getBlockHashesByNumber` call. Batching cut one
  historical 1,000-block lookup from ~420 ms to ~10 ms.
- **Remaining coverage limitation:** inspected `eth_getLogs` does not reject a
  range below the stored-log floor and can return `[]` there. Do not interpret
  absence from that range as proof that no logs existed on-chain.
- Historical Cheesecake floors were 626702 for block hashes and 627028 for stored
  logs. These are not constants for Tiramisu or another database. An August 28
  differential run checked ~4,600 assertions over 150+ blocks with no stored-field
  mismatches, but a below-floor query missed 9,237 node logs by design/coverage.

### Upstream relay

`SHADOW_RPC_UPSTREAM` enables an explicit allowlist that outranks local handlers
and transaction-data gating. Defaults are `eth_sendRawTransaction`, `arkiv_query`,
`arkiv_getEntity`, `arkiv_getEntityCount`, and `arkiv_getBlockTiming`. Use an
explicit deployment allowlist to relay live nonce, calls, or gas estimation when
needed; `eth_sendTransaction` assumes a node-managed unlocked account and is not
a default. Forwarding uses a ten-second timeout and 600 calls/minute endpoint cap
by default. `/health` reports forwarded methods.

Return only upstream JSON-RPC answers/errors. Transport failures produce a fixed
`-32000` response; never expose an upstream URL or fetch error containing a key.
The first recorded submission smoke check received correct node errors for
unfunded/invalid signed transactions; it did not demonstrate a mined submission.

### Balance readings

`SCANNER_TRACK_BALANCES` defaults off. For each block, collect unique transaction
senders/recipients and batch `eth_getBalance` at that block; replace those readings
atomically on rescan. Contract-internal transfers, fees, withdrawals, and absent
genesis coverage make arithmetic over `value_wei` insufficient.

`getBalanceAt` uses the latest reading at or before the requested block. It is
exact at the reading's block, but may be stale between touched blocks if unseen
internal transfers occur. An unknown account returns an error (`-32000` through
shadow RPC), not `0x0`. Coverage begins when enabled; no historical readings were
backfilled. Twelve sampled readings matched the node in the August 28 check.

## Entity query engine

### Grammar and node compatibility

The relevant node source is `/home/ubuntu/arkiv-network/arkiv`, especially
`arkiv-query`, `arkiv-reth-rpc`, `arkiv-rpc-types`, `arkiv-reth-executor`,
`arkiv-interfaces`, and `arkiv-reth-statemanager`. The older
`arkiv-op-reth` grammar (`~`, `$all`, `IN`, double quotes) is not the reference for
this port. Exact error messages and UTF-8 byte positions are pinned by tests;
verify changes against node source before changing them.

- `*` is a complete query, not an operand to combine with `AND`.
- Predicates support `=`, `<`, `<=`, `>`, `>=`, `STARTSWITH`; boolean operations are
  case-insensitive `AND`, `OR`, `NOT`, with NOT > AND > OR, plus parentheses and
  `--` comments. No `!=`, `&&`, `||`, `~`, `IN`, `EXISTS`, or `TYPEOF`.
- Typed literals: `i32`, `u64`, `u256`, `dec` (up to 18 decimal places), `str`,
  `addr`, `key`, `bytes32`, and bare booleans. Bare integers mean i32 for user
  attributes. String literals use single quotes and doubled-quote escaping.
  Mixed-case addresses are checksum-validated.
- Attribute names start with an ASCII letter, then letters/digits/`_.-`, max
  32 bytes; type names are reserved. Strings max 128 bytes. Query bounds: 8 KiB,
  64 predicates, depth 32. Range comparisons are for numeric types.
- Queryable builtins: `$owner`, `$creator`, `$key`, `$expiresAt`, `$createdAt`,
  `$contentType`. `$updatedAt`, `$creationFlags`, and `$payload` are not queryable.
  Unknown attributes match nothing rather than erroring.

| Error | Meaning |
| --- | --- |
| `-32001` | Malformed query. |
| `-32002` | Type error. |
| `-32003` | Invalid literal. |
| `-32004` | Query resource limit. |
| `-32005` | Invalid/incompatible cursor. |
| `-32006` | Block outside available coverage. |
| `-32602` | Invalid options/parameters, including unknown option fields. |

`arkiv_query` takes `[query, options]`; `select` is an object of booleans (with
optional per-name attribute selection), not an array. Default selection is key
only. `limit` accepts hex or a JSON number, defaults to 100, max 200 (error rather
than clamp). `atBlock` is hex or `latest`; resume a cursor at the same block.
Node invalid-option errors wrap serde text in debug output; compare the inner
message when validating parity. Query errors carry byte-offset `data.position`.

### Projection semantics

- `ENTITY_QUERY_INDEX=true` enables the optional index; it requires stored
  transactions and decoded operations. The projector runs inside the backend.
- `entity_versions` / `entity_version_attributes` store historical state. Pure
  `foldEntityVersions` merges patches; type 0 tombstones remove attributes;
  `$payload`/`$contentType` cells become fields; reverted transactions apply nothing.
- Live means `expires_at > block` and not deleted. Expired entities cannot be
  mutated successfully. Every successful mutation updates `updatedAt`; expiry
  prefers stored event values and otherwise derives from calldata.
- `dec` uses 18-place units; u256 uses PostgreSQL numeric; strings compare
  bytewise. Wire values preserve node encodings: u64/u256 minimal hex, i32 number,
  boolean boolean, decimal trimmed string, identifiers lowercase hex. Attributes
  are ordered by name bytes.
- Ordering is `created_at DESC, created_position DESC, entity_key DESC`. The node
  assigns IDs at transaction commit by walking staged keys in ascending key
  order (`BTreeMap`), so operation index does not determine order within a tx.
  Keys cannot be recreated.
- Node cursor payload: binding + entity ID (16 bytes). Index cursor payload:
  block/position/key (52 bytes). They are intentionally incompatible; mixing
  sources must return a cursor error, not silently continue.
- `latest` is **projection head**, not scanner or chain head. Blocks outside
  `[floor, head]` are `-32006`. `select.payload` is refused because no bytes are
  stored. Pre-logs `creationFlags` remain null.
- The projector folds in chunks and detects late writes below its fold point
  through operation `scanned_at`, refolding affected keys. Backfill can lower
  the detected floor. Advisory locking prevents concurrent writers; projection
  pauses during genesis import.
- Pair address indexes with expiry: `(owner, expires_at)` and
  `(creator, expires_at)`. Historical owner-only lookup scanned 167,000 rows in
  ~95 ms; the paired index took ~1 ms. Attribute indexes must support past-block
  versions too, not only current rows.

Historical Cheesecake projection floor was **499818**: ~239,000 older creates
lacked keys despite decoded operations beginning around block 293,000. This is
coverage history, not a hardcoded floor. Seeded chains can establish a floor of 0.

### Validation learned so far

September 3 fixture comparisons reported zero differences: 1,096 checks on
Cheesecake; 1,042 then repeated 1,098-check runs on Kalarepa, including through
nginx. After tuning, index p50 was roughly 1–12 ms versus node 58–132 ms; an
at-past-block `$createdAt` range query was ~4 ms versus ~1.25 s. Concurrency-8
throughput was ~438–918 index requests/s versus ~78 node requests/s.

Use [scripts/seedEntityQueryFixtures.ts](scripts/seedEntityQueryFixtures.ts) for
typed attributes/mutations/expiry/flags/revert fixtures and
[scripts/compareEntityQuery.ts](scripts/compareEntityQuery.ts) to compare the same
block. Creating fixtures sends transactions. Historical wallets 240/241 were
reserved for those runs; recheck availability for another run. Fixtures expire
after hours, but block-exact checkpoints remain useful.

Point comparison `--node` at a suitably authenticated direct upstream, not public
shadow RPC: its 600/min cap once caused 34 false differences. Older recipes used
the now-retired pooled proxy. Pin to the projection head (fixed in `4445998`).
Node `$createdAt` range queries scan expensively at past blocks, so stop node
walks at the coverage floor rather than windowing every query with that predicate.

## Genesis / arkiv-prefill (PR #100)

Seeded entities exist in block-0 state without any create transaction, so replaying
operations alone cannot discover them. PR #100, merged as `3223a05`, adds
version-0 bases with `created_at=0`, `created_position=entity ID`, and a shared
`genesis_import` state row. Later operations fold on top of that base.

### Two import paths

1. **RPC:** `ENTITY_INDEX_GENESIS=auto` probes chain ID, genesis hash, and entity
   count at block 0. It pages entity metadata only, saves the cursor, then repairs
   keys with subsequent operations. Default RPC limit is 1,000,000 entities.
   `ENTITY_INDEX_GENESIS_RPC` defaults to `SHADOW_RPC_UPSTREAM`; `off` disables the
   automatic probe but does not prevent completion of an offline import.
2. **Dump:** [scripts/importGenesisState.ts](scripts/importGenesisState.ts) streams
   `state.jsonl`, measures/discards payloads, validates entity/file order against
   `id2key` and entity count using keccak chains, and writes batches of 5,000 under
   the fold lock. Resume points commit with batches. For an empty index it drops
   secondary indexes for loading and rebuilds them afterward. Optional `--rpc`
   verifies chain ID, genesis hash, state root, and count before loading. The
   backend performs final repair; script exit 0 means handoff, not necessarily
   completed repair.

Both loops check the projector's stop flag between batches since `5f10367`: a
shutdown returns within one batch and the next start resumes from the committed
cursor. Before that, a backend restarted mid-walk ran through Docker's ten-second
stop grace and was killed; the per-batch commit made that safe, not clean.

The importer is the repository's intended Postgres-writing operational script;
comparison/fixture scripts operate through RPC. See the README for full commands.
Health distinguishes `none`, `unavailable`, `waiting`, `running`, `done`, and
`failed`. Only successful completion establishes complete genesis coverage.
RPC imports record payload size 0 because they never fetch bytes.

Both paths atomically write the same snake_case progress document through
`ENTITY_INDEX_GENESIS_PROGRESS_FILE` / `--progress-file`: phase, overall percent,
elapsed time, epoch timestamps, PID, errors, source-specific rates/counts/ETA, index
rebuild, and repair. The script emits JSON lines and uses exit codes 0 handoff,
1 error, 2 usage, 130 interrupted/resumable. A watcher must follow the repair phase.

### Seed research and completed checks

Recorded Sourcify fixture: ~506 MiB dump, 206,050 lines, 28,825 genesis entities.
Entity records occurred in the early file region (lines 258–57651), with entity
record order matching IDs. The system account
`0x4400000000000000000000000000000000000046` occupied one ~7.9 MB line (161256):
`key2id -> id+1`, `id2key -> key`, and `entity_count` last in insertion order.
Funded accounts followed later. Alloy `Vec<u8>` fields use RLP lists of byte
items; `0x80` denotes a zero byte. These line numbers describe that fixture,
not a general dump-layout contract; the importer verifies ordering.

The node's `RethAuxStore::evaluate` collects all matching IDs before slicing a
page, so block-0 paging costs O(N) **per page**. That makes an offline path
necessary for a 100-million-entity seed. Raw fixture decoding took ~4 s / 130 MB/s.

**September 9, evening**, end-to-end import of that dump on a checkout-built stack:
17 s in total (loading 10.2 s at ~3,200 entities/s and 30–65 MB/s of dump, six
batches of 5,000 taking 0.9–3.7 s each; id-slot verification 3.7 s; index rebuild
1.8 s), the backend finishing the repair 2 s after the handoff. Loading is
database-bound, so a 100,000,000-entity seed (prefill `.env.100m`, 1 KiB payloads)
needs roughly 9 h of loading plus verification and index rebuild, which grow with
the row count; plan for half a day. Not attempted.

Recorded validation: RPC import completed in ~28 s, and block-0 differential
comparison had zero differences across 224 checks. A later prefill-owned run
finished genesis in ~24 s / 145 pages and rendered a genesis entity page.

**September 9, evening**, all on the Sourcify seed: head comparisons of the
RPC-walked index and of a dump-imported index, 252 checks each, 0 differences; a
backend killed in the middle of the RPC walk (the restart was issued at 10,000 of
28,825 imported) resumed from its cursor to 28,825 rows with distinct positions
0..28824, then 224 block-0 checks, 0 differences; the explorer's Data page reads
“Every entity is indexed, including the 28,825 from the genesis state” inside the
collapsed RPC-endpoint details. A full comparison takes 7–8.5 minutes because the
node pages block 0 in O(N).

### Prefill integration and remaining checks

`arkiv-prefill/docker-compose.indexer.yml` now owns published `indexer-*` services,
included by normal and Sourcify Compose files. Its large-seed `indexer-genesis`
one-shot uses the dump importer above the RPC limit. The watcher has an **Index**
card driven by `INDEX_PROGRESS`, `INDEXER_HEALTH`, and `EXPLORER_URL`. They were
committed to arkiv-prefill `main` on September 9, evening (`024b780`, together
with the Sourcify run itself; `229af63` updated its knowledge file). The Sourcify
project's indexer containers run the fixed image since 19:25 UTC.

Recorded Sourcify endpoints: node RPC loopback 8645, API 3030, explorer 3031,
watcher 3010; normal prefill watcher 3007. The Sourcify Compose network is
`arkiv-sourcify_default`. arkiv-prefill's `scripts/run-sourcify.sh` writes `DOCKER_GID` to
`compose.env` so the watcher can show resource usage. Shell `$` in Compose
`command` values must be written `$$`.

This repo's [docker-compose.prefill.yml](docker-compose.prefill.yml) is a
checkout-development alternative that joins the node network and mounts artifacts.
The temporary checkout-owned Sourcify stack at 3002/23562 was removed. Do not run
both indexer variants against the same progress file.

**Completed September 9, evening** (results above): comparison at head, the
interrupted RPC walk, the offline importer end to end with its rows/s, and the
Data-page genesis note. The offline run in the integrated stack first failed because
the image lacked `scripts/` (fixed in `eef3514`). **Still open:** a live patch of a
genesis entity on a seeded chain (no key for the seed owner or the funded accounts is
in the prefill repo; the fold-on-base path is covered by the Postgres tests), and the
100M run itself. Resetting import state truncates projection tables/deletes index
state and is destructive maintenance, not a routine verification step; the checks
above used throwaway checkout-built stacks (`docker-compose.prefill.yml`, a progress
file under `/tmp`) instead of resetting the live index.

## Baseload behavior and operating lessons

### Current implementation

- Workers have separate wallets, names, daily/hourly UTC schedules, block windows,
  and fee caps. Hourly windows may cross the hour. UI forecasts traffic by minute
  and UTC hour. Config limits currently agree in backend/frontend:
  `MAX_WALLET_NUMBER=250`, `MAX_BASELOAD_ENTITIES_PER_REQUEST=64`.
- Each worker submits sequentially and waits for its receipt. Confirmed nonce and
  learned gas limits are reused; failures invalidate them. High `opsPerMinute`
  alone cannot bypass receipt latency.
- Receipt polling waits roughly one block before its first attempt and jitters
  waits ±25%; unnecessary per-worker block-number polling was reduced. Synchronized
  bursts, not just average request rate, exhausted the old shared budget.
- Shared `BaseFeeCache` reads about once per two seconds. Workers above their cap
  wait as `outpriced` before sending and while pending. Every 20 seconds the stall
  hook updates status; a non-outpriced pending tx times out after ten minutes and
  the nonce is reread. Outpriced transactions intentionally continue waiting.
- Updates batch an EXTEND because the observed engine ignored expiry on UPDATE.
  Lifetime values need to respect the network's block timing.
- Every live config update persists to `baseload_live_config`. Startup restores
  DB state first; `BASELOAD_INITIAL_CONFIG_PATH` only seeds a never-configured DB.
  Named configs remain separate. An intentionally empty fleet survives a deploy.
- Live reconfiguration is `PUT /baseload` (not POST); omit derived `walletAddress`
  fields when sending workers. Named configs use `/baseload/configs/<name>` and
  `PUT /baseload/configs/<name>/load`. Administrative mutations use the deployment's
  own `BASELOAD_ADMIN_BEARER_TOKEN`.

### Wallet and transaction diagnosis

- An old generic “Execution error without revert data” had two different causes:
  insufficient funds for `maxFeePerGas * gasLimit`, and oversized encoded txs.
  Diagnose fees/gas/payload separately rather than assuming an ABI error.
- Actual Arkiv storage/rent debits can exceed the visible transaction fee even
  when `value_wei=0`. Large payload fleets therefore need funding despite tiny
  effective gas prices. This also motivates balance readings rather than sums.
- Faucet login is form-encoded `POST /login`; successful historical responses
  were 303 plus `faucet_session`, while JSON login bodies failed. Dripping uses
  the authenticated session. Passwords belong to each deployment's environment.
- Auto-faucet resting range is `[MIN_BALANCE, MIN_BALANCE + DRIP_AMOUNT)`;
  `MAX_BALANCE` is a ceiling check, not a target. Historical standard values were
  100 / 200 / 100. Credential rotation follows network resets.
- Historical 100 KiB random payloads were stable; 128 KiB payloads failed,
  consistent with an encoded transaction cap around 128 KiB including overhead.
  More entities add encoding overhead: identical total raw bytes need not fit.
  Do not treat later saved “120 kB” fleet configuration as proof against that
  earlier limit; engine versions and encodings changed.
- Create/update/delete churn historically desynchronized the client entity pool
  under load (`no entity …`). Create-only fleets were more reliable for the early
  capacity measurements; later churn features/configs do not erase that evidence.

### Calibration (historical, network/version dependent)

| Experiment | Recorded result / lesson |
| --- | --- |
| Early Cheesecake shared 50 req/s budget | More than roughly 6–12 workers caused 429s and diminishing throughput; more keys did not fix a per-IP cap. |
| Cheesecake, after polling fixes, 12 create workers × 100 KiB | ~4.23 tx/block, 17.47M gas (48.5% of 36M), 2.12 tx/s, zero worker errors. More workers could perform worse by retrying and starving healthy workers. |
| Payload packing on 36M gas blocks | ~100 KiB creates cost ~4.1M gas, fitting 8/block (~90%); ~50 KiB creates packed closer to full blocks. More small entities per tx reduced gas per transaction in those tests. |
| High-worker Cheesecake incidents | RPC availability failed while blocks kept being produced; a later 985-block check found no missing blocks. Notes report several different ceilings before/after hardening, not one permanent capacity number. |
| Uniform high fee caps | Workers all dropped out/rejoined together, creating full/empty oscillation. Spread caps to smooth admission. |
| Tiramisu, September 2, 10 create workers × 51,200 bytes | ~9.6–10 tx/block, 16.4–17.7M gas (46–49%), fee flat/decaying, zero errors; roughly one tx/block per worker. |
| Tiramisu, 19 workers | ~16 tx/block, ~84% fullness; base fee rose 12 → 1,445 wei in two minutes. 28-worker and 12-worker experiments also exceeded the sustainable target. |

For those EIP-1559 networks the target was 50% of the 36M gas limit. Sustained
load above target compounded base fees until fee caps/funds shed demand. Near-full
blocks during ramp-up were transient, not evidence of indefinitely sustainable
throughput at a fixed fee cap. Raising the cap moved the financial limit; it did
not create a stable 100%-full equilibrium.

Tooling: [scripts/rampBaseload.ts](scripts/rampBaseload.ts) reshapes a fleet and
supports fee spreading; use explicit `--behavior create` for create-only tests
because its default creates some churn workers.
[scripts/measureChain.ts](scripts/measureChain.ts) reads the RPC directly;
[scripts/watchSaturation.ts](scripts/watchSaturation.ts) samples Postgres plus RPC
liveness. When caught up, measure from Postgres to avoid competing for RPC quota;
when lagging, indexer blocks are stale observations of current chain load.

## RPC keys, rate limits, resets, and incidents

### Authentication model

Bouncer `auth-proxy` validates against a per-network Valkey store. The control
service at `rpc-control.<network>…` manages that projection. Hub holds key records
and projects them with its network's control-service admin token. A network key
working through Hub means its projection exists in that bouncer; there is no
generic “trust all Hub keys” switch.

September 2 per-network Hub support added `network` to key creation/list requests
and `HUB_NETWORK` to the generator (`RPC_PROXY_HUB_NETWORK` in this repo). Older
single-network Hub wiring and host/page availability notes are historical.
Key placements observed: `X-Api-Key`, bearer authorization, or final URL segment.
Always distinguish a backend admin token, faucet password, RPC client key, and
bouncer control-service token; they are unrelated credentials.

For Tiramisu the missing control token was named `DB_CHAIN_TIRAMISU_BOUNCER_TOKEN`
in the edge Doppler project / `bouncer-secrets` `adminToken` in Kubernetes namespace
`db-chain-network-tiramisu`. The host had no kubectl/doppler in the last note.
The old pre-reset token must not be assumed usable.

The requested “unlimited” direct-key approach was a very large quota
(`1000000000000000`) through `scripts/provisionRpcKeys.ts --source control`, not
an unlimited boolean. It still does not change per-IP limits. Direct keys are
absent from Hub's system of record and can be dropped by a full Hub reproject.
Recorded next steps were: obtain the current token, provision/verify keys, configure
`RPC_KEY_POOL_FILE` and `SHADOW_RPC_UPSTREAM_API_KEY`, then restore backfill/fleet
after validating scanner headroom. None of these actions was performed here.

### Rate versus quota

- Quota is per key; rate limiting was per client IP. Rotating keys extends quota
  headroom but does not inherently increase a host's rate allowance.
- August 26 measurements: flat 10 cost units per tested RPC call; N-item batch cost
  10×N; one-million quota therefore represented ~100,000 calls under that model.
- HTTP 429 with `QUOTA_EXCEEDED` is distinct from a transient plain 429. Check
  `Arkiv-Cost`, `Arkiv-Quota-Used-Percent`, and `RateLimit`, not status alone.
- A key at 100% returned success at ~95% two minutes later in one test. The older
  “locked out for the calendar month” explanation was not reliable empirically.
- A advertised keyed limit of 9999/s still produced ~15–17% plain 429s near
  2,500 offered requests/s (~2,200 successful/s from one IP). These are historical
  measurements and not permission or a target for another load test.
- Anonymous Tiramisu access was recorded at 600/min after September 2. A shared
  Cloudflare-edge-IP bucket was suspected from XFF handling but not proved.
  Keep that as a hypothesis pending control-service usage data.

### Rotation/proxy history

`src/rpcKeyRing.ts` supports a startup-loaded JSON key file, round-robin fallback,
sticky worker leases, retirement on auth/quota failure, and transient cooldown.
Reload/restart affected processes after changing the file.

The August 28 pooled proxy in `api-key-generator` listened on 8788, persisted its
pool, exposed `/pool`, injected keys, retired failures, and refilled automatically.
Two bugs were fixed there: recursive refill caused a hot loop (~23 GiB RAM, full
CPU), replaced by single-flight bounded minting; forwarded compression headers
described already-decoded bodies, causing Bun decompression errors. A locally
rebuilt image did not prove the published `latest` included those fixes.

The proxy was retired September 8 after its browser minter failed again and an
empty pool returned `503 no API keys available`. Its convenience does not override
the later direct-bouncer decision. Older documentation recommending it is historical.

### Useful incident signatures

| Symptom | Diagnostic / historical conclusion |
| --- | --- |
| Valid key fails | Compare real key, bogus key, and no key. Anonymous success does not validate a key; historically bogus keys returned 401 `INVALID_KEY`. |
| Cloudflare 403 in scripts | Some endpoints rejected Python urllib/default non-browser User-Agents; distinguish edge policy from key validity. |
| `-32011 no healthy backend` / 503 | Check bogus-key behavior and Envoy timing. Bogus key still 401 implies auth runs; identical 503 for all probes with upstream time 0 suggested no healthy bouncer endpoints. This localizes, but does not prove an OOM/crash root cause. |
| Empty latest blocks, pending block has transactions | August 24 chart 0.11.0 incident: EL built valid pending payloads, but sealed blocks omitted transactions. Investigate producer/consensus deployment rather than scanner fees/keys. |
| Worker says running but no progress | Old receipt wedge: attempts one ahead of completions, stale worker timestamp but fresh balance polling, pending nonce one ahead. Current code should surface waiting/outpriced or timeout. |
| Same chain ID, scanner far ahead of node | Network may have reset to genesis. Chain ID alone does not establish chain continuity. |
| Hub key creation 502 after reset | Hub's control-service projection can fail with a stale network admin token. Minting through Hub is not a bypass of that same control plane. |

For the chart incident, Cheesecake's last populated block was 458426, seven
seconds after the chart push; scx2's was 482223, six seconds after its push. Both
then had a roughly 2.5-minute restart gap and empty blocks at a 2-second cadence.
Pending consistently contained three transactions while sealed blocks had none.
Rollback/fix belonged to network operations; no final remote resolution is
established by this consolidation.

Tiramisu reset around **September 3, 16:04 UTC**, keeping chain ID/hostnames but
restarting block height at 0. All 337 proxy keys, faucet credentials, and the old
control token failed. A Hub isolation test succeeded on Cheesecake but failed on
Tiramisu, identifying stale Tiramisu projection credentials rather than broken
global minting. Hub/faucet were restored September 4; the user's direct control
token remained outstanding. Historical reset recovery removed PostgreSQL/Redis
volumes while preserving key volumes; that is destructive recovery for a confirmed
chain reset, not a suggested current action.

## Frontend and browser knowledge

- The Data page port shipped routing/source checks, lazy CodeMirror editor,
  normalized typed results, attribute filter chips, cursor paging, URL state,
  and Copy link. Entity cards lead to existing `/entity/<key>` history pages.
- Sources are node, experimental index, and both/compare, with a custom RPC option.
  `Both` queries at `min(head)` and compares first-page results/timings; cursors
  are source-specific. Relevant modules:
  [DataView.tsx](frontend/src/DataView.tsx), [dataRpc.ts](frontend/src/dataRpc.ts),
  [dataQuery.ts](frontend/src/dataQuery.ts), [entityCompare.ts](frontend/src/entityCompare.ts),
  [QueryEditor.tsx](frontend/src/QueryEditor.tsx), [EntityResults.tsx](frontend/src/EntityResults.tsx).
- Persisted Data preferences include `data.rpcSourceKind`, `data.rpcCustomUrl`,
  and `data.rpcMode`; shared links carry query, page size, expiration and source
  (`rpc=both` / `rpc=index`). Payload bytes are not selected in result lists.
- Payload preview on the entity page was phase 3 of the port and remains
  unestablished as complete. The inspected entity view shows metadata/size and
  operation history; genesis display was added later.
- Routes live in [frontend/src/permalinks.ts](frontend/src/permalinks.ts). The SPA
  listens to `popstate`; for browser sweeps use `history.pushState(...)` followed
  by `dispatchEvent(new PopStateEvent('popstate'))`.
- Admin views verify the deployment's token at `/api/admin/verify`. Browser keys
  recorded: `gas-price-tracker:baseload.adminBearerToken`,
  `gas-price-tracker:admin.modeEnabled`, and theme
  `gas-price-tracker:ui.theme` (`light` / `dark`). Tokens from another historical
  clone were rejected.
- Check shared-link adoption on a production build. React StrictMode's simulated
  dev unmount previously aborted a query effect whose ref guard then prevented
  retry. A working production link does not establish that dev behavior is fixed.
- Vite's `/api` proxy forwards that prefix unchanged, so a raw backend is not a
  drop-in target. `frontend/server.js` supplies the production API proxy behavior.
  Bun auto-loading `.env` can also inject container-only startup paths into a
  host backend; use an intentional local environment.
- Solid panels and self-hosted/preloaded fonts addressed washed-out surfaces and
  layout shift. DOM transparency checks must understand modern `oklab(... / a)`
  colors, not only rgba.
- Root `llms.txt` and `frontend/public/llms.txt` must remain byte-identical; a
  frontend test enforces the API documentation copy.

## Development and verification entry points

```sh
bun install
bun run typecheck
bun test

# With a deliberately selected test database:
TEST_DATABASE_URL=postgres://gas:gas@127.0.0.1:55432/gas bun test

# Build frontend from its own directory:
cd frontend
bun run build
```

Normal tests are intended to be offline; check the `DATABASE_URL` fallback noted
above before assuming they are. Integration tests use random isolated schemas
and cleanup, with a shared small admin pool to avoid exhausting connections.
A throwaway `indexer-test-pg` container (Postgres 17 Alpine, loopback 55432) exists
on this host, stopped since September 9, 19:33 UTC; `docker start indexer-test-pg`
before a Postgres test run. The full suite passed against it on September 9
(1,071 tests).

Other package scripts: `scan`, `aggregate -- --range N`, `aggregate-all -- --once`,
`aggregate-senders`, `fill-gaps`, `collect-batcher`, `serve`, and `screenshot`.
See [package.json](package.json), [frontend/package.json](frontend/package.json),
[README.md](README.md), and [.env.example](.env.example) for complete arguments.
Explicit environment configuration matters: Compose and raw CLI defaults for
transaction storage differ, and `VITE_*` changes require rebuilding the frontend.

Search verification: `bun test src/omniSearch.test.ts frontend/omniSearch.test.ts`;
after frontend build, `bun run scripts/checkOmniSearchBrowser.ts` uses mocked APIs
and an ephemeral local frontend. Entity/genesis differential checks are opt-in RPC
work; database/import/load operations should target intentional environments.

This consolidation changed documentation only. Runtime tests, imports, fixture
transactions, deployments, resets, key provisioning, and load tests were not run.
The September 9 evening addendum ran the tests, imports and comparisons described
in the genesis section on throwaway stacks; no deployment, live-index reset, key
provisioning, or load test.

## Open work and uncertainties carried forward

| Item | Evidence / next useful check |
| --- | --- |
| Direct Tiramisu credentials and restored fleet | Latest memory still lacked the post-reset control token; verify today's state before provisioning or restoring saved load/backfill. |
| Genesis: live mutation and the 100M run | Head/block-0 comparisons, the interrupted walk, the offline path and its rows/s are done (September 9, evening). Left: patch a genesis entity on a seeded chain end to end (needs a funded key), and the 100M offline import (about half a day estimated). |
| Payload preview / decoder reference support | Phase 3 preview and upstream v1-reference decoding were not recorded complete; inspect current decoder/provider integration when taking this on. |
| Instruction/documentation drift | Reconcile receipt ordering, Bun SQL driver, interval/defaults, and test DB gate in a separate authorized change; this document preserves the discrepancies. |
| Below-floor `eth_getLogs` | Current coverage can look like an empty result. Any change needs explicit unknown-coverage semantics and tests. |
| Source-specific cursors / partial history | Preserve documented cursor incompatibility, projection floor, and null pre-logs creation flags. These are known constraints, not all missing implementations. |
| Legacy weighting exactness | Old helper-less rows are approximate; documentation is not evidence of a historical rescan. |
| Operational performance | Health and balance costs were measured on older datasets; use metrics before assuming the same bottleneck or capacity now. |
| Retired Pietruszka nginx | Last note said the old site still returned 502; not rechecked. The prefill changes it mentioned are committed (`024b780`). |
| Historical infrastructure root causes | RPC outages localized to serving/auth/health paths; node OOM/crash causes and Cloudflare shared-IP theory remained unproven. |

## Source inventory

Primary memory directory:
`/home/ubuntu/.claude/projects/-home-ubuntu-arkiv-network-arkiv-chain-indexer/memory/`.
Its `MEMORY.md` is the topic index. All 23 topic files were read; later updates
inside a file were considered alongside its older paragraphs, not just frontmatter
timestamps. The following map makes the consolidation auditable without requiring
the private memory directory to understand the document.

| Memory file | Knowledge retained here |
| --- | --- |
| `scx1-devnet-setup.md` | Network migrations, ABI selection, wallet/rent/faucet behavior, calibration, key rotation, RPC failure diagnosis. |
| `decoder-wire-format-gap.md` | Decoder choice, tagged-union ABI gap, silent 400s, metadata-only handling, reference limits. |
| `decoder-image-port-contract.md` | Package identity, pinned builds, 28884 sidecar contract. |
| `works-on-main-directly.md` | Recorded main/PR workflow preferences and exceptions. |
| `db-chain-deployments-repo.md` | Manifest authority, registry distinction, component digests, version-report mismatch. |
| `chart-0-11-0-empty-blocks.md` | Dated two-network incident and pending-versus-sealed diagnostic. |
| `baseload-receipt-wait-wedge.md` | Original silent wedge and September 4 timeout/status correction. |
| `pietruszka-deploy-gotchas.md` | Build metadata, dependency restarts, hidden build failure, frontend shared context. |
| `cheesecake-edge-cloudflare.md` | Origin timing, compression/ETag transformations, API probe behavior. |
| `json-rpc-endpoint-first-pass.md` | PR #95 scope, naming, no historical hash/log backfill, differential checks, passthrough evolution. |
| `balance-readings-not-sums.md` | Sparse readings, no arithmetic, unknown versus zero, batch-cost correction. |
| `api-key-generator-pooled-proxy.md` | Proxy design/bugs/local image caveat and later retirement. |
| `hub-bouncer-key-projection.md` | Per-network projection, minting configuration, anonymous-IP hypothesis. |
| `tiramisu-baseload-calibration.md` | 50 KiB worker sizing, sustainable fee target, explicit create-only tooling. |
| `data-tab-explorer-port.md` | Shipped phases, query/source/URL behavior, comparison, unfinished preview. |
| `entity-query-engine-facts.md` | Node source, grammar/wire/errors, ordering/cursors, historical floor. |
| `entity-index-rollout-status.md` | Feature/tuning commits, zero-diff runs, fixture caveats and benchmarks. |
| `frontend-browser-driving.md` | Navigation, admin token scope, production-link checks, color parsing. |
| `tiramisu-reset-2026-09-03.md` | Same-ID reset, rotated credentials, Hub projection failure and partial recovery. |
| `baseload-config-lost-on-restart.md` | Named-config workaround superseded by live Postgres persistence. |
| `metrics-traffic-baseline.md` | Metrics validation, scrape gates, observed query costs, health panel. |
| `kalarepa-single-stack-2026-09-08.md` | Surviving checkout/Compose identity, proxy removal, paused work and missing direct keys. |
| `prefill-genesis-import.md` | PR #100, dump facts, RPC complexity, progress/import paths, sibling watcher, the completed checks and the 100M estimate. |

Additional memory:
`/home/ubuntu/.claude/projects/-home-ubuntu-arkiv-network/memory/cheesecake-rpc-quota-findings.md`
provided the later empirical quota/rate/batch findings.

Repository corroboration: `AGENTS.md`, `README.md`, `.env.example`, the documents
linked above, `docker-compose.yml`, `.github/workflows/publish-images.yml`,
`frontend/Dockerfile`, package scripts, and targeted source reads. Git history
also supplied the newer omni-search work and the older Bun SQL migration missing
from the topic memories. This is a consolidation of durable notes plus repository
evidence, not an exhaustive export of Claude conversation transcripts.

When updating this file, date deployment/benchmark observations, cite the relevant
commit or source, keep unresolved facts separate from implemented behavior, and
do not copy credentials from memory or environment files.
