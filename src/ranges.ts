import type { StoredBlock } from "./storage";

export const SUPPORTED_RANGE_SIZES: readonly bigint[] = [
  2n,
  5n,
  10n,
  20n,
  50n,
  100n,
  200n,
  500n,
  1000n,
];

export const DEFAULT_RANGE_SIZE = 100n;

export interface BlockRangeMetrics {
  rangeSize: bigint;
  rangeStart: bigint;
  rangeEnd: bigint;
  minBlockDate: string;
  maxBlockDate: string;
  minBaseFeeWei: string;
  maxBaseFeeWei: string;
  averageBaseFeeWei: string;
  totalGasUsed: string;
  totalMaxGas: string;
  transactionCount: number;
  totalBlockRewardWei: string;
  totalBurntFeesWei: string;
  averageBlockRewardWei: string;
  averageBurntFeesWei: string;
  averageFeePriceWei: string;
  averageTransactionGasUsed: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}

export function isSupportedRangeSize(rangeSize: bigint): boolean {
  return SUPPORTED_RANGE_SIZES.includes(rangeSize);
}

export function assertSupportedRangeSize(rangeSize: bigint): void {
  if (!isSupportedRangeSize(rangeSize)) {
    throw new Error(
      `Range size ${rangeSize.toString()} is not supported. Supported sizes: ${SUPPORTED_RANGE_SIZES.map(
        (value) => value.toString(),
      ).join(", ")}`,
    );
  }
}

