import type { StoredBlock } from "./storage";

export const SUPPORTED_RANGE_SIZES: readonly bigint[] = [
  2n,
  5n,
  10n,
  20n,
  50n,
  100n,
  150n,
  200n,
  300n,
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
  totalInputDataSizeBytes: string;
  totalInputDataCompressedSizeBytes: string;
  totalMaxGas: string;
  minMaxGasInBlock: string;
  maxMaxGasInBlock: string;
  transactionCount: number;
  totalBlockRewardWei: string;
  totalBurntFeesWei: string;
  averageBlockRewardWei: string;
  averageBurntFeesWei: string;
  averageFeePriceWei: string;
  averageTransactionGasUsed: string;
  averageTransactionInputDataSizeBytes: string;
  averageTransactionInputDataCompressedSizeBytes: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
  minBatcherQueueSize?: string | null;
  maxBatcherQueueSize?: string | null;
  averageBatcherQueueSize?: string | null;
  averageBatcherIntensity?: string | null;
  averageBatcherLowerThreshold?: string | null;
  averageBatcherUpperThreshold?: string | null;
  averageBatcherMaxBlockSize?: string | null;
  averageBatcherMaxTxSize?: string | null;
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
  let totalInputDataSizeBytes = 0n;
  let totalInputDataCompressedSizeBytes = 0n;
  let totalMaxGas = 0n;
  let minMaxGasInBlock = BigInt(blocks[0]!.maxGasInBlock);
  let maxMaxGasInBlock = minMaxGasInBlock;
  let totalBlockReward = 0n;
  let totalBurntFees = 0n;
  let transactionCount = 0;
  let gasWeightedPriorityFeeNumerator = 0n;
  let feePriceNumerator = 0n;
  let transactionGasNumerator = 0n;
  let transactionInputDataNumerator = 0n;
  let transactionInputDataCompressedNumerator = 0n;
  let txWeightedPriorityFeeNumerator = 0n;
  const batcherQueueSizes: bigint[] = [];
  const batcherIntensities: number[] = [];
  const batcherLowerThresholds: bigint[] = [];
  const batcherUpperThresholds: bigint[] = [];
  const batcherMaxBlockSizes: bigint[] = [];
  const batcherMaxTxSizes: bigint[] = [];

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
    totalInputDataSizeBytes += BigInt(block.totalInputDataSizeBytes ?? "0");
    totalInputDataCompressedSizeBytes += BigInt(block.totalInputDataCompressedSizeBytes ?? "0");
    totalMaxGas += maxGas;
    if (maxGas < minMaxGasInBlock) minMaxGasInBlock = maxGas;
    if (maxGas > maxMaxGasInBlock) maxMaxGasInBlock = maxGas;

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
    transactionInputDataNumerator += exactOrAverageSum(
      block.totalInputDataSizeBytes,
      block.averageTransactionInputDataSizeBytes ?? "0",
      block.transactionCount,
    );
    transactionInputDataCompressedNumerator += exactOrAverageSum(
      block.totalInputDataCompressedSizeBytes,
      block.averageTransactionInputDataCompressedSizeBytes ?? "0",
      block.transactionCount,
    );
    txWeightedPriorityFeeNumerator += exactOrAverageSum(
      block.priorityFeeSumWei,
      block.averagePriorityFeeWei,
      block.transactionCount,
    );
    pushOptionalBigInt(batcherQueueSizes, block.batcherQueueSize);
    pushOptionalNumber(batcherIntensities, block.batcherIntensity);
    pushOptionalBigInt(batcherLowerThresholds, block.batcherLowerThreshold);
    pushOptionalBigInt(batcherUpperThresholds, block.batcherUpperThreshold);
    pushOptionalBigInt(batcherMaxBlockSizes, block.batcherMaxBlockSize);
    pushOptionalBigInt(batcherMaxTxSizes, block.batcherMaxTxSize);
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
  const averageTransactionInputDataSizeBytes =
    transactionCount === 0 ? 0n : transactionInputDataNumerator / BigInt(transactionCount);
  const averageTransactionInputDataCompressedSizeBytes =
    transactionCount === 0 ? 0n : transactionInputDataCompressedNumerator / BigInt(transactionCount);
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
    totalInputDataSizeBytes: totalInputDataSizeBytes.toString(),
    totalInputDataCompressedSizeBytes: totalInputDataCompressedSizeBytes.toString(),
    totalMaxGas: totalMaxGas.toString(),
    minMaxGasInBlock: minMaxGasInBlock.toString(),
    maxMaxGasInBlock: maxMaxGasInBlock.toString(),
    transactionCount,
    totalBlockRewardWei: totalBlockReward.toString(),
    totalBurntFeesWei: totalBurntFees.toString(),
    averageBlockRewardWei: (totalBlockReward / rangeSize).toString(),
    averageBurntFeesWei: (totalBurntFees / rangeSize).toString(),
    averageFeePriceWei: averageFeePrice.toString(),
    averageTransactionGasUsed: averageTransactionGasUsed.toString(),
    averageTransactionInputDataSizeBytes: averageTransactionInputDataSizeBytes.toString(),
    averageTransactionInputDataCompressedSizeBytes: averageTransactionInputDataCompressedSizeBytes.toString(),
    averagePriorityFeeWeightedWei: averagePriorityFeeWeighted.toString(),
    averagePriorityFeeWei: averagePriorityFee.toString(),
    ...rangeStats("BatcherQueueSize", batcherQueueSizes, true),
    ...numberAverageStat("BatcherIntensity", batcherIntensities),
    ...rangeStats("BatcherLowerThreshold", batcherLowerThresholds),
    ...rangeStats("BatcherUpperThreshold", batcherUpperThresholds),
    ...rangeStats("BatcherMaxBlockSize", batcherMaxBlockSizes),
    ...rangeStats("BatcherMaxTxSize", batcherMaxTxSizes),
  };
}

function pushOptionalBigInt(values: bigint[], value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  values.push(BigInt(value));
}

// batcherIntensity is stored as text but can hold fractional values (e.g.
// "0.000002848359418402778"), so it cannot go through BigInt. Precision is not
// important here, so parse it as a plain number.
function pushOptionalNumber(values: number[], value: string | null | undefined): void {
  if (value === undefined || value === null) return;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return;
  values.push(parsed);
}

function numberAverageStat(
  fieldSuffix: string,
  values: number[],
): Record<string, string | null> {
  if (values.length === 0) {
    return { [`average${fieldSuffix}`]: null };
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return { [`average${fieldSuffix}`]: (sum / values.length).toString() };
}

function rangeStats(
  fieldSuffix: string,
  values: bigint[],
  includeMinMax = false,
): Record<string, string | null> {
  if (values.length === 0) {
    return includeMinMax
      ? {
          [`min${fieldSuffix}`]: null,
          [`max${fieldSuffix}`]: null,
          [`average${fieldSuffix}`]: null,
        }
      : { [`average${fieldSuffix}`]: null };
  }

  const sum = values.reduce((acc, value) => acc + value, 0n);
  const average = (sum / BigInt(values.length)).toString();
  if (!includeMinMax) {
    return { [`average${fieldSuffix}`]: average };
  }

  return {
    [`min${fieldSuffix}`]: values.reduce((acc, value) => (value < acc ? value : acc), values[0]!).toString(),
    [`max${fieldSuffix}`]: values.reduce((acc, value) => (value > acc ? value : acc), values[0]!).toString(),
    [`average${fieldSuffix}`]: average,
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
