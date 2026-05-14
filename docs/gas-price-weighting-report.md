# Gas Price Weighting Report

## Scope

This report reviews how the scanner computes and aggregates the fields that are shown as average transaction fee,
average priority fee, and weighted average priority fee. The code does not currently store an "average gas price"
field directly; the closest stored gas-price-like values are priority fees and the average transaction fee.

## Block-Level Metrics

Block metrics are computed in `src/metrics.ts` from a block and its transaction receipts.

| Field | Formula | Notes |
| --- | --- | --- |
| `base_block_fee_wei` | `block.baseFeePerGas ?? 0` | Legacy networks without `baseFeePerGas` store `0`. |
| `average_transaction_fee_wei` | `sum(receipt.gasUsed * effectiveGasPrice) / transaction_count` | This is an average fee paid per transaction, not an average gas price. |
| `average_priority_fee_wei` | `sum(max(effectiveGasPrice - baseFeePerGas, 0)) / transaction_count` | Simple per-transaction average. |
| `average_priority_fee_weighted_wei` | `sum(priorityFee * transactionFee) / sum(transactionFee)` | Weighted by actual transaction fee size, where `transactionFee = receipt.gasUsed * effectiveGasPrice`. |

All arithmetic is done with `bigint` and integer division truncates fractional wei. Empty blocks store `0` for all
average values.

## Persistence Path

`src/storage.ts` writes the block row and scanner progress in one PostgreSQL transaction. Wei-sized values are
stored as decimal strings in `TEXT` columns so JavaScript number precision is not used for fee math.

This change adds two exact block-level helper columns:

| Column | Purpose |
| --- | --- |
| `total_transaction_fee_wei` | Exact denominator for transaction-fee-weighted priority calculations. |
| `priority_fee_weighted_numerator_wei` | Exact numerator for transaction-fee-weighted priority calculations. |

The displayed `average_priority_fee_weighted_wei` value is still stored as before, but range aggregation now has
the exact numerator and denominator available for newly scanned blocks.

## Range Aggregation

Before this change, `src/ranges.ts` aggregated range-level `average_priority_fee_weighted_wei` as:

```txt
sum(block.average_priority_fee_weighted_wei * block.total_gas_used) / sum(block.total_gas_used)
```

That was not the same weighting rule as the block-level metric. It weighted by gas used per block, not actual
transaction fee spend. Blocks with the same gas usage but very different effective gas prices could be weighted
incorrectly.

Range aggregation now uses:

```txt
sum(block.priority_fee_weighted_numerator_wei) / sum(block.total_transaction_fee_wei)
```

For older rows that do not have exact helper values, the aggregator falls back to the best value recoverable from
existing data:

```txt
sum(block.average_priority_fee_weighted_wei * block.average_transaction_fee_wei * block.transaction_count)
/ sum(block.average_transaction_fee_wei * block.transaction_count)
```

That fallback is approximate because the old rows only retained already-divided averages. Rescanning old blocks is
required if exact historical range aggregation is needed.

## Verdict

| Area | Result |
| --- | --- |
| Block-level weighted priority fee | Correct: weighted by actual transaction fee size. |
| Block-level average transaction fee | Correctly computed, but it is a transaction fee average, not a gas price average. |
| Previous range-level weighted priority fee | Incorrect for the stated convention because it reweighted by gas used. |
| Current range-level weighted priority fee | Correct for newly scanned blocks; approximate fallback for legacy rows. |
