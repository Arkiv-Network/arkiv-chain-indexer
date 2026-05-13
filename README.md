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
