# gas-price-tracker

A Bun + TypeScript Ethereum block scanner that stores gas and priority-fee metrics per block in **PostgreSQL**.

The scanner reads blocks sequentially, fetches every transaction receipt in each block, stores one completed
block at a time, and resumes from the last successfully stored block after restart or failure. Failed block reads
are retried and never skipped.

A standalone aggregator computes fixed-size window aggregates (2 / 5 / 10 / 20 / 50 / 100 / 200 / 500 / 1000
blocks). The HTTP backend serves both per-block rows and aggregated ranges, and a small static frontend lets you
browse them in a browser.

## Quick start with Docker Compose

The supplied compose stack spins up Postgres, the scanner, the aggregator loop, the backend, and the static
frontend.

```sh
cp .env.example .env
# edit .env and set SCANNER_RPC_FULL_NODE to your JSON-RPC endpoint
docker compose up --build
```

Open:

- Frontend: <http://localhost:23560> (the React app talks to the backend through the same origin at `/api/*`)
- Backend API (direct): <http://localhost:3000/blocks> and <http://localhost:3000/ranges>
- Postgres: `postgres://gas:gas@localhost:5432/gas`

The frontend container is a tiny Node `server.js` that serves the Vite-built React app from `dist/` and reverse-proxies any request starting with `/api/` to the `backend` service (the `/api` prefix is stripped). This means you don't need to expose the backend publicly — only port `23560` on the host is required for end users.

The aggregator container runs `bun run aggregate-all` which walks every supported range size and sleeps for one
minute between sweeps (configurable via `AGGREGATE_INTERVAL_MS`).

To do a quick bounded backfill instead of continuous near-head scanning, set `SCANNER_FROM_BLOCK` and
`SCANNER_TO_BLOCK` in `.env`.

## Running locally without Docker

Requirements:

