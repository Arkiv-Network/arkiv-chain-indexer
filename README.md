# gas-price-tracker

A Bun + TypeScript Ethereum block scanner that stores gas and priority-fee metrics per block in SQLite.

The scanner reads blocks sequentially, fetches every transaction receipt in each block, stores one completed
block at a time, and resumes from the last successfully stored block after restart or failure. Failed block reads
are retried and never skipped.

## Requirements

- [Bun](https://bun.sh/)
- An Ethereum JSON-RPC full node endpoint

Install dependencies:

```sh
bun install
```

## Quick Start

```sh
SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \
  bun run scan
```

By default the scanner writes to `scanner.sqlite` in the current directory. In continuous mode it stays near the
top of the chain by scanning from the current safe head, spends 20 seconds backfilling older blocks, and then
scans forward again through the latest safe head. The oldest block it will backfill to defaults to `25000000`.

For a bounded historical scan, pass both `--from-block` and `--to-block`:

```sh
SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \
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

RPC call and byte counts are measured from the JSON-RPC requests made during that block scan: the block fetch and
the sequential transaction receipt fetches. Scanner head polling is outside this per-block summary.

## Configuration

Configuration can be passed through CLI flags or environment variables.

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--from-block` | `SCANNER_FROM_BLOCK` | unset | First block for bounded `--to-block` scans. |
| `--to-block` | `SCANNER_TO_BLOCK` | unset | Optional inclusive block number to stop at. |
| `--oldest-backfill-block` | `SCANNER_OLDEST_BACKFILL_BLOCK` | `25000000` | Oldest block the continuous scanner will backfill to. |
| `--db` | `SCANNER_DB_PATH` | `scanner.sqlite` | SQLite database path. |
| `--confirmation-depth` | `SCANNER_CONFIRMATION_DEPTH` | `3` | Number of blocks to stay behind the latest head. |
| `--poll-ms` | `SCANNER_POLL_MS` | `12000` | Delay while waiting for new safe blocks. |
| `--retry-ms` | `SCANNER_RETRY_MS` | `5000` | Delay before retrying the same failed block. |
| n/a | `SCANNER_RPC_FULL_NODE` | required | Ethereum JSON-RPC endpoint. |

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
| `block_number` | Ethereum block number. |
| `base_block_fee_wei` | Block `baseFeePerGas` in wei. Legacy networks without a base fee store `0`. |
| `total_gas_used` | Block `gasUsed`. |
| `max_gas_in_block` | Block `gasLimit`; this is the maximum possible gas for that block and can vary by network. |
| `transaction_count` | Number of transactions in the block. |
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

Aggregation runs as a separate command — the scanner no longer aggregates inline:

```sh
bun run aggregate -- --range 50
```

The aggregator walks every aligned window from `floor(min_stored_block / M) * M` up through the highest
stored block, and writes a row only for windows where all `M` blocks are present in `blocks`. Incomplete
windows are skipped (and can be re-aggregated later once the missing blocks are scanned).

You can run the aggregator multiple times with different `--range` values; each size lives independently
in `block_ranges` keyed by `(range_size, range_start)`.

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
| `average_priority_fee_weighted_wei` | `sum(block.average_priority_fee_weighted_wei * block.total_gas_used) / sum(block.total_gas_used)`. |
| `average_priority_fee_wei` | `sum(block.average_priority_fee_wei * block.transaction_count) / sum(block.transaction_count)`. |

When `total_gas_used` or `transaction_count` for the window is `0` the corresponding weighted average
is stored as `0`.

#### Aggregator options

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--range` | `AGGREGATE_RANGE` | required | Window size. One of: 2, 5, 10, 20, 50, 100, 200, 500, 1000. |
| `--db` | `SCANNER_DB_PATH` | `scanner.sqlite` | SQLite database path. Shared with the scanner. |
| `--from-block` | `AGGREGATE_FROM_BLOCK` | unset | Optional lower bound on the windows to consider. |
| `--to-block` | `AGGREGATE_TO_BLOCK` | unset | Optional upper bound on the windows to consider. |

## Resume Behavior

Forward progress is stored in the `scanner_state` table as `last_successful_block`. Continuous backfill progress
is stored separately as `backfill_next_block`.

For bounded scans:

1. If progress exists, scanning resumes from `last_successful_block + 1`.
2. If no progress exists, scanning starts from `--from-block`.
3. A block and the progress update are committed in the same SQLite transaction.
4. If reading, computing, or writing a block fails, progress is not advanced.
5. The scanner retries the same block after `--retry-ms`.

For continuous scans:

1. The backfill cursor starts at the current safe head when no prior cursor exists.
2. The scanner walks backward for 20 seconds of work, updating `backfill_next_block` only with the block row.
3. It then scans forward through the latest safe head, updating `last_successful_block` only with the block row.
4. The backward cursor stops at `--oldest-backfill-block`.

This means failed block reads are not skipped.

## HTTP Server

A read-only HTTP server is included that serves stored block rows from the same SQLite database. Run it
alongside the scanner (or against an existing database):

```sh
SCANNER_DB_PATH=./scanner.sqlite bun run serve
# or
bun run serve -- --db ./scanner.sqlite --port 3000
```

By default the server listens on port `3000` and reads from `scanner.sqlite`.

### `GET /blocks`

Returns stored block rows ordered by `block_number` ascending. The response is always capped at **10,000
rows** (smallest matching blocks first). All four filters below are optional and combine additively (AND).
With no filters the smallest 10,000 stored blocks are returned.

| Query parameter | Description | SQL applied |
| --- | --- | --- |
| `blockGt` | Only blocks with `block_number > blockGt` | `block_number > ?` |
| `blockLt` | Only blocks with `block_number < blockLt` | `block_number < ?` |
| `dateGt` | ISO-8601 timestamp; only blocks newer than this | `block_date > ?` |
| `dateLt` | ISO-8601 timestamp; only blocks older than this | `block_date < ?` |

Example:

```sh
curl 'http://localhost:3000/blocks?blockGt=19000000&blockLt=19000005'
```

Response shape:

```json
{
  "count": 4,
  "limit": 10000,
  "truncated": false,
  "filters": {
    "blockGt": "19000000",
    "blockLt": "19000005",
    "dateGt": null,
    "dateLt": null
  },
  "blocks": [
    {
      "blockNumber": 19000001,
      "blockDate": "2024-01-14T08:56:35.000Z",
      "baseBlockFeeWei": "...",
      "totalGasUsed": "...",
      "maxGasInBlock": "...",
      "transactionCount": 144,
      "averageTransactionFeeWei": "...",
      "averagePriorityFeeWeightedWei": "...",
      "averagePriorityFeeWei": "..."
    }
  ]
}
```

`truncated` is `true` when the 10,000-row cap was hit and the matching range may contain more rows.

Validation errors (invalid integers, invalid dates) return `400` with `{ "error": "..." }`. Unknown paths
return `404`; non-`GET` requests return `405`.

### `GET /ranges`

Returns aggregated fixed-size windows ordered by `range_start` ascending. Each request targets a single
range size via the `rangeSize` query parameter (defaults to `100`). Each window covers
`[k * rangeSize, k * rangeSize + rangeSize - 1]` and is written only after all blocks in that window
have been stored and the aggregator has run for that size. Responses are capped at **10,000 ranges**
(smallest matching `range_start` first). If no aggregates exist for the requested `rangeSize`, the
response is `{ "count": 0, "ranges": [] }`.

| Query parameter | Description | SQL applied |
| --- | --- | --- |
| `rangeSize` | Window size. One of: 2, 5, 10, 20, 50, 100, 200, 500, 1000. Defaults to `100`. | `range_size = ?` |
| `rangeStartGt` | Only ranges with `range_start > rangeStartGt` | `range_start > ?` |
| `rangeStartLt` | Only ranges with `range_start < rangeStartLt` | `range_start < ?` |
| `dateGt` | ISO-8601 timestamp; only ranges whose `max_block_date` is newer than this | `max_block_date > ?` |
| `dateLt` | ISO-8601 timestamp; only ranges whose `min_block_date` is older than this | `min_block_date < ?` |

Example:

```sh
curl 'http://localhost:3000/ranges?rangeSize=50&rangeStartGt=245500&rangeStartLt=245700'
```

Response shape:

```json
{
  "count": 2,
  "limit": 10000,
  "truncated": false,
  "filters": {
    "rangeSize": "50",
    "rangeStartGt": "245500",
    "rangeStartLt": "245700",
    "dateGt": null,
    "dateLt": null
  },
  "ranges": [
    {
      "rangeSize": 50,
      "rangeStart": 245550,
      "rangeEnd": 245599,
      "minBlockDate": "...",
      "maxBlockDate": "...",
      "minBaseFeeWei": "...",
      "maxBaseFeeWei": "...",
      "averageBaseFeeWei": "...",
      "totalGasUsed": "...",
      "totalMaxGas": "...",
      "transactionCount": 12345,
      "averagePriorityFeeWeightedWei": "...",
      "averagePriorityFeeWei": "..."
    }
  ]
}
```

`averagePriorityFeeWeightedWei` is weighted by per-block `total_gas_used`. `averagePriorityFeeWei` is
weighted by per-block `transaction_count`. `averageBaseFeeWei` is the unweighted mean of the window's
block base fees (integer wei division).

### Server configuration

| CLI flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--db` | `SCANNER_DB_PATH` | `scanner.sqlite` | SQLite database path. Shared with the scanner. |
| `--port` | `SERVER_PORT` | `3000` | TCP port to listen on. Use `0` to pick any free port. |
| `--host` | `SERVER_HOSTNAME` | Bun default | Interface/hostname to bind. |

```sh
bun run serve -- --help
```

## Tests

Run unit tests:

```sh
bun test
```

Run a short manual smoke scan against the public endpoint:

```sh
rm -f scanner.sqlite
SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \
  bun run scan -- --from-block 19000000 --to-block 19000000
```

Inspect stored rows:

```sh
sqlite3 scanner.sqlite 'select * from blocks limit 1;'
sqlite3 scanner.sqlite 'select * from scanner_state;'
```
