# AGENTS.md

## Project Overview

This repository contains a Bun + TypeScript Ethereum block scanner. It stores one row per block in SQLite and
tracks scanner progress so restarts continue from the last successfully stored block.

## Commands

```sh
bun install
bun test
SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ bun run scan -- --from-block 19000000 --to-block 19000000
bun run aggregate -- --range 50
```

## Important Invariants

- Do not skip failed block reads. A failed block must be retried until it succeeds or the process is stopped.
- Do not advance `scanner_state.last_successful_block` unless the block metrics row was also written successfully.
- Keep block writes and progress updates in the same SQLite transaction.
- Preserve wei and gas precision. Store large integer values as decimal strings and use `bigint` for calculations.
- Fetch transaction receipts sequentially for the current block so the scanner handles transactions one by one.
- Keep network-dependent tests opt-in. Normal `bun test` should not require an RPC endpoint.

## Metric Conventions

- `base_block_fee_wei` comes from block `baseFeePerGas`; use `0` if the network does not provide it.
- `max_gas_in_block` is block `gasLimit`.
- Transaction fee size is `receipt.gasUsed * receipt.effectiveGasPrice`.
- Priority fee is `max(effectiveGasPrice - baseFeePerGas, 0)`.
- Weighted priority fee is weighted by actual transaction fee size.
- Empty blocks store `0` for average values.

## Implementation Notes

- Runtime code lives in `src/`.
- `src/rpc.ts` intentionally uses raw JSON-RPC over `fetch` to avoid runtime dependencies.
- `src/storage.ts` uses Bun's built-in `bun:sqlite`.
- `src/scanner.ts` owns retry and resume behavior.
- `src/metrics.ts` owns all block metric calculations.
- `src/server.ts` exposes `GET /blocks` and `GET /ranges` (built on `Bun.serve`). `/blocks` serves stored
  rows with filters `blockGt`, `blockLt`, `dateGt`, `dateLt`; `/ranges` serves aggregated range windows
  with filters `rangeSize` (defaults to `100`), `rangeStartGt`, `rangeStartLt`, `dateGt`, `dateLt`. All
  filters combine additively; results are always capped at the smallest 10,000 matching rows. Entry
  point: `src/serve.ts` (`bun run serve`).
- `src/ranges.ts` owns the parameterized aggregation math. Supported range sizes are
  `2, 5, 10, 20, 50, 100, 200, 500, 1000`; range boundaries are `[k * M, k * M + M - 1]`.
- `src/aggregator.ts` and `src/aggregate.ts` host the standalone aggregator entry point
  (`bun run aggregate -- --range N`). The scanner does NOT aggregate inline; aggregation only happens
  when this command is invoked.
- `block_ranges` rows are keyed by `(range_size, range_start)` so multiple range sizes can coexist.