- [Bun](https://bun.sh/) 1.3 or newer
- A PostgreSQL 13+ instance reachable via `DATABASE_URL`
- An Ethereum JSON-RPC full-node endpoint

```sh
bun install
export DATABASE_URL=postgres://gas:gas@localhost:5432/gas
export SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/
bun run scan
```

In continuous mode the scanner stays near the top of the chain by scanning from the current safe head, spends 20
seconds backfilling older blocks, and then scans forward again through the latest safe head. The oldest block it
will backfill to defaults to `25000000`.

For a bounded historical scan, pass both `--from-block` and `--to-block`:

```sh
bun run scan -- --from-block 19000000 --to-block 19000002
```

After each block is scanned and stored, the scanner prints a per-block summary:

```txt
Block 19000000 scanned and stored
  Date: 2024-01-14T08:56:23.000Z
  Duration: 1.27s
  Transactions: 144
  Gas used: 29999.781 kGas / 30000 kGas
  Base fee: 11.143964487 Gwei
  Avg priority fee: 1.275 Gwei
  Weighted avg priority fee: 1.418 Gwei
  Avg transaction fee: 314727.209 Gwei
  RPC: 145 calls, 12.64 KiB sent, 3.41 MiB received (3.42 MiB total)
```

## Configuration

Configuration can be passed through CLI flags or environment variables.

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--database-url` | `DATABASE_URL` | **required** | PostgreSQL connection string. |
| `--from-block` | `SCANNER_FROM_BLOCK` | unset | First block for bounded `--to-block` scans. |
| `--to-block` | `SCANNER_TO_BLOCK` | unset | Optional inclusive block number to stop at. |
| `--oldest-backfill-block` | `SCANNER_OLDEST_BACKFILL_BLOCK` | `25000000` | Oldest block the continuous scanner will backfill to. |
| `--confirmation-depth` | `SCANNER_CONFIRMATION_DEPTH` | `3` | Number of blocks to stay behind the latest head. |
| `--poll-ms` | `SCANNER_POLL_MS` | `12000` | Delay while waiting for new safe blocks. |
| `--retry-ms` | `SCANNER_RETRY_MS` | `5000` | Delay before retrying the same failed block. |
| `--tx-receipt-concurrency` | `SCANNER_TX_RECEIPT_CONCURRENCY` | `20` | Max receipt RPC calls in flight per block. |
| n/a | `SCANNER_RPC_FULL_NODE` | **required** | Ethereum JSON-RPC endpoint. |

Show help:

```sh
bun run scan -- --help
```

## Stored Metrics

Rows are stored in the `blocks` table. Large integer values are stored as decimal strings so wei values do not
lose precision.

| Column | Meaning |
| --- | --- |
| `block_date` | Block timestamp as an ISO-8601 UTC string. |
| `block_number` | Ethereum block number (PostgreSQL `BIGINT`). |
| `base_block_fee_wei` | Block `baseFeePerGas` in wei. Legacy networks without a base fee store `0`. |
| `total_gas_used` | Block `gasUsed`. |
| `max_gas_in_block` | Block `gasLimit`; this is the maximum possible gas for that block and can vary by network. |
| `transaction_count` | Number of transactions in the block. |
| `total_transaction_fee_wei` | Sum of actual transaction fees: `sum(receipt.gasUsed * effectiveGasPrice)`. |
| `priority_fee_weighted_numerator_wei` | Exact numerator for the weighted priority-fee calculation: `sum(priorityFee * transactionFee)`. |
| `average_transaction_fee_wei` | Average actual transaction fee, computed as `gasUsed * effectiveGasPrice` per transaction. |
| `average_priority_fee_weighted_wei` | Average priority fee weighted by actual transaction fee size. |
| `average_priority_fee_wei` | Simple average priority fee across transactions. |

Priority fee is computed as:

```txt
max(effectiveGasPrice - baseFeePerGas, 0)
```

The weighted priority fee is computed as:

```txt
sum(priorityFee * transactionFee) / sum(transactionFee)
```

For empty blocks all averages are stored as `0`.

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

Each aggregator run walks every aligned window from `floor(min_stored_block / M) * M` up through the highest
stored block, and writes a row only for windows where all `M` blocks are present in `blocks`. Incomplete windows
are skipped (and can be re-aggregated later once the missing blocks are scanned).

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
| `transaction_count` | Sum of `transaction_count` across the window. |
| `average_priority_fee_weighted_wei` | `sum(block.priority_fee_weighted_numerator_wei) / sum(block.total_transaction_fee_wei)`. Legacy block rows without those exact fields fall back to `sum(block.average_priority_fee_weighted_wei * block.average_transaction_fee_wei * block.transaction_count) / sum(block.average_transaction_fee_wei * block.transaction_count)`. |
| `average_priority_fee_wei` | `sum(block.average_priority_fee_wei * block.transaction_count) / sum(block.transaction_count)`. |

When `total_transaction_fee_wei` or `transaction_count` for the window is `0` the corresponding weighted average
is stored as `0`.

#### Aggregator options

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--range` | `AGGREGATE_RANGE` | required (single-range) | Window size. One of: 2, 5, 10, 20, 50, 100, 200, 500, 1000. |
| `--database-url` | `DATABASE_URL` | required | PostgreSQL connection string. |
| `--from-block` | `AGGREGATE_FROM_BLOCK` | unset | Optional lower bound on the windows to consider. |
| `--to-block` | `AGGREGATE_TO_BLOCK` | unset | Optional upper bound on the windows to consider. |
| `--interval-ms` | `AGGREGATE_INTERVAL_MS` | `60000` | (aggregate-all) sleep between full sweeps. |
| `--once` | n/a | unset | (aggregate-all) run one sweep then exit. |

## Resume Behavior

Forward progress is stored in the `scanner_state` table as `last_successful_block`. Continuous backfill progress
is stored separately as `backfill_next_block`.

For bounded scans:

1. If progress exists, scanning resumes from `last_successful_block + 1`.
2. If no progress exists, scanning starts from `--from-block`.
3. A block and the progress update are committed in the same PostgreSQL transaction.
4. If reading, computing, or writing a block fails, progress is not advanced.
5. The scanner retries the same block after `--retry-ms`.

For continuous scans:

1. The backfill cursor starts at the current safe head when no prior cursor exists.
2. The scanner walks backward for 20 seconds of work, updating `backfill_next_block` only with the block row.
3. It then scans forward through the latest safe head, updating `last_successful_block` only with the block row.
4. The backward cursor stops at `--oldest-backfill-block`.

This means failed block reads are not skipped.

## HTTP Server

A read-only HTTP server is included that serves stored block rows from the same PostgreSQL database. Run it
alongside the scanner (or against an existing database):

```sh
DATABASE_URL=postgres://gas:gas@localhost:5432/gas bun run serve
# or
bun run serve -- --database-url postgres://gas:gas@localhost:5432/gas --port 3000
```

By default the server listens on port `3000`. CORS headers are set on every response so the static frontend can
fetch from a different origin.

### `GET /blocks`

Returns stored block rows ordered by `block_number` ascending. The response is always capped at **10,000
rows** (smallest matching blocks first). All four filters below are optional and combine additively (AND).
With no filters the smallest 10,000 stored blocks are returned.

| Query parameter | Description |
| --- | --- |
| `blockGt` | Only blocks with `block_number > blockGt`. |
| `blockLt` | Only blocks with `block_number < blockLt`. |
| `dateGt` | ISO-8601 timestamp; only blocks newer than this. |
| `dateLt` | ISO-8601 timestamp; only blocks older than this. |

Example:

```sh
curl 'http://localhost:3000/blocks?blockGt=19000000&blockLt=19000005'
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

### Server configuration

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--database-url` | `DATABASE_URL` | required | PostgreSQL connection string. |
| `--port` | `SERVER_PORT` | `3000` | TCP port to listen on. Use `0` to pick any free port. |
| `--host` | `SERVER_HOSTNAME` | Bun default | Interface/hostname to bind. |

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

Two views are provided:

- **Blocks** — paged table of stored blocks with `blockGt`, `blockLt`, `dateGt`, `dateLt` filters.
- **Ranges** — table of aggregated windows with a `rangeSize` selector plus the same date / start filters.

### Frontend configuration

The frontend container reads these env vars:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `23560` | TCP port the frontend HTTP server listens on. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `BACKEND_HOST` | `backend` | Hostname (compose service name) of the backend. |
| `BACKEND_PORT` | `3000` | Backend TCP port. |

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
BACKEND_HOST=localhost BACKEND_PORT=3000 PORT=23560 node server.js
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

Run a short manual smoke scan against the public endpoint:

```sh
docker compose up -d postgres
DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \
  bun run scan -- --from-block 19000000 --to-block 19000000
```

Inspect stored rows:

```sh
docker compose exec postgres psql -U gas -d gas -c 'select * from blocks limit 1;'
docker compose exec postgres psql -U gas -d gas -c 'select * from scanner_state;'
```
