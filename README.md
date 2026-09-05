# gas-price-tracker

A Bun + TypeScript Ethereum block scanner that stores gas and priority-fee metrics per block, with optional
inspected transaction rows, in **PostgreSQL**.

The scanner reads blocks sequentially, fetches every transaction receipt in each block, stores one completed
block at a time, and resumes from the last successfully stored block after restart or failure. Failed block reads
are retried and never skipped.

Standalone aggregators compute fixed-size window aggregates (2 / 5 / 10 / 20 / 50 / 100 / 200 / 500 / 1000
blocks) and sender-address activity summaries. The HTTP backend serves per-block rows, aggregated ranges, sender
stats, and optional transaction rows; a small static frontend lets you browse them in a browser.

## Quick start with Docker Compose

The supplied compose stack spins up Postgres, the forward scanner, the historical backfill scanner, the Arkiv
transaction decoder, the batcher collector enrichment loop, the range aggregator loop, the sender aggregator
loop, the backend, and the static frontend.

```sh
cp .env.example .env
# edit .env and set SCANNER_RPC_FULL_NODE to your JSON-RPC endpoint
docker compose up --build
```

Open:

- Frontend: <http://localhost:23560> (the React app talks to the backend through the same origin at `/api/*`)
- Backend API (direct): <http://localhost:3000/blocks> and <http://localhost:3000/ranges>
- Postgres: `postgres://gas:gas@localhost:5432/gas`

The default Compose port mappings bind to `127.0.0.1`, so Postgres, the direct backend API, and the frontend
portal are reachable from the host but are not published on every network interface. Override `POSTGRES_HOST`,
`BACKEND_HOST`, or `FRONTEND_HOST` only when you intentionally need a wider bind address.

The frontend container is a tiny Node `server.js` that serves the Vite-built React app from `dist/` and reverse-proxies any request starting with `/api/` to the `backend` service (the `/api` prefix is stripped). This means you don't need to expose the backend publicly. In nginx-backed deployments, leave the frontend and backend bound to loopback and publish only nginx.

The normal Docker Compose stack defaults `SAVE_TRANSACTION_DATA=false`, so production-style mainnet scans keep
block metrics but do not persist per-transaction rows or expose transaction inspection UI. Set
`SAVE_TRANSACTION_DATA=true` if you want the `/transactions`, `/senders`, and `/block/:blockNumber` APIs.

The `decoder` compose service runs the released
[arkiv-transaction-decoder](https://github.com/Arkiv-Network/arkiv-transaction-decoder) (Bun) image, pinned to
`ghcr.io/arkiv-network/arkiv-transaction-decoder:v0.2.1`; set `ARKIV_DECODER_IMAGE` to run a different build. The
scanners POST Arkiv registry (`0x44…44`) transaction calldata to `DECODER_URL`/`decode` (compose defaults
`DECODER_URL` to `http://decoder:28884`) and store the decoded operation metadata in the `transaction_operations`
table — payloads and calldata are never persisted, only entity keys, attributes, content type, expiry, and the
payload size. It reads both the tagged-union `execute()` format the chain carries today (selector `0x49650044`,
where the payload and content type arrive as the `$payload` and `$contentType` system attributes) and the older
struct format still sitting in historical blocks. Calldata alone cannot yield a create's `entity_key` (the engine
derives the key from the owner, its entity nonce and the salt, and calldata carries none of the first two), so the
scanner fills it from the `EntityCreated` log in the transaction receipt it already fetches; it stays null only
when the transaction reverted or the receipt's log count does not match the calldata's creates. This decoder does not
parse v1 payload references, so `is_reference`, `payload_reference` and `reference_verification` stay unset — it
was swapped in for the decoder that came before it, which did parse them but refused every registry call the
chain now makes. Decoding requires `SAVE_TRANSACTION_DATA=true`; set `DECODER_URL=` (empty) to disable it.

Releases publish that same decoder as `ghcr.io/arkiv-network/arkiv-chain-indexer/decoder`, built from
arkiv-transaction-decoder's source at the pinned commit with `--build-arg PORT=28884`. Kubernetes deployments
pin the app, frontend and decoder images together under one release tag and TCP-probe the decoder on 28884
without passing `PORT`, so that port is part of this image's contract rather than a compose detail: the decoder
binds 3000 on its own, being a standalone service, and an image published without the build arg fails its
startup probe and crash-loops. Keep the commit the publish workflow builds in lockstep with the image the
compose service pins.

The main `scanner` container only ever scans forward near the safe chain head (it always runs with
`SCANNER_DISABLE_BACKFILL=true`). Historical backfill runs exclusively in the separate `backfill-scanner` container
with `SCANNER_BACKFILL_ONLY=true`, sleeping for `SCANNER_BACKFILL_SLEEP_MS` after every successfully stored backfill
block (defaulting to 100ms).

`SCANNER_DISABLE_BACKFILL` is the master switch for that backfill container: it defaults to `true`, which makes the
`backfill-scanner` idle and do no work at all. Set `SCANNER_DISABLE_BACKFILL=false` in `.env` to actually run the
historical backfill.

The aggregator container runs `bun run aggregate-all` which walks every supported range size, resumes each size
after its newest completed range, and sleeps for 30 seconds after each sweep (configurable via
`AGGREGATE_INTERVAL_MS`).

The sender aggregator container runs `bun run aggregate-senders` which rebuilds address-level stats from stored
transaction rows and sleeps for one minute between rebuilds (configurable via `SENDER_AGGREGATE_INTERVAL_MS`).

The batcher collector container runs `bun run collect-batcher` which enriches already stored recent blocks with
batcher queue/threshold metrics and sleeps for ten seconds between sweeps (configurable via
`BATCHER_COLLECTOR_INTERVAL_MS`). Set `BATCHER_COLLECTOR_URL` in `.env` to enable the service; its logs are
separate from the main scanner container so collector failures can be debugged independently.
If the URL is unset, the container logs that collector enrichment is disabled and stays idle.

Baseload workers run in the backend service, not in the browser. Set `BASELOAD_RPC_NODE` to the Arkiv JSON-RPC
endpoint that should receive create transactions. The frontend only adds, edits, deletes, imports, exports, and
monitors worker configuration through `/api/baseload`.

For shared deployments, set `BASELOAD_ADMIN_BEARER_TOKEN` so mutating Baseload worker requests require
`Authorization: Bearer <token>`. Readonly views and status APIs remain public. The Baseload tab includes an admin
bearer token field that stores the token in browser local storage and sends it only with worker configuration
changes.

Set `BATCHER_COLLECTOR_URL` to attach recent batcher queue/threshold metadata to stored blocks. The collector
only serves recent seconds, so the dedicated batcher collector service requests batcher data for stored blocks
between two seconds and one hour old that are still missing those fields.

## Arkiv test Docker Compose

For Arkiv test runs where the JSON-RPC node is running on the Docker host, use the dedicated compose file:

```sh
docker compose -f docker-compose-arkiv-tests.yml up --build
```

By default this stack configures the scanner to read from the host RPC endpoint at
`http://host.docker.internal:8545`. The compose file also adds Docker host-gateway resolution so this hostname
works on Linux Docker installations.

Arkiv test compose defaults `SAVE_TRANSACTION_DATA=true`, preserving the existing transaction-row behavior for
inspection tests.

The frontend portal is published on all host interfaces by default:

- Portal: <http://localhost:20155>
- Public bind address: `0.0.0.0:20155`

Override these defaults when needed:

```sh
SCANNER_RPC_FULL_NODE=http://host.docker.internal:9545 \
ARKIV_TESTS_HOST=127.0.0.1 \
ARKIV_TESTS_PORT=20156 \
docker compose -f docker-compose-arkiv-tests.yml up --build
```

## Running locally without Docker

Requirements:

