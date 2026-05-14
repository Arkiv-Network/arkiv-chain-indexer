# Gas Price Weighting Report

## Scope

This report reviews how the scanner computes and aggregates the fields that are shown as average fee price,
average priority fee, gas-weighted average priority fee, and average transaction gas used.

## Block-Level Metrics

Block metrics are computed in `src/metrics.ts` from a block and its transaction receipts.

| Field | Formula | Notes |
| --- | --- | --- |
| `base_block_fee_wei` | `block.baseFeePerGas ?? 0` | Legacy networks without `baseFeePerGas` store `0`. |
| `average_fee_price_wei` | `sum(effectiveGasPrice) / transaction_count` | Simple average gas price set/paid per transaction. |
| `average_transaction_fee_wei` | `sum(receipt.gasUsed * effectiveGasPrice) / transaction_count` | This is an average fee paid per transaction, not an average gas price. |
| `average_transaction_gas_used` | `sum(receipt.gasUsed) / transaction_count` | Simple average transaction size in gas used. |
| `average_priority_fee_wei` | `sum(max(effectiveGasPrice - baseFeePerGas, 0)) / transaction_count` | Simple per-transaction average. |
| `average_priority_fee_weighted_wei` | `sum(priorityFee * receipt.gasUsed) / sum(receipt.gasUsed)` | Weighted by gas used so multiplying by total gas spend reconstructs total priority fees. |

All arithmetic is done with `bigint` and integer division truncates fractional wei. Empty blocks store `0` for all
average values.

## Persistence Path

`src/storage.ts` writes the block row and scanner progress in one PostgreSQL transaction. Wei-sized values are
stored as decimal strings in `TEXT` columns so JavaScript number precision is not used for fee math.

The storage layer keeps exact helper columns for range aggregation:

| Column | Purpose |
| --- | --- |
| `total_transaction_fee_wei` | Exact denominator for transaction-fee-weighted priority calculations. |
| `priority_fee_weighted_numerator_wei` | Legacy exact numerator for transaction-fee-weighted priority calculations. |
| `priority_fee_gas_weighted_numerator_wei` | Exact numerator for gas-weighted priority calculations. |
| `average_fee_price_wei` | Exact block-level simple average fee price. |
| `average_transaction_gas_used` | Exact block-level average transaction gas used. |

The displayed `average_priority_fee_weighted_wei` value is now gas-weighted, and range aggregation uses the
gas-weighted numerator plus `total_gas_used` for newly scanned blocks.

## Range Aggregation

Range-level `average_fee_price_wei`, `average_priority_fee_wei`, and `average_transaction_gas_used` are weighted
by transaction count:

```txt
sum(block.average_* * block.transaction_count) / sum(block.transaction_count)
```

Range-level `average_priority_fee_weighted_wei` is weighted by gas used:

```txt
sum(block.priority_fee_gas_weighted_numerator_wei) / sum(block.total_gas_used)
```

For older rows that do not have the exact gas-weighted helper value, the aggregator falls back to the best value
recoverable from existing data:

```txt
sum(block.average_priority_fee_weighted_wei * block.total_gas_used) / sum(block.total_gas_used)
```

That fallback is approximate if the old rows used different block-level weighting semantics. Rescanning old blocks
is required for exact historical values.

## Verdict

| Area | Result |
| --- | --- |
| Block-level average fee price | Correct: simple per-transaction average of effective gas price. |
| Block-level gas-weighted priority fee | Correct: weighted by receipt gas used. |
| Range-level average fee price and transaction gas | Correct: weighted by transaction count. |
| Range-level weighted priority fee | Correct for newly scanned blocks; approximate fallback for legacy rows. |