export function parseRangeSize(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Range size must be a positive integer, got "${value}"`);
  }
  const parsed = BigInt(value);
  assertSupportedRangeSize(parsed);
  return parsed;
}

export function rangeStartFor(blockNumber: bigint, rangeSize: bigint): bigint {
  if (blockNumber < 0n) {
    throw new Error("Block number cannot be negative");
  }
  assertSupportedRangeSize(rangeSize);
  return blockNumber - (blockNumber % rangeSize);
}

export function rangeEndFor(rangeStart: bigint, rangeSize: bigint): bigint {
  assertSupportedRangeSize(rangeSize);
  return rangeStart + rangeSize - 1n;
}

export function computeBlockRange(
  rangeStart: bigint,
  rangeSize: bigint,
  blocks: StoredBlock[],
): BlockRangeMetrics {
  assertSupportedRangeSize(rangeSize);
  if (rangeStart < 0n || rangeStart % rangeSize !== 0n) {
    throw new Error(
      `Range start ${rangeStart.toString()} must be a non-negative multiple of ${rangeSize.toString()}`,
    );
  }
  if (BigInt(blocks.length) !== rangeSize) {
    throw new Error(
      `Range ${rangeStart.toString()} requires ${rangeSize.toString()} blocks, got ${blocks.length}`,
    );
  }

  const rangeEnd = rangeEndFor(rangeStart, rangeSize);
  const expectedNumbers = new Set<bigint>();
  for (let block = rangeStart; block <= rangeEnd; block += 1n) {
    expectedNumbers.add(block);
  }
  for (const block of blocks) {
    expectedNumbers.delete(BigInt(block.blockNumber));
  }
  if (expectedNumbers.size > 0) {
    throw new Error(
      `Range ${rangeStart.toString()}-${rangeEnd.toString()} is missing blocks: ${[
        ...expectedNumbers,
      ]
        .map((value) => value.toString())
        .join(", ")}`,
    );
  }

  let minBlockDate = blocks[0]!.blockDate;
  let maxBlockDate = blocks[0]!.blockDate;
  let minBaseFee = BigInt(blocks[0]!.baseBlockFeeWei);
  let maxBaseFee = minBaseFee;
  let baseFeeSum = 0n;
  let totalGasUsed = 0n;
  let totalMaxGas = 0n;
  let totalBlockReward = 0n;
  let totalBurntFees = 0n;
  let transactionCount = 0;
  let gasWeightedPriorityFeeNumerator = 0n;
  let feePriceNumerator = 0n;
  let transactionGasNumerator = 0n;
  let txWeightedPriorityFeeNumerator = 0n;

  for (const block of blocks) {
    if (block.blockDate < minBlockDate) minBlockDate = block.blockDate;
    if (block.blockDate > maxBlockDate) maxBlockDate = block.blockDate;

    const baseFee = BigInt(block.baseBlockFeeWei);
    if (baseFee < minBaseFee) minBaseFee = baseFee;
    if (baseFee > maxBaseFee) maxBaseFee = baseFee;
    baseFeeSum += baseFee;

    const gasUsed = BigInt(block.totalGasUsed);
    const maxGas = BigInt(block.maxGasInBlock);
    totalGasUsed += gasUsed;
    totalMaxGas += maxGas;

    transactionCount += block.transactionCount;
    const gasWeight = priorityFeeGasWeightFor(block);
    totalBlockReward += blockRewardFor(block);
    totalBurntFees += burntFeesFor(block);
    gasWeightedPriorityFeeNumerator += gasWeight.weightedPriorityFeeNumerator;
    feePriceNumerator += exactOrAverageSum(
      block.feePriceSumWei,
      block.averageFeePriceWei,
      block.transactionCount,
    );
    transactionGasNumerator += gasUsed;
    txWeightedPriorityFeeNumerator += exactOrAverageSum(
      block.priorityFeeSumWei,
      block.averagePriorityFeeWei,
      block.transactionCount,
    );
  }

  const averageBaseFee = baseFeeSum / rangeSize;
  const averagePriorityFeeWeighted =
    totalGasUsed === 0n
      ? 0n
      : gasWeightedPriorityFeeNumerator / totalGasUsed;
  const averageFeePrice =
    transactionCount === 0 ? 0n : feePriceNumerator / BigInt(transactionCount);
  const averageTransactionGasUsed =
    transactionCount === 0 ? 0n : transactionGasNumerator / BigInt(transactionCount);
  const averagePriorityFee =
    transactionCount === 0
      ? 0n
      : txWeightedPriorityFeeNumerator / BigInt(transactionCount);

  return {
    rangeSize,
    rangeStart,
    rangeEnd,
    minBlockDate,
    maxBlockDate,
    minBaseFeeWei: minBaseFee.toString(),
    maxBaseFeeWei: maxBaseFee.toString(),
    averageBaseFeeWei: averageBaseFee.toString(),
    totalGasUsed: totalGasUsed.toString(),
    totalMaxGas: totalMaxGas.toString(),
    transactionCount,
    totalBlockRewardWei: totalBlockReward.toString(),
    totalBurntFeesWei: totalBurntFees.toString(),
    averageBlockRewardWei: (totalBlockReward / rangeSize).toString(),
    averageBurntFeesWei: (totalBurntFees / rangeSize).toString(),
    averageFeePriceWei: averageFeePrice.toString(),
    averageTransactionGasUsed: averageTransactionGasUsed.toString(),
    averagePriorityFeeWeightedWei: averagePriorityFeeWeighted.toString(),
    averagePriorityFeeWei: averagePriorityFee.toString(),
  };
}

function blockRewardFor(block: StoredBlock): bigint {
  const stored = BigInt(block.blockRewardWei ?? "0");
  if (stored > 0n || block.transactionCount === 0) return stored;
  return BigInt(block.priorityFeeGasWeightedNumeratorWei ?? "0");
}

function burntFeesFor(block: StoredBlock): bigint {
  const stored = BigInt(block.burntFeesWei ?? "0");
  if (stored > 0n) return stored;
  return BigInt(block.baseBlockFeeWei) * BigInt(block.totalGasUsed);
}

function priorityFeeGasWeightFor(block: StoredBlock): {
  weightedPriorityFeeNumerator: bigint;
} {
  const storedNumerator = BigInt(block.priorityFeeGasWeightedNumeratorWei ?? "0");
  if (storedNumerator > 0n || block.transactionCount === 0) {
    return {
      weightedPriorityFeeNumerator: storedNumerator,
    };
  }

  return {
    weightedPriorityFeeNumerator:
      BigInt(block.averagePriorityFeeWeightedWei) * BigInt(block.totalGasUsed),
  };
}

function exactOrAverageSum(
  exactSum: string | undefined,
  averageValue: string,
  count: number,
): bigint {
  const stored = BigInt(exactSum ?? "0");
  if (stored > 0n || count === 0) return stored;
  return BigInt(averageValue) * BigInt(count);
}