- [Bun](https://bun.sh/) 1.4 or newer
- A PostgreSQL 13+ instance reachable via `DATABASE_URL`
- An Ethereum JSON-RPC full-node endpoint

```sh
bun install
export DATABASE_URL=postgres://gas:gas@localhost:5432/gas
export SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/
bun run scan
```

The scanner runs the near-head forward loop, the historical backfill loop, or both. The Docker Compose stack runs
forward scanning and backfill in separate containers: the `scanner` container only scans forward, while the
`backfill-scanner` container only backfills (and idles entirely while `SCANNER_DISABLE_BACKFILL=true`). The backfill
loop walks older blocks in 20-second work slices and stops at `--oldest-backfill-block`, which defaults to
`25000000`.

After each block is scanned and stored, the scanner prints a per-block summary:

```txt
Block 19000000 scanned and stored
  Date: 2024-01-14T08:56:23.000Z
  Duration: 1.27s
  Transactions: 144
  Gas used: 29999.781 kGas / 30000 kGas
  Base fee: 11.143964487 Gwei
  Avg fee price: 12.562964487 Gwei
  Avg priority fee: 1.275 Gwei
  Gas-weighted avg priority fee: 1.418 Gwei
  Avg transaction gas: 208331
  RPC: 145 calls, 12.64 KiB sent, 3.41 MiB received (3.42 MiB total)
```

## Configuration

Configuration can be passed through CLI flags or environment variables.

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--database-url` | `DATABASE_URL` | **required** | PostgreSQL connection string. |
| `--oldest-backfill-block` | `SCANNER_OLDEST_BACKFILL_BLOCK` | `25000000` | Oldest block the backfill scanner will backfill to. |
| `--disable-backfill` | `SCANNER_DISABLE_BACKFILL` | `false` | Skip the historical backfill phase. The forward scanner only scans near the safe head; the backfill-only scanner idles and does nothing. |
| `--backfill-only` | `SCANNER_BACKFILL_ONLY` | `false` | Run only the historical backfill loop in continuous mode. |
| `--backfill-sleep-ms` | `SCANNER_BACKFILL_SLEEP_MS` | `100` | Delay after each successfully stored backfill block. |
| `--confirmation-depth` | `SCANNER_CONFIRMATION_DEPTH` | `3` | Number of blocks to stay behind the latest head. |
| `--poll-ms` | `SCANNER_POLL_MS` | `2000` | Delay while waiting for new safe blocks. |
| `--retry-ms` | `SCANNER_RETRY_MS` | `5000` | Delay before retrying the same failed block. |
| `--tx-receipt-concurrency` | `SCANNER_TX_RECEIPT_CONCURRENCY` | `20` | Legacy setting accepted for compatibility; receipt RPC calls are fetched sequentially. |
| `--save-transaction-data` | `SCANNER_SAVE_TRANSACTION_DATA` or `SAVE_TRANSACTION_DATA` | `true` | Store inspected transaction rows after metrics are computed. |
| `--track-balances` | `SCANNER_TRACK_BALANCES` | `false` | Record each block's sender/recipient balances by reading them from the node (one batched `eth_getBalance` per block). Feeds `GET /balances` and `eth_getBalance`. |
| `--decoder-url` | `DECODER_URL` or `SCANNER_DECODER_URL` | unset | Optional arkiv-transaction-decoder base URL (the scanner POSTs to `<url>/decode`). When set (and transaction rows are stored), Arkiv registry transactions are decoded into stored operation metadata (no payloads), including v1 payload-reference metadata and the offline verification verdict from a decoder that parses references. The scanner sends the chain id from `eth_chainId` so references are verified for the right chain. The gap filler accepts the same option. |
| n/a | `SCANNER_RPC_FULL_NODE` | **required** | Ethereum JSON-RPC endpoint. With the compose `rpc-proxy` profile this is `http://rpc-proxy:8788` (see below). |

Backend transaction-detail payment display:

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--protocol-schedule-url` | `ARKIV_PROTOCOL_SCHEDULE_URL` or `SERVER_PROTOCOL_SCHEDULE_URL` | unset | Optional Arkiv protocol schedule URL. `/transaction/<hash>` uses its active `payloadProviderPayment.providerShareBps` entry to split signed payload-reference payment gas units, converted with the transaction block's base fee, into provider-earned and burned native token. |
| `--protocol-schedule-path` | `ARKIV_PROTOCOL_SCHEDULE_PATH` or `SERVER_PROTOCOL_SCHEDULE_PATH` | unset | Optional local protocol schedule JSON path. Takes precedence over URL when both are set. |
| `--payload-provider-payment-share-bps` | `PAYLOAD_PROVIDER_PAYMENT_SHARE_BPS` or `SERVER_PAYLOAD_PROVIDER_PAYMENT_SHARE_BPS` | unset | Optional provider-share basis-point override used only when no schedule URL/path is configured. |

Show help:

```sh
bun run scan -- --help
```

#### Batcher collector worker

The Docker Compose `batcher-collector` service runs separately from the scanner:

```sh
DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  BATCHER_COLLECTOR_URL=https://batcher-collector.example \
  bun run collect-batcher
```

It does not read blocks from RPC. It queries PostgreSQL for stored blocks whose `batcher_queue_size` is still
empty and whose timestamps are inside the collector's recent-data window, then updates only the nullable batcher
metric columns.

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--database-url` | `DATABASE_URL` | **required** | PostgreSQL connection string. |
| `--batcher-collector-url` | `BATCHER_COLLECTOR_URL` or `SCANNER_BATCHER_COLLECTOR_URL` | **required** | Batcher collector base URL for recent block queue/threshold metrics. |
| `--interval-ms` | `BATCHER_COLLECTOR_INTERVAL_MS` | `10000` | Delay between collector sweeps. |
| `--once` | n/a | unset | Run one collector sweep and exit. |

### Pooled RPC proxy (`rpc-proxy` profile)

`docker-compose.yml` ships an optional `rpc-proxy` service running
[api-key-generator](https://github.com/Arkiv-Network/api-key-generator) in pooled-proxy mode: it mints a pool
of Arkiv Hub keys itself, injects one on every forwarded JSON-RPC call, retires keys that run out of monthly
quota and re-mints replacements. Fronting the upstream with it means the scanner, backfill scanner, gap filler
and Baseload workers need neither `SCANNER_RPC_API_KEY` nor an `RPC_KEY_POOL_FILE` ring. In `.env`:

```sh
COMPOSE_PROFILES=rpc-proxy
RPC_PROXY_UPSTREAM=https://rpc.cheesecake.db-chain.devnet.gobas.me   # the real node
RPC_PROXY_POOL_SIZE=100                                              # keys to keep minted (default 100)
RPC_PROXY_KEY_NAME_PREFIX=pietruszka                                 # Hub key names: <prefix>_<wallet tag>
RPC_PROXY_HUB_BASE=https://stage.hub.arkiv.network                   # Hub that mints the keys (must be the one projected into this bouncer)
RPC_PROXY_HUB_NETWORK=tiramisu                                       # Network the keys are for (empty = the Hub's default); must match RPC_PROXY_UPSTREAM
SCANNER_RPC_FULL_NODE=http://rpc-proxy:8788
BASELOAD_RPC_NODE=http://rpc-proxy:8788
```

The pool persists in the `rpcproxypool` volume, so restarts reuse live quota. Minting is sequential and
runs in the background; while the pool is still empty the proxy answers `503` and the scanner's normal retry
covers it. The service is not published on the host — only the compose network reaches it.

## Baseload Backend Workers

The Baseload view is a control plane for backend tasks. It never sends Arkiv RPC calls or private-key material
from the browser. All create transactions are produced by the backend process using `@arkiv-network/sdk`.

Backend configuration:

| Environment variable | Default | Description |
| --- | --- | --- |
| `BASELOAD_RPC_NODE` | unset | Arkiv JSON-RPC endpoint used by backend workers for block reads, transaction sends, and receipt polling. |
| `BASELOAD_MNEMONIC` | deterministic development mnemonic | Mnemonic used by the backend to derive worker wallets at `m/44'/60'/0'/0/<walletNumber>`. |
| `BASELOAD_PAYLOAD_PROVIDER_URL` | unset | Payload provider base URL used by Baseload create/update operations. |
| `BASELOAD_PAYLOAD_PROVIDER_BEARER_KEY` | unset | Optional bearer token sent to the payload provider. |
| `BASELOAD_PAYLOAD_PROVIDER_NAMESPACE` | `arkiv.entities` | Payload provider namespace for Baseload entity payloads. |
| `BASELOAD_PAYLOAD_PROVIDER_VERIFY_RECEIPT` | `true` | Whether the SDK verifies signed payload provider receipts before sending a transaction. |
| `BASELOAD_FAUCET_URL` | unset | Internal faucet base URL. Setting it enables automatic wallet top-ups; the password then becomes mandatory. |
| `BASELOAD_FAUCET_PASSWORD` | unset | Password for the faucet's `POST /login` form. Required when `BASELOAD_FAUCET_URL` is set. |
| `BASELOAD_FAUCET_MIN_BALANCE` | `100` | Ether. A wallet is dripped once its balance falls below this floor. Drips repeat until the wallet is back over it, so the floor sets the resting balance: wallets settle in `[MIN, MIN + DRIP)`. |
| `BASELOAD_FAUCET_MAX_BALANCE` | `200` | Ether. A drip is skipped when it would leave the wallet at or above this ceiling. It is a safety net, not the resting point, and must be at least `MIN + DRIP` — a lower ceiling would refuse drips to wallets that are already below the floor. |
| `BASELOAD_FAUCET_DRIP_AMOUNT` | `100` | Ether. Expected size of one drip, used to project the post-drip balance against the ceiling. |
| `BASELOAD_FAUCET_COOLDOWN_SECONDS` | `60` | Minimum gap between two drips for the same wallet. |
| `BASELOAD_ADMIN_BEARER_TOKEN` | unset | Optional bearer token required for mutating Baseload worker configuration requests. Readonly requests stay public. |
| `BASELOAD_INITIAL_CONFIG_PATH` | unset | Optional container path to a Baseload worker config JSON file that the backend loads once at startup. |
| `BASELOAD_RPC_KEY_SERVICE_URL` | unset | Base URL of an [api-key-generator](https://github.com/Arkiv-Network/api-key-generator) instance. Setting it gives every worker its own generated RPC key instead of the one shared key in `BASELOAD_RPC_NODE`. |
| `BASELOAD_RPC_KEY_PLACEMENT` | `bearer` | How a key is attached: `bearer` (`Authorization: Bearer <key>`), `header` (see below), or `path` (key as the last URL segment). |
| `BASELOAD_RPC_KEY_HEADER` | `X-Api-Key` | Header name used when the placement is `header`. |
| `BASELOAD_RPC_KEY_NAME_PREFIX` | `baseload` | Keys are requested from the generator as `<prefix>_<worker id>`. |
| `BASELOAD_RPC_KEY_STORE` | `baseload-keys/rpc-keys.json` | JSON file the minted keys are cached in. Compose points this at a writable volume so a restart reuses keys. |
| `BASELOAD_RPC_KEY_TIMEOUT_SECONDS` | `180` | Budget for one mint. Minting solves a captcha proof-of-work, so it is slow. |

### RPC calls per operation

A worker's rate-limit budget, not the chain, is what caps a load run, so each operation is sent over the SDK's
advanced path (`sendMutation` / local receipt decoding) rather than the everyday `executeBatch`, which bundles
build, send, wait and decode and pays for each in RPC calls.

| Per operation | Before | Now |
| --- | --- | --- |
| `eth_getTransactionCount` (nonce) | 1 | 0 — read once per worker, then advanced locally behind each confirmed receipt |
| `eth_blockNumber` (expiry head) | 1 | 0 — receipts carry the height, extrapolated at the 2s block time between them |
| `eth_estimateGas` | 1 | 0 — the limit is learned from the gas a batch of the same shape burnt, with 50% headroom |
| `eth_sendRawTransaction` | 1 | 1 |
| `eth_getTransactionReceipt` | SDK polling + 1 confirmation read | the worker's own jittered polls only |

The remaining fixed costs are one `eth_chainId` per client and one `eth_getBalance` per worker per 10s balance
poll. A first batch of a given shape still spends one `eth_estimateGas`, and the first send on a client spends one
rejected `eth_fillTransaction` probe unless the chain id is supplied (it is).

Anything that fails — a rejected send, a reverted batch — makes the worker forget both the cached nonce and that
shape's gas limit, so the next attempt re-reads them from the chain.

### Per-worker RPC keys

A single API key is rate-limited as one bucket, and that bucket — not the chain — is the first thing to refuse
traffic as the worker count grows (on a bouncer-fronted devnet, ~7 workers on one key is enough to draw steady
HTTP 429s on `eth_getTransactionCount`/`eth_blockNumber`). Pointing `BASELOAD_RPC_KEY_SERVICE_URL` at an
[api-key-generator](https://github.com/Arkiv-Network/api-key-generator) instance gives each worker its own key,
so the limit scales with the fleet:

```sh
# .env
COMPOSE_PROFILES=rpc-keys
BASELOAD_RPC_KEY_SERVICE_URL=http://arkiv-keys:8787
# No key in the URL any more — each worker brings its own.
BASELOAD_RPC_NODE=https://braga.hoodi.arkiv.network/rpc
```

The `arkiv-keys` Compose service runs the generator image. It sits behind the `rpc-keys` profile because it
carries a headless Chromium, so it only starts when `COMPOSE_PROFILES` asks for it.

Keys are minted lazily on a worker's first RPC call, one at a time (the generator shares a single browser across
requests), and written to `BASELOAD_RPC_KEY_STORE` on the `baseloadkeys` volume so a restart does not pay for the
captcha again. A mint failure surfaces as a worker error and is retried on the next pass; the other workers keep
running on the keys they already hold.

The generator mints **Arkiv Hub** keys, one per freshly generated wallet. The Hub portal moved to
`stage.hub.arkiv.network` (the generator still targets `devnet.hub.arkiv.network`); as of 2026-08-20 the
cheesecake bouncer accepts Hub keys from either portal, so a Hub-minted pool works directly against
`rpc.cheesecake.db-chain.devnet.gobas.me`. That has not always been true — a per-network bouncer keeps its own key
store and may answer Hub keys with HTTP 401, in which case mint through the network's `rpc-control` endpoint
instead and set `BASELOAD_RPC_KEY_PLACEMENT=header` or `path` to match. Check with a single `eth_blockNumber`
before provisioning a whole pool.

### Initial Baseload config with Docker Compose

By default the Compose stack does not load any initial Baseload workers. To let an external integration provide
the initial `config.json`, write the file into a host directory and point Compose at that directory:

```sh
# .env
BASELOAD_CONFIG_DIR=/absolute/path/from/external-integration
BASELOAD_INITIAL_CONFIG_PATH=/app/baseload-config/config.json
```

`docker-compose.yml` mounts `BASELOAD_CONFIG_DIR` read-only at `/app/baseload-config` inside the backend
container. The backend reads `BASELOAD_INITIAL_CONFIG_PATH` once during `bun run serve` startup, validates it with
the same backend Baseload config rules used by the API, and then starts the configured workers if `BASELOAD_RPC_NODE`
is also set.

Expected file shape:

```json
{
  "version": 2,
  "workers": [
    {
      "walletNumber": 0,
      "name": "Office hours",
      "behavior": "create",
      "maxGasPriceGwei": 1000,
      "opsPerMinute": 1,
      "entitiesPerRequest": 1,
      "singleCreatePayloadSize": 5000,
      "singleCreateStringArgumentCount": 2,
      "singleCreateNumberArgumentCount": 2,
      "entityPoolSize": 10,
      "timeBombOffsetSeconds": 600,
      "startBlock": 0,
      "endBlock": null,
      "durationSeconds": null,
      "ttlSeconds": 3600,
      "dailyWindow": "04:30-18:30",
      "hourlyWindow": "24-58"
    }
  ]
}
```

Missing worker fields use the backend defaults where supported, and wallet addresses are derived from
`BASELOAD_MNEMONIC`. Leave `BASELOAD_INITIAL_CONFIG_PATH` unset to keep the existing empty startup config. Local
JSON files under `baseload-config/` are ignored by Git and by Docker builds so integration-provided configs are not
committed or copied into the image.

Worker behaviors (`behavior` field):

| Behavior | Description |
| --- | --- |
| `create` | Creates up to `entitiesPerRequest` entities per request. |
| `create-update` | Creates entities until the pool holds `entityPoolSize` entities, then keeps updating pool entities with fresh random data. Create and update requests handle up to `entitiesPerRequest` entities. Every update resets the entity TTL to `ttlSeconds`, so pool entities are never lost as long as the worker keeps up. |
| `create-ownership` | Creates up to `entitiesPerRequest` entities, then transfers their ownership to freshly generated random addresses. |
| `time-bomb` | Creates up to `entitiesPerRequest` entities per request whose TTL is computed so that every one of them expires at the same precise moment: run start plus `timeBombOffsetSeconds`. The worker completes once the detonation moment is closer than a TTL can land. |
| `create-update-delete` | Maintains a pool of about `entityPoolSize` entities while cycling create, update, and delete requests that handle up to `entitiesPerRequest` entities. |

Worker mechanics:

- Each configured worker runs on the backend within its configured start block, optional end block, and optional duration.
- `name` is a free-form label (up to 64 characters) shown in the panel instead of the wallet number.
- `dailyWindow` (`"HH:MM-HH:MM"`, UTC) and `hourlyWindow` (`"MM-MM"`, minutes of every hour) pause the worker outside the given ranges without ending its run. Ends are exclusive and ranges may wrap (`"22:00-04:00"`, `"50-10"`); an hourly end may also run past 60 (`"50-70"` is the same window as `"50-10"`, at most one hour long); when both are set the worker is active only while both hold, so `"04:30-18:30"` plus `"24-58"` means minutes 24 to 57 of every hour between 04:30 and 18:30 UTC. Leave either `null` for "always".
- `entitiesPerRequest` is currently normalized to at most `1`; increase load with `opsPerMinute` or multiple worker wallets instead of multi-entity mutation batches.
- Each worker targets up to its configured operations per minute. Each operation submits one Arkiv mutation request for up to `entitiesPerRequest` entities. If a minute is missed or under-filled, unused capacity is not carried into later minutes.
- Each worker performs one request at a time and waits for the transaction receipt before submitting the next one (`create-ownership` sends one create batch and then one ownership-change batch because ownership changes need the newly created entity keys).
- Gas is set aggressively from the worker's max gas price: both `maxFeePerGas` and `maxPriorityFeePerGas` use the configured gwei value.
- Each create or update uses a random binary payload of the configured size, a project attribute, and the configured count of random string and numeric attributes. Defaults are two string attributes and two numeric attributes.
- Entity TTL is set from the worker's TTL seconds value, except for `time-bomb` workers where it is derived from the detonation moment.
- Pool entities whose estimated TTL has lapsed are treated as lost and replaced by new creates.

Backend API:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/baseload` | Returns backend Baseload enabled state, current config, and worker statuses. |
| `PUT` | `/baseload` | Replaces the backend Baseload config and starts, updates, or stops backend workers to match it. Requires `Authorization: Bearer <token>` when `BASELOAD_ADMIN_BEARER_TOKEN` is set. |

## Nginx Deployment

The repository includes an nginx site config named `scanner.arkiv-global.net` for the public portal URL
`https://scanner.arkiv-global.net`. It assumes the normal Compose stack is running with loopback bindings:

- Frontend upstream: `http://127.0.0.1:23560`
- Backend upstream for `/api`: `http://127.0.0.1:3000`

Install the site config on the host:

```sh
./deploy-nginx
```

The script copies `scanner.arkiv-global.net` into `/etc/nginx/sites-available/`, links it from
`/etc/nginx/sites-enabled/`, and runs `nginx -t`. After that, run certbot for TLS certificates.

## Stored Metrics

Rows are stored in the `blocks` table. Large integer values are stored as decimal strings so wei values do not
lose precision.

| Column | Meaning |
| --- | --- |
| `block_date` | Block timestamp as an ISO-8601 UTC string. |
| `block_number` | Ethereum block number (PostgreSQL `BIGINT`). |
| `block_time_seconds` | Integer seconds between this block timestamp and the previous block timestamp; block `0` stores `2`. |
| `base_block_fee_wei` | Block `baseFeePerGas` in wei. Legacy networks without a base fee store `0`. |
| `total_gas_used` | Block `gasUsed`. |
| `max_gas_in_block` | Block `gasLimit`; this is the maximum possible gas for that block and can vary by network. |
| `transaction_count` | Number of transactions in the block. |
| `total_transaction_fee_wei` | Sum of actual transaction fees: `sum(receipt.gasUsed * effectiveGasPrice)`. |
| `fee_price_sum_wei` | Exact sum of transaction fee prices: `sum(effectiveGasPrice)`. |
| `priority_fee_sum_wei` | Exact sum of transaction priority fee prices: `sum(priorityFee)`. |
| `priority_fee_weighted_numerator_wei` | Legacy exact numerator for transaction-fee-weighted priority fee: `sum(priorityFee * transactionFee)`. |
| `priority_fee_gas_weighted_numerator_wei` | Exact numerator for the gas-weighted priority-fee calculation: `sum(priorityFee * receipt.gasUsed)`. |
| `average_fee_price_wei` | Simple average effective gas price across transactions: `sum(effectiveGasPrice) / transaction_count`. |
| `average_transaction_fee_wei` | Average actual transaction fee, computed as `gasUsed * effectiveGasPrice` per transaction. |
| `average_transaction_gas_used` | Average transaction gas used: `sum(receipt.gasUsed) / transaction_count`. |
| `average_priority_fee_weighted_wei` | Average priority fee weighted by transaction gas used. |
| `average_priority_fee_wei` | Simple average priority fee across transactions. |
| `batcher_queue_size` | Optional batcher collector `current_load` for the block timestamp. |
| `batcher_intensity` | Optional batcher collector `intensity`. |
| `batcher_lower_threshold` | Optional batcher collector `lower_threshold`. |
| `batcher_upper_threshold` | Optional batcher collector `upper_threshold`. |
| `batcher_max_block_size` | Optional batcher collector `max_block_size`. |
| `batcher_max_tx_size` | Optional batcher collector `max_tx_size`. |

Priority fee is computed as:

```txt
max(effectiveGasPrice - baseFeePerGas, 0)
```

The weighted priority fee is computed as:

```txt
sum(priorityFee * receipt.gasUsed) / sum(receipt.gasUsed)
```

For empty blocks all averages are stored as `0`.

### Arkiv operation metadata

When a decoder URL is configured and transaction rows are stored, decoded Arkiv operations land in the
`transaction_operations` table, keyed by `(block_number, position, op_index)` and indexed by transaction hash and
entity key. Each row stores metadata only: operation type and name, entity key (for creates, read from the
receipt's `EntityCreated` log rather than calldata), content type, attribute key/value
pairs (JSONB), expiry in blocks, new owner, and the payload size in bytes. For v1 reference-mode operations it also
stores `is_reference`, the parsed payload reference (`payload_reference`, JSONB — provider receipt metadata such as
id, checksum, size, and signature, never the entity bytes), the offline verification verdict
(`reference_verification`, JSONB — `valid`, `signerTrusted`, recovered signer, and any errors), and
`reference_error` when a reference payload failed to parse. Transaction payloads and calldata are never persisted.
Re-scanning a block replaces its operation rows in the same database transaction as its transaction rows.

### Range Aggregates

In addition to the per-block `blocks` table, completed fixed-size windows can be aggregated into the
`block_ranges` table. Windows for a given size `M` are `[k * M, k * M + M - 1]` (for example
`245600-245699` when `M = 100`).

Supported range sizes:

```
2, 5, 10, 20, 50, 100, 200, 500, 1000
```

Two aggregation runners are available:

- **One-shot, single size**:

  ```sh
  bun run aggregate -- --range 50
  ```

- **Periodic, every supported size** (used by the compose `aggregator` service):

  ```sh
  bun run aggregate-all
  # or, in a one-shot sweep:
  bun run aggregate-all -- --once
  ```

- **Sender address stats** (used by the compose `sender-aggregator` service):

  ```sh
  bun run aggregate-senders
  # or, in a one-shot rebuild:
  bun run aggregate-senders -- --once
  ```

Single-range aggregator runs walk every aligned window from `floor(min_stored_block / M) * M` up through the
highest stored block, and write a row only for windows where all `M` blocks are present in `blocks`. Incomplete
windows are skipped (and can be re-aggregated later once the missing blocks are scanned). Periodic
`aggregate-all` sweeps mark completed rows and resume each range size from its newest completed range, so later
sweeps do not recompute historical windows.

Each size lives independently in `block_ranges` keyed by `(range_size, range_start)`.

| Column | Meaning |
| --- | --- |
| `range_size` | Window size in blocks. |
| `range_start`, `range_end` | First and last block numbers in the window. |
| `min_block_date`, `max_block_date` | Earliest and latest block timestamp in the window. |
| `min_base_fee_wei`, `max_base_fee_wei` | Min and max `base_block_fee_wei` across the window. |
| `average_base_fee_wei` | Unweighted mean of the window base fees (integer division in wei). |
| `total_gas_used` | Sum of `total_gas_used` across the window. |
| `total_max_gas` | Sum of `max_gas_in_block` across the window. |
| `min_max_gas_in_block`, `max_max_gas_in_block` | Min and max block gas limit (`max_gas_in_block`) across the window. |
| `transaction_count` | Sum of `transaction_count` across the window. |
| `average_fee_price_wei` | `sum(block.average_fee_price_wei * block.transaction_count) / sum(block.transaction_count)`. |
| `average_transaction_gas_used` | `sum(block.average_transaction_gas_used * block.transaction_count) / sum(block.transaction_count)`. |
| `average_priority_fee_weighted_wei` | `sum(block.priority_fee_gas_weighted_numerator_wei) / sum(block.total_gas_used)`. Legacy block rows without that exact field fall back to `sum(block.average_priority_fee_weighted_wei * block.total_gas_used) / sum(block.total_gas_used)`. |
| `average_priority_fee_wei` | `sum(block.average_priority_fee_wei * block.transaction_count) / sum(block.transaction_count)`. |
| `is_complete` | Marks rows whose full block window was present when the range aggregate was written. |

When `total_gas_used` or `transaction_count` for the window is `0` the corresponding average is stored as `0`.

#### Aggregator options

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--range` | `AGGREGATE_RANGE` | required (single-range) | Window size. One of: 2, 5, 10, 20, 50, 100, 200, 500, 1000. |
| `--database-url` | `DATABASE_URL` | required | PostgreSQL connection string. |
| `--from-block` | `AGGREGATE_FROM_BLOCK` | unset | Optional lower bound on the windows to consider. |
| `--to-block` | `AGGREGATE_TO_BLOCK` | unset | Optional upper bound on the windows to consider. |
| `--interval-ms` | `AGGREGATE_INTERVAL_MS` | `30000` | (aggregate-all) sleep after each full sweep. |
| `--once` | n/a | unset | (aggregate-all) run one sweep then exit. |

#### Sender aggregator

The sender aggregator rebuilds `sender_stats` from stored rows in `transactions`, grouping by normalized
`from_address`. This requires transaction storage to have been enabled while scanning. Each sender row stores the
latest found nonce, found transaction count, total gas used, total transaction fees, total sent value, average gas
used, average transaction fee, first/last seen block/date, and aggregation timestamp.

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--database-url` | `DATABASE_URL` | required | PostgreSQL connection string. |
| `--interval-ms` | `SENDER_AGGREGATE_INTERVAL_MS` | `60000` | Sleep between full sender-stat rebuilds. |
| `--once` | n/a | unset | Run one rebuild then exit. |

## Resume Behavior

Forward progress is stored in the `scanner_state` table as `last_successful_block`. Continuous backfill progress
is stored separately as `backfill_next_block`.

General invariants:

1. Forward scanning resumes from `last_successful_block + 1`.
2. A block and its progress update are committed in the same PostgreSQL transaction.
3. If reading, computing, or writing a block fails, progress is not advanced.
4. The scanner retries the same block after `--retry-ms`.

For continuous scans:

1. The backfill cursor starts at the current safe head when no prior cursor exists.
2. The backfill loop walks backward for 20 seconds of work, updating `backfill_next_block` only with the block row.
3. After each successful backfill write, the loop sleeps for `--backfill-sleep-ms`.
4. The forward loop scans through the latest safe head, updating `last_successful_block` only with the block row
   and transaction rows committed.
5. The backward cursor stops at `--oldest-backfill-block`.

This means failed block reads are not skipped.

## HTTP Server

A read-only HTTP server is included that serves stored block, range, and optional transaction rows from the same
PostgreSQL database. Run it alongside the scanner (or against an existing database):

```sh
DATABASE_URL=postgres://gas:gas@localhost:5432/gas bun run serve
# or
bun run serve -- --database-url postgres://gas:gas@localhost:5432/gas --port 3000
```

By default the server listens on port `3000`. CORS headers are set on every response so the static frontend can
fetch from a different origin.

Set `SERVER_TRANSACTION_DATA_ENABLED=false` or `SAVE_TRANSACTION_DATA=false` to disable transaction inspection
endpoints and advertise that state to the frontend through `GET /health`.

### `GET /blocks`

Returns stored block rows ordered by `block_number` descending by default. The response is always capped at
**10,000 rows** (newest matching blocks first). All four filters below are optional and combine additively
(AND). With no filters the newest 10,000 stored blocks are returned.

The response uses a compact row format: `names` lists the field names once, and each entry in `blocks` is an
array of values in that same order.

| Query parameter | Description |
| --- | --- |
| `blockGt` | Only blocks with `block_number > blockGt`. |
| `blockLt` | Only blocks with `block_number < blockLt`. |
| `dateGt` | ISO-8601 timestamp; only blocks newer than this. |
| `dateLt` | ISO-8601 timestamp; only blocks older than this. |
| `limit` | Maximum rows to return, capped at 10,000. |
| `order` | `desc` for newest first, or `asc` for oldest first. |

Example:

```sh
curl 'http://localhost:3000/blocks?blockGt=19000000&blockLt=19000005'
```

Abbreviated response shape:

```json
{
  "count": 1,
  "limit": 10000,
  "truncated": false,
  "filters": {
    "blockGt": "19000000",
    "blockLt": "19000005",
    "dateGt": null,
    "dateLt": null
  },
  "names": ["blockNumber", "blockDate", "baseBlockFeeWei"],
  "blocks": [[19000004, "2026-05-27T11:55:42.000Z", "251"]]
}
```

### `GET /blocks/:blockNumber`

Returns a single stored block as only the compact value row array. The field order is the same order returned
by `GET /blocks` in `names`. If the block has not been scanned into PostgreSQL, this endpoint returns `404`.

### `GET /block/:blockNumber`

Returns stored block metadata plus stored transaction rows for one scanned block. It does not call JSON-RPC and
does not use an in-memory cache.

If transaction data is disabled, or if the block has not been scanned into PostgreSQL, this endpoint returns
`404`.

### `GET /transactions`

Returns stored transaction rows ordered by block number and position, newest first by default. When transaction data is disabled this
endpoint returns `404`. Responses are capped at **1,000
transactions**. Use `block` for an exact block query, or combine date and block range filters additively.

| Query parameter | Description |
| --- | --- |
| `block` | Only transactions from exactly this block number. |
| `blockGt` | Only transactions with `block_number > blockGt`. Ignored by the frontend when `block` is set. |
| `blockLt` | Only transactions with `block_number < blockLt`. Ignored by the frontend when `block` is set. |
| `dateGt` | ISO-8601 timestamp; only transactions in blocks newer than this. |
| `dateLt` | ISO-8601 timestamp; only transactions in blocks older than this. |
| `limit` | Maximum rows to return, up to `1000`. |
| `order` | `asc` or `desc`; defaults to `desc`. |

Example:

```sh
curl 'http://localhost:3000/transactions?dateGt=2024-01-01T00:00:00Z&dateLt=2024-01-02T00:00:00Z&limit=1000'
```

Rows for Arkiv registry transactions with stored operations additionally carry an `operationsSummary` array of
`{ operation, operationType, count }` entries (ordered by operation type); rows without stored operations omit
the field.

### `GET /transaction/:hash`

Returns one stored transaction as `{ "transaction": ... }`. The transaction always includes an `operations`
array with the decoded Arkiv operation metadata recorded for it (empty when none): operation type/name, entity
key, content type, attributes, expiry, new owner, and `payloadSizeBytes`, plus the reference-mode fields
`isReference`, `payloadReference`, `referenceVerification`, and `referenceError` for v1 reference operations.
Payload bytes are never stored or returned. Returns `404` when the hash is unknown or transaction data is disabled.

### `GET /entity/:entityKey`

Returns the chronological history of every stored operation on one Arkiv entity key (create, update, extend,
transfer, delete, expire) as `{ "entityKey", "count", "operations" }`. The key must be `0x` plus 64 hex
characters and is normalized to lowercase. Operations are ordered by block number, transaction position, and
operation index ascending, capped at **1,000 rows**, and each carries its transaction context (`blockNumber`,
`blockNumberDecimal`, `blockDate`, `position`, `hash`) alongside the same operation fields as
`/transaction/:hash`. Returns `404` when no operations are stored for the key or transaction data is disabled.
The frontend serves this history at `/entity/<key>`, linked from every entity key on a transaction page.

### `GET /senders`

Returns precomputed sender-address stats ordered from most active to least active by default. When transaction
data is disabled this endpoint returns `404`. Responses are capped at **10,000 sender addresses**.

| Query parameter | Description |
| --- | --- |
| `limit` | Maximum rows to return, up to `10000`. |
| `order` | `asc` or `desc`; defaults to `desc` by found transaction count. |

Example:

```sh
curl 'http://localhost:3000/senders?limit=100'
```

### `GET /balances`

Returns stored account balance readings, newest block first. Responses are capped at **10,000 rows**.

Balances are **read, never computed**. For each block the scanner takes the addresses that sent or received a
transaction in it and asks the node what they are worth at that block (one batched `eth_getBalance` per
block). Summing transaction values would drift instead: balances also move through contract-internal
transfers, fee payments and withdrawals that a block's transaction list does not show, and the index has no
genesis anchor to sum forward from.

That makes this a **sparse series**, not one row per account per block: a row exists only where an address was
a sender or recipient, and each row is exact at its own block. Set `SCANNER_TRACK_BALANCES=true` to record
them; nothing is backfilled, so coverage starts at the block where it was switched on.

| Query parameter | Description |
| --- | --- |
| `block` | Exactly one block — the "who held what at block N" view. |
| `address` | One account's history. A 20-byte hex address; matched case-insensitively. |
| `blockGt`, `blockLt` | Exclusive block bounds. |
| `limit` | Maximum rows to return, up to `10000`. |
| `order` | `asc` or `desc` by block number; defaults to `desc`. |

Example:

```sh
curl 'http://localhost:3000/balances?block=638598'
curl 'http://localhost:3000/balances?address=0xaaaa...aaaa&limit=100'
```

### `GET /ranges`

Returns aggregated fixed-size windows ordered by `range_start` ascending. Each request targets a single
range size via the `rangeSize` query parameter (defaults to `100`). Responses are capped at **10,000 ranges**.
If no aggregates exist for the requested `rangeSize`, the response is `{ "count": 0, "ranges": [] }`.

| Query parameter | Description |
| --- | --- |
| `rangeSize` | Window size. One of: 2, 5, 10, 20, 50, 100, 200, 500, 1000. Defaults to `100`. |
| `rangeStartGt` | Only ranges with `range_start > rangeStartGt`. |
| `rangeStartLt` | Only ranges with `range_start < rangeStartLt`. |
| `dateGt` | ISO-8601 timestamp; only ranges whose `max_block_date` is newer than this. |
| `dateLt` | ISO-8601 timestamp; only ranges whose `min_block_date` is older than this. |

Example:

```sh
curl 'http://localhost:3000/ranges?rangeSize=50&rangeStartGt=245500&rangeStartLt=245700'
```

### `GET /sync`

Reports how far the forward scanner trails the chain head, whether the gap is closing, and when the scanner is
expected to catch up. `GET /health` embeds the identical object under `sync`; this endpoint skips the per-table
database statistics so the frontend can poll it every few seconds.

```json
{
  "ok": true,
  "serverTimeUtc": "2026-08-18T12:48:48.910Z",
  "sync": {
    "state": "catching-up",
    "summary": "Scanner is 598 blocks (19m 58s) behind and catching up at 10.92x chain speed; synced in ~2m 1s",
    "lastSuccessfulBlock": "217867",
    "lastSuccessfulBlockDate": "2026-08-18T12:28:51.000Z",
    "latestObservedBlock": "218296",
    "latestObservedAtUtc": "2026-08-18T12:43:09.944Z",
    "headObservationAgeSeconds": 338.966,
    "headObservationStale": true,
    "estimatedHeadBlock": "218465",
    "observedLagBlocks": "429",
    "lagBlocks": "598",
    "lagSeconds": 1197.91,
    "chainBlockTimeSeconds": 2,
    "chainBlocksPerSecond": 0.5,
    "scanBlocksPerSecond": 5.46,
    "speedupFactor": 10.92,
    "netCatchUpBlocksPerSecond": 4.96,
    "etaSeconds": 120.55,
    "etaUtc": "2026-08-18T12:50:49.456Z",
    "measuredWindowSeconds": 109.692,
    "measuredBlocks": 599
  }
}
```

`state` is one of:

| State | Meaning |
| --- | --- |
| `synced` | At the chain head (5 blocks or fewer behind). |
| `catching-up` | Behind, but scanning faster than the chain produces blocks; `etaSeconds` estimates the catch-up time. |
| `holding` | Behind and matching chain speed, so the gap is steady and there is no ETA. |
| `falling-behind` | Behind and scanning slower than the chain; the gap grows and there is no ETA. |
| `stalled` | Behind and nothing has been stored for over two minutes. |
| `unknown` | Not enough stored blocks or head observations to measure progress yet. |

Notes on how the numbers are derived:

- Scan and chain rates are measured over the run of blocks at the scan tip (up to 600 blocks), skipping blocks the
  backfill scanner wrote, since those move downward and would invent forward progress. The measurement window
  extends to *now*, so an idle scanner's rate decays instead of freezing at its last burst speed.
- The forward scanner only re-reads the chain head once per scan loop, so `latestObservedBlock` can be minutes old
  during a long catch-up (`headObservationStale` flags that). `estimatedHeadBlock` extrapolates it to now using the
  measured block time, and `lagBlocks` is measured against that estimate; `observedLagBlocks` uses the raw
  observation.

### `POST /shadow-rpc`

An Ethereum JSON-RPC 2.0 endpoint answered from stored scanner data. No read ever reaches a node; the one
exception is the optional passthrough below, which relays transaction submission to a real one because no
index can accept a transaction. Single requests and batches (up to 100 entries, 1 MiB body) are accepted; every reply is
HTTP `200` with a JSON-RPC body, including errors, so standard clients (`viem`, `ethers`, `cast`) can point at
`/shadow-rpc` (or `/api/shadow-rpc` through the frontend proxy and nginx) directly. `GET /health` advertises it
under `features.jsonRpc`.

The name is a warning, not decoration: this is a *shadow* of the chain cast by the index, not a node. It
answers from what the scanner happened to store, so treat it as a fast read cache for indexed history rather
than a source of truth — anything you would trust for consensus, settlement or proofs belongs on a real node.
Two differences in particular are deliberate:

- **`latest` means the indexed head.** `eth_blockNumber` and the `latest` / `pending` / `safe` / `finalized`
  tags all resolve to `scanner_state.last_successful_block`, not the chain head. `eth_syncing` reports the gap
  (`false` once the scanner is within a few blocks of the observed head). `earliest` is the oldest stored block.
- **Fields the scanner does not persist are `null`.** Block, transaction and receipt objects keep the standard
  shape, but roots, miner, `logsBloom` and signatures (`v`/`r`/`s`) come back as `null` until those are
  indexed. `input` is always `null`: calldata is never stored. Block `hash` / `parentHash` (and the `blockHash`
  on transactions, receipts and logs) plus receipt event logs (`transaction_logs`: address, topics, data) are
  stored for every block scanned since those columns were added; blocks scanned before that keep `null` (there
  is no backfill) — hash-addressed lookups of those answer `null` like a node does for an unknown hash, and
  their receipts report `logs: null` rather than `[]` so "not indexed" is distinguishable from "no events".

Transaction counts and listings only cover stored rows — the scanner drops the chain's system transaction
(sender `0xDeaD…0001`), so a block's `transactions` array and `eth_getBlockTransactionCountByNumber` are one
lower than a node reports on blocks that carry it; `transactionIndex` keeps the original on-chain position.

| Method | Answer |
| --- | --- |
| `web3_clientVersion` | `arkiv-chain-indexer/v<version>[-<commit>]/bun-<version>`. |
| `eth_chainId`, `net_version` | Chain id the scanner persisted at startup (`-32000` until it has). |
| `net_listening`, `eth_mining`, `eth_hashrate`, `eth_accounts` | `true`, `false`, `0x0`, `[]`. |
| `eth_blockNumber` | Indexed head. |
| `eth_syncing` | `false`, or `{ startingBlock, currentBlock, highestBlock }` while behind. |
| `eth_getTransactionCount(address, tag)` | Highest stored nonce sent by `address` up to `tag`, plus one (exact for EOAs). |
| `eth_getBalance(address, tag?)` | The newest stored balance reading for `address` at or before `tag` (see `GET /balances`). Errors with `-32000` when the index holds no reading that early — never `0x0`, so an unindexed account is never mistaken for an empty one. |
| `eth_gasPrice`, `eth_maxPriorityFeePerGas` | geth's oracle over stored data: the 60th percentile of each of the last 20 blocks' cheapest tip; `eth_gasPrice` adds the indexed head's base fee. |
| `eth_feeHistory(count, newest, percentiles?)` | Exact: per-block `baseFeePerGas`, `gasUsedRatio`, and gas-weighted `reward` percentiles from stored transactions (max 1,024 blocks). The closing "next block" base fee repeats the newest one when that block is not stored yet. |
| `eth_getBlockByNumber(tag, full)`, `eth_getBlockByHash(hash, full)` | Stored block; hashes or full transaction objects. `{ "blockHash": … }` block parameters work too. |
| `eth_getBlockTransactionCountByNumber(tag)`, `eth_getBlockTransactionCountByHash(hash)` | Stored transaction count. |
| `eth_getTransactionByHash`, `eth_getTransactionByBlockNumberAndIndex`, `eth_getTransactionByBlockHashAndIndex` | Stored transaction object. |
| `eth_getTransactionReceipt(hash)` | Stored receipt fields (`status`, `gasUsed`, `cumulativeGasUsed`, `effectiveGasPrice`, `contractAddress`) and stored `logs` (`null` for pre-logs rows). |
| `eth_getLogs(filter)` | Stored logs matching `fromBlock`/`toBlock` (default `latest`, `toBlock` clamped to the indexed head) or `blockHash`, `address` (one or a list) and positional `topics` (value, list of alternatives, or `null`). At most 10,000 blocks per call and 10,000 matching logs, otherwise error `-32000`. |
| `eth_getUncle*` | No uncles: counts are `0x0`, lookups `null`. |

Transaction-backed methods return `-32000` when transaction data is disabled. Unknown methods return
`-32601`, so state methods (`eth_call`, `eth_estimateGas`, …) fail fast instead of silently hitting a node —
unless the passthrough below is configured to forward them.

#### Passthrough to a real node

Everything above is answered from PostgreSQL, which works for reads and cannot work for writes: a transaction
has to reach a node's mempool, and no amount of stored history puts it there. Setting `SHADOW_RPC_UPSTREAM`
opens one narrow hole — the methods in `SHADOW_RPC_UPSTREAM_METHODS`, and only those, are relayed to that node
and their answers returned unchanged. It is never an open proxy. Unset (the default) nothing is forwarded and
the endpoint talks to nothing but PostgreSQL. `GET /health` lists what is forwarded under
`features.jsonRpcPassthrough`, or `false` when nothing is.

| Environment variable | Default | Description |
| --- | --- | --- |
| `SHADOW_RPC_UPSTREAM` | unset | JSON-RPC node forwarded calls are sent to; unset disables the passthrough. In compose, `http://rpc-proxy:8788` reuses the pooled-key proxy. |
| `SHADOW_RPC_UPSTREAM_API_KEY` | unset | Sent as `x-api-key`, for an upstream that wants a header rather than a key baked into the URL. |
| `SHADOW_RPC_UPSTREAM_METHODS` | `eth_sendRawTransaction,arkiv_query,arkiv_getEntity,arkiv_getEntityCount,arkiv_getBlockTiming` | Methods to forward. Each overrides the locally answered one. |
| `SHADOW_RPC_UPSTREAM_TIMEOUT_MS` | `10000` | How long one forwarded call may take. |
| `SHADOW_RPC_UPSTREAM_RATE_LIMIT_PER_MINUTE` | `600` | Forwarded calls per minute across all callers; `0` removes the cap. |

Worth knowing before pointing a wallet at it:

- **`eth_sendRawTransaction` is the only write method forwarded by default.** Wallets and SDKs sign locally
  and submit the raw form; `eth_sendTransaction` would need the node to hold keys, which a public endpoint has
  no business relying on. List it explicitly if a deployment's node really does.
- **The Arkiv entity reads (`arkiv_query`, `arkiv_getEntity`, `arkiv_getEntityCount`, `arkiv_getBlockTiming`)
  are forwarded by default too.** The index stores operation metadata, never an entity's live state, so on
  this path nothing but the node answers them. The frontend's `/data` page queries entities through them. The
  experimental entity index below is the opt-in second opinion: the same methods, answered from PostgreSQL,
  on a path of their own.
- **The node's rejection is the answer.** `nonce too low`, `already known`, `insufficient funds` and their
  codes are relayed verbatim; that is the point of forwarding. Failures on our side of the wire (unreachable
  node, non-`200`, malformed reply) answer `-32000` with a fixed message and log the detail server-side,
  because the upstream URL can carry a key.
- **The list is a general escape hatch.** Anything on it is answered by the node whether or not the index
  could have answered it. Adding `eth_call` and `eth_estimateGas` makes the endpoint usable by a wallet;
  adding `eth_getTransactionCount` swaps the indexed nonce — which lags the chain by the scanner's lag — for
  the node's live one, which matters when a sender has transactions the scanner has not reached yet.
- **Forwarded calls are capped as a whole.** A public endpoint fronting a metered node is a way to spend
  someone else's quota, so the rate limit is on by default. It applies across all callers, not per IP.

Example:

```sh
curl -s http://localhost:3000/shadow-rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_feeHistory","params":["0x5","latest",[25,50,75]]}'
```

#### Experimental: entity reads from the index (`POST /shadow-rpc/experimental`)

Off by default. With `ENTITY_QUERY_INDEX=true` the backend folds the decoded Arkiv operations
(`transaction_operations`, so `SAVE_TRANSACTION_DATA=true` and a `DECODER_URL` are required) and the receipt
event logs (`transaction_logs`) into two tables of its own — `entity_versions`, one row per state an entity
went through with the block range it held for, and `entity_version_attributes`, that state's typed
attributes — and answers `arkiv_query`, `arkiv_getEntity`, `arkiv_getEntityCount` and `arkiv_getBlockTiming`
from them on a **separate path**, `POST /shadow-rpc/experimental` (`/api/shadow-rpc/experimental` publicly).
`/shadow-rpc` is untouched and keeps relaying those methods to the node, so the two paths are two independent
sources for the same questions, and either can be checked against the other. The path answers `404` when the
feature is off; `GET /health` reports it under `features.entityQueryIndex` as `false` or as
`{ path, methods, floorBlock, projectedThroughBlock, lagBlocks, liveEntities, lastFoldAtUtc }`.

The wire contract is the node's (`arkiv-reth-rpc` / `arkiv-rpc-types` in the 0.8 engine): the same parameter
shapes and defaults (`atBlock` hex or `latest`, `limit` 1–200 default 100, `select` with `attributes` as a
boolean or a per-name map), the same query grammar and limits (`*`, `= < <= > >= STARTSWITH`, `AND`/`OR`/`NOT`,
typed literals, `$owner $creator $key $expiresAt $createdAt $contentType`; 8 KiB, 64 predicates, depth 32),
the same error codes with the same messages and byte positions (`-32001` malformed, `-32002` type, `-32003`
literal, `-32004` limit, `-32005` cursor, `-32006` block unavailable), the same newest-first order, the same
encodings (`u64`/`createdAt`/`updatedAt`/`expiresAt` as hex, `i32` as a number, `dec` as a trimmed decimal
string, `u256` minimal hex, addresses/keys lowercase), attributes sorted by name, and the same fold semantics:
a patch merges (a tombstone unsets), every mutation bumps `updatedAt`, expiry is the receipt event's value
when logs are stored and the calldata's otherwise, a reverted transaction applies nothing, and an entity is
live at block `B` while `expiresAt > B` and it was not deleted — so a query evaluated `atBlock` a past block
sees exactly what was live then.

Where the index cannot honour something the node does, it says so rather than approximating:

| | Node | Index |
| --- | --- | --- |
| `latest` | The chain head. | The **projection head** (`projectedThroughBlock` in `/health`): the newest block folded, a few blocks behind the scanner head, itself behind the chain. `blockNumber` in every reply says which block answered. |
| History | Any block the node keeps state for. | Blocks between the **floor** and the projection head; anything else is `-32006` with `{ requested, latest }`. The floor is the first block whose stored creates carry entity keys (`floorBlock` in `/health`); entities created before it are unknown, so counts count what the index holds. A backfill that writes older blocks lowers the floor as it goes; `ENTITY_INDEX_FLOOR_BLOCK` pins it instead. |
| `select.payload` | The bytes. | Refused with `-32000`: payload bytes are never stored (the calldata invariant). `arkiv_getEntity` leaves `payload` out. |
| `creationFlags` | Always known. | `null` for entities created before receipt logs were stored (the flags travel in the `EntityCreated` event, not the calldata). |
| Cursors | Resume below an internal entity id. | Resume below a creation position. Both are opaque, bound to the query, block and `select`, and reject a cursor from another request with the node's own messages — but a cursor from one source cannot be handed to the other: the index answers a node's cursor with `-32005` and a message saying so. |
| `arkiv_getBlockTiming` | The node's clock. | The scanner head's block and its timestamp. |

The projection is kept up to date by an in-process projector: every few seconds it folds the operations of the
blocks the scanner has stored since its last pass (per entity key, replaying the key's whole history, so a
refold is idempotent), and once a minute it looks for operation rows written *below* its fold point — a gap
fill, a rescan, the backfill scanner — and refolds those keys too. A first build walks the whole stored
history in chunks and takes minutes for a few hundred thousand blocks. All writes run under an advisory lock,
so two backends on one database never fold on top of each other.

Two scripts turn the pair into a test rig. `scripts/compareEntityQuery.ts --node <url> --index <url>` walks
the same queries on both sides at the same block — discovering them from the data, plus any fixture manifest —
and reports every difference in order, fields, page boundaries, counts, `arkiv_getEntity` and the error
code/message/position of invalid requests, with `--bench` timing both. `scripts/seedEntityQueryFixtures.ts`
creates a suite of entities covering every attribute type, every mutation, expiry, flags and reverting
transactions, and writes the manifest the comparison reads. Point `--node` at the upstream RPC rather than
a public `/shadow-rpc`, whose forwarded-call cap would otherwise pace the run and skew its timings.

The frontend's `/data` page offers the index as a third RPC source ("Indexer entity index (experimental)",
`rpc=index` in shared links) when `/health` reports it enabled.

### `GET /metrics`

Prometheus text exposition for the backend process. Scrape it from the host on the loopback backend port
(`http://127.0.0.1:3000/metrics`); the bundled nginx site configs answer `404` for the public `/api/metrics`.
Set `METRICS_BEARER_TOKEN` to require `Authorization: Bearer <token>` when the port is reachable from further
away, or `METRICS_ENABLED=false` to remove the endpoint. Scrapes are never counted as traffic.

Every traffic metric is labelled by *route template* (`/transaction/:hash`, `/blocks/:number`, …) and never by
the raw path or query string; unknown paths land on `other`, and unknown JSON-RPC method names on `unknown`, so
series cardinality stays bounded whatever clients send.

| Metric | Type | Labels | What it tells you |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `route`, `method`, `status` | Request rate and error ratio per endpoint. |
| `http_request_duration_seconds` | histogram | `route`, `method` | Latency percentiles per endpoint. |
| `http_response_bytes_total` | counter | `route`, `encoding` | Egress per endpoint, split by wire encoding (`zstd`, `gzip`, `identity`). |
| `http_requests_in_flight` | gauge | `route` | Which endpoint is queueing right now. |
| `http_requests_rejected_total` | counter | `route`, `reason` | 4xx by reason (`bad_request`, `unauthorized`, `not_found`, …). |
| `jsonrpc_requests_total` | counter | `path`, `rpc_method`, `source`, `outcome` | Per-method call rate on `/shadow-rpc` and `/shadow-rpc/experimental`; `source` is `stored`, `upstream` (passthrough) or `override` (entity index). |
| `jsonrpc_request_duration_seconds` | histogram | `path`, `rpc_method` | Per-method latency. |
| `jsonrpc_batch_size` | histogram | `path` | Calls per JSON-RPC HTTP request. |
| `jsonrpc_get_logs_blocks_total`, `jsonrpc_get_logs_returned_total` | counter | — | How wide `eth_getLogs` queries are and how much they return. |
| `cache_requests_total` | counter | `cache`, `result` | Hit/miss/coalesced per cache (`entity_history`, `list`, `transaction_count`). |
| `cache_entries`, `cache_bytes` | gauge | `cache` | Current cache occupancy. |
| `cache_evictions_total` | counter | `cache`, `reason` | Drops by `invalidation` (NOTIFY), `ttl`, or `capacity`. |
| `db_query_duration_seconds` | histogram | `route` | Postgres time attributed to the route that issued the query. |
| `db_queries_total` | counter | `route`, `outcome` | Query rate and failures per route. |
| `db_queries_in_flight` | gauge | — | Queries awaiting a result. |
| `indexer_head_block`, `chain_head_block`, `indexer_lag_blocks`, `indexer_head_age_seconds` | gauge | — | How far the index trails the chain. |
| `process_start_time_seconds`, `process_resident_memory_bytes`, `process_heap_used_bytes` | gauge | — | Process basics. |
| `build_info` | gauge | `commit`, `built_at` | Always `1`; identifies the running build. |

A scrape config and starter queries are in [`docs/prometheus.md`](docs/prometheus.md).

### Server configuration

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--database-url` | `DATABASE_URL` | required | PostgreSQL connection string. |
| `--port` | `SERVER_PORT` | `3000` | TCP port to listen on. Use `0` to pick any free port. |
| `--host` | `SERVER_HOSTNAME` | Bun default | Interface/hostname to bind. |
| `--entity-query-index` | `ENTITY_QUERY_INDEX` | `false` | Build the experimental entity index and serve `POST /shadow-rpc/experimental`. |
| `--metrics-enabled` | `METRICS_ENABLED` | `true` | Serve Prometheus metrics on `GET /metrics`. |
| `--metrics-bearer-token` | `METRICS_BEARER_TOKEN` | unset | Require `Authorization: Bearer <token>` on `GET /metrics`. |
| `--entity-index-floor-block` | `ENTITY_INDEX_FLOOR_BLOCK` | detected | Pin the index floor instead of detecting the first keyed create. |

```sh
bun run serve -- --help
```

## Frontend

A Vite + React + TypeScript app lives in `frontend/`. It is served in production by `frontend/server.js`, a tiny
dependency-free Node HTTP server that:

1. Serves the Vite build output (`frontend/dist/`) as static files on port `23560`.
2. Reverse-proxies any request whose path starts with `/api/` to the `backend` service (stripping the `/api`
   prefix). For example a browser request to `/api/blocks?blockGt=1` is forwarded to `http://backend:3000/blocks?blockGt=1`.
3. Falls back to `index.html` for any other unknown path (SPA routing).

The frontend production build also writes `.br` siblings for the files in `frontend/dist/`. The Node static server
serves those Brotli files only when `NODE_ENV=production` and the browser sends `Accept-Encoding: br`; development
and other non-production runs always serve the original files. The Docker frontend image sets `NODE_ENV=production`
for its runtime stage.

Four views are provided when transaction data is enabled; otherwise the Transactions view and inspection links
are hidden:

- **Blocks** — paged table of stored blocks with `blockGt`, `blockLt`, `dateGt`, `dateLt` filters.
- **Transactions** — stored transaction query table for exact block, block range, and date range inspection.
- **Ranges** — table of aggregated windows with a `rangeSize` selector plus the same date / start filters.
- **Charts** — interactive historical chart view with links from selected block points into Transactions.
- **Data** (`/data`) — live entity state read from an Arkiv node rather than from the index. A CodeMirror
  editor (loaded as its own chunk only on this page) takes an Arkiv 0.8 query with highlighting and
  completions; a pasted bare entity key or address is rewritten to `$key = key(..)` / `$owner = addr(..)`.
  Ctrl+Enter or **Run query** sends `arkiv_query` with every projection except the payload (payloads on this
  network run to ~100 KB each), and the run is recorded in the URL as `/data?q=...&pageSize=...&expiration=...`
  so it can be shared and reached by back/forward. Results are cards: key linked to its indexed history,
  owner/creator, content type, creation flags, created/updated/expires blocks with dates estimated from
  `arkiv_getBlockTiming`, a lifetime bar, and one chip per attribute; chips and the funnel buttons open a
  menu to query by that value only, add it to the current query, or copy it. "Load next page" resumes the
  node's cursor at the block the first page was read at; "Expiring within 24h" filters the loaded cards
  client-side. Syntax errors show the node's message with a caret at the reported position. Below the results
  is a collapsed RPC endpoint switch: the **indexer backend** (`/api/shadow-rpc`, which forwards `arkiv_query`,
  `arkiv_getEntityCount` and `arkiv_getBlockTiming` to the node it is configured with, using the deployment's
  key) or a **custom RPC URL** called straight from the browser. The choice is kept in browser local storage.
  "Check connection" runs `eth_chainId`, `web3_clientVersion` and the three Arkiv reads against the selected
  endpoint and reports each call's verdict, latency and result, plus the node's head block, block time, live
  entity count and a sample entity key linked to its indexed history. The page also reads `/api/health` to warn
  when the backend's `SHADOW_RPC_UPSTREAM_METHODS` does not cover the entity reads.

Every page carries a **scanner sync banner** above the content whenever the indexer trails the chain head. It
polls `GET /sync` every 10 seconds and states how far behind the scanner is (in blocks and in chain time),
whether the gap is closing, at what multiple of chain speed it is scanning, and the estimated time to be in
sync. "Details" expands the full measurement — last stored block, estimated and last observed chain head, scan
and chain rates, gap trend, and the sample window. The Health view shows the same information as a permanent
panel. The banner stays hidden while the scanner is at the head, and only appears once the lag exceeds
`VITE_SCANNER_DELAY_WARNING_AGE_MS` of chain time.

### Frontend configuration

The frontend container reads these env vars:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `23560` | TCP port the frontend HTTP server listens on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `BACKEND_HOST` | `backend` | Hostname (compose service name) of the backend. |
| `BACKEND_PORT` | `3000` | Backend TCP port. |
| `VITE_CHAIN_NAME` | `Arkiv` | Chain name shown in the frontend header and home copy. |
| `VITE_NETWORK_NAME` | _(empty)_ | Network name (e.g. `Cheesecake`) shown as a badge next to the header brand and in the page title; blank hides it. |
| `VITE_TOKEN_SYMBOL` | `ETH` | Three-letter token symbol used in frontend native-token labels. |
| `VITE_TRANSACTION_DECODER_BASE_URL` | `https://decoder.atlas.arkiv-global.net/` | Base URL used for external transaction decoder permalinks (`/?tx=<hash>`). |
| `VITE_TRANSACTION_EXPLORER_BASE_URL` | unset | Deprecated fallback for `VITE_TRANSACTION_DECODER_BASE_URL`. |
| `VITE_NO_BATCHER` | `false` | Set to `true` for networks without batcher metrics; hides batcher panels, fields, and chart options. |

### Developing the frontend locally

```sh
cd frontend
npm install
npm run dev   # vite dev server on http://localhost:5173, proxies /api -> http://localhost:3000
```

Or build + run the production server locally:

```sh
cd frontend
npm install
npm run build
NODE_ENV=production BACKEND_HOST=localhost BACKEND_PORT=3000 PORT=23560 node server.js
```

## Tests

Run unit tests:

```sh
bun test
```

Pure-logic tests run without any external services. The storage / aggregator / server integration tests skip
themselves unless you provide a real PostgreSQL instance via `TEST_DATABASE_URL`:

```sh
TEST_DATABASE_URL=postgres://gas:gas@localhost:5432/gas bun test
```

Each integration test runs against its own randomly-named schema and drops it on cleanup, so tests can share a
database without interfering with each other.

Run a short manual smoke scan against the public endpoint. The scanner runs continuously near the safe head, so
stop it with Ctrl-C once a few blocks have been stored:

```sh
docker compose up -d postgres
DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \
  bun run scan
```

Inspect stored rows:

```sh
docker compose exec postgres psql -U gas -d gas -c 'select * from blocks limit 1;'
docker compose exec postgres psql -U gas -d gas -c 'select * from scanner_state;'
```
