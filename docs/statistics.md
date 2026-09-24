# Indexer statistics

The public **Statistics** page (`/statistics`) reads `GET /api/statistics`
(`GET /statistics` on the backend). A separate `collect-statistics` process
calculates the totals. HTTP requests never run the aggregation queries.

The worker uses the existing tables, opens a single read-only, repeatable-read
PostgreSQL transaction per sweep, and atomically replaces a JSON file. It creates
no tables, columns, indexes, materialized views or state rows. It does not call
the node, decode transactions, or persist payload bytes. Each result carries its
collection time, duration, observed chain head and entity projection block.

## Running

Docker Compose starts the `statistics` service with the normal stack. Its
`statisticsdata` volume is writable by the worker and mounted read-only by the
backend. Both use `/app/statistics/snapshot.json` inside their containers.

For local processes, use the same path and database for the worker and backend:

```sh
DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  STATISTICS_FILE=/tmp/arkiv-indexer-statistics.json bun run collect-statistics

DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  STATISTICS_FILE=/tmp/arkiv-indexer-statistics.json bun run serve

# One sweep, also printed as JSON. Failure exits nonzero.
DATABASE_URL=postgres://gas:gas@localhost:5432/gas \
  bun run collect-statistics -- --once
```

Initialize the ordinary scanner tables before the first sweep. A worker started
earlier retries until they exist. Entity projection tables are optional; without
them, entity-state statistics are `null`, not zero. A genesis import in progress
also suppresses those totals until it finishes.

| Setting | Default | Meaning |
| --- | --- | --- |
| `STATISTICS_FILE` | `/tmp/arkiv-indexer-statistics.json` locally | Worker output/backend input; use a distinct file per chain/deployment. Compose sets a fixed path on its per-project volume. |
| `STATISTICS_INTERVAL_MS` | `300000` | Pause after each sweep. Expensive sweeps wait at least four times their duration before retrying. |
| `STATISTICS_STATEMENT_TIMEOUT_MS` | `120000` | Maximum duration of an individual aggregation query. |

The worker has one connection and runs its queries sequentially. The existing
block, transaction and operation scans each group history into disjoint time
bands once; the worker folds those small aggregates into nested periods with
`bigint`. Nine periods do not cause nine full-history scans. Full counts still
scan the stored history, so increase the interval on large deployments.
No sweep overlaps the next. A failed sweep leaves the last successful file
intact; the API marks an old snapshot `stale`. Before the first snapshot, it
returns HTTP 503 with `Retry-After: 30`. Snapshots survive worker/backend restarts
when their volume survives. There is no historical statistics time series.

## Activity periods and API compatibility

The **Activity period** selector offers exactly **1 hour, 2 hours, 6 hours,
12 hours, 24 hours, 48 hours, 72 hours, 7 days, and All time**. All time is the
default; the browser remembers your choice. Selection changes indexed activity,
entity operation attempts and transaction input/payload write totals using the
already loaded snapshot. It does not trigger a sweep or database query.

`GET /api/statistics` still takes no query parameters. Snapshot `version: 1`
and all existing top-level fields retain their previous meanings: `blocks`,
`transactions` and `operations` cover **all stored history**, `chain` describes
overall coverage, and `entities` describes the current projected state. This
keeps existing consumers, including Hub, compatible.

New snapshots add `windows` with keys `1h`, `2h`, `6h`, `12h`, `24h`, `48h`,
`72h`, `7d` and `all`. Each value contains:

- `fromInclusiveUtc` and `toExclusiveUtc`: ISO UTC timestamps for finite windows;
  both are `null` for `all`, which includes every stored row in the snapshot.
- `blocks`: `indexed`, `transactions`, `inputBytes` and `compressedInputBytes`.
- `transactions`: the same fields as the top-level transaction totals.
- `operations`: the same fields as the top-level operation totals, including
  success/revert/unknown counts by type and successful payload/reference sizes.

All finite periods share the exact `gatheredAtUtc` cutoff, taken from the
PostgreSQL transaction start and truncated to milliseconds to match JSON time
precision. A row contributes when **start ≤ block timestamp < cutoff**. The
7-day period is exactly 168 hours, independent of time zones or daylight saving
time. Activity uses each table's stored `block_date`, not `scanned_at`; a
backfilled old block contributes according to its original block time.
Operation timestamps come from `transaction_operations.block_date`, so an
operation lacking a transaction row still contributes to the unknown outcome
count. Rows at/after the cutoff do not enter finite periods, but remain in
all-time totals. Boundaries are reported in the page's selected display time zone.

Finite periods are nested, with exact decimal-string counts and byte totals.
No matching stored rows means **zero stored activity**, not unavailable data or
proof that the period was completely scanned. Existing coverage limits still
apply separately to blocks, transaction details and decoded operations.

**Current entity state, active payload state, attributes and content types do
not change with the activity period.** They retain their explicitly reported
projection block. There is no historical gauge filtering, subtraction or
attempt to infer entity-state deltas from operations. Unavailable projected
state remains `null`, rather than a fabricated zero.

Older files without `windows` remain readable by the API. The page shows their
original all-time totals, disables the finite options and explains that period
results are unavailable until an updated worker publishes a snapshot. Missing
window data is never displayed as zero.

## Definitions and available data

Counts and byte totals are decimal strings in JSON, preserving integer precision.
Only the percentage, durations, type IDs and timestamps use other representations.
The page's **Byte units** selector offers exact bytes, automatic decimal units
(kB/MB/GB/TB, base 1000; the default), and automatic binary units
(KiB/MiB/GiB/TiB, base 1024). It also applies to mean input sizes and content-type
payload totals, and remembers the selection in the browser.

Every section, metric label and table header has an info icon explaining its
meaning, database source, calculation, inclusion conditions and limitations.
Hover or focus an icon to preview the explanation; click or tap to keep it open
while reading or scrolling. With the icon focused, Down Arrow moves focus into
the scrollable explanation. Escape dismisses it. The descriptions live in
`frontend/src/statisticsHelp.ts` and should be updated whenever the worker's
queries or the scanner's measurements change.

| Statistic | Definition |
| --- | --- |
| Chain scanned | Actual stored block rows at or below `observed head - 10` / (`head + 1 - 10`) × 100. Excludes the newest 10 blocks from both counts to allow normal tip lag. Includes genesis and still accounts for older gaps. Null until the observed chain has more than 10 blocks. `coverageThroughBlock`, `coverageBlocks` and `indexedCoverageBlocks` expose the cutoff and counts; the separate observed-head totals still include the tip. |
| Indexed blocks | All rows in `blocks`, with first/last height and missing blocks inside that span. |
| Transactions in block metrics | Sum of `blocks.transaction_count`; available even when transaction-row storage is disabled. Excludes transactions the scanner intentionally ignores. |
| Indexed transactions | Rows in `transactions`. Can differ from the block-metric total if storage was disabled for some history. |
| Created/updated/extended/deleted/owner changes | Decoded operations grouped by operation type and transaction receipt outcome. Status `1` is successful, `0` reverted; null/other/missing transaction status is reported separately. Multiple changes to one entity count separately. The page omits the expiry-operation row; API totals retain it. |
| Known entities | Distinct projected entity states at the projection head, including active, expired and deleted entities, and imported genesis entities. Excludes unknown entities whose creates were never indexed. |
| Active entities | Projected state with `deleted = false` and `expires_at > projection head`. Expiry is recalculated on every sweep, even without new operations. |
| Input byte totals | Stored uncompressed and compressed calldata sizes, separately from block metrics and transaction rows. Transaction input count, mean and maximum are also shown. |
| Operation payload bytes | Sum of decoder-recorded sizes across successful operations, including repeated writes. Reference receipts are not necessarily the referenced entity bytes. |
| Referenced payload bytes | Sum of reference metadata `sizeBytes` across successful reference operations. Repeated references count repeatedly. References without a usable size have a separate count. |
| Active payload metadata | Total and maximum recorded payload size, number of active entities with a nonzero size, and the top 20 content types by active entity count. |
| Active attributes | Total, mean/max per active entity, number of active entities with attributes, and counts by attribute type. Old versions and expired/deleted entities are excluded. |

## What the current database cannot establish

- **Full signed/raw transaction byte sizes.** Only input/calldata byte lengths
  are recorded. Signatures and complete serialized transaction envelopes are
  absent; obtaining these sizes requires a node rescan and recording additional
  size metadata.
- **Exact active entities on the live chain at collection time** when the scanner
  or entity projection is behind. The page labels the projection block and lag.
  Unimported genesis entities, missing keyed creates and pending historical
  refolds can leave state incomplete. Pre-log expiry values may be inferred by
  the existing projection rather than confirmed from events.
- **Chain-wide totals for history that was never stored/decoded.** Coverage is
  reported rather than extrapolated. Older size columns defaulted to zero; those
  historical zeros cannot be distinguished from measured zero without rescanning.
- **Payload contents or verified unique provider storage.** The index deliberately
  stores no payload bytes. Declared reference sizes are not a measurement of
  provider availability or deduplicated storage. The projection's recorded size
  is not guaranteed to resolve the current referenced payload's size.
- **Exact protocol-encoded attribute storage bytes.** Attribute counts, types and
  values are stored, but their original wire/storage representation is not. JSON
  text length or PostgreSQL row size would measure a different thing.

For a first overview, attribute counts/types and payload sizes/content types are
useful because they describe entity shape and data volume without reading or
storing payload contents.
