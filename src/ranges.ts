import type { StoredBlock } from "./storage";

export const RANGE_SIZE = 100n;

export interface BlockRangeMetrics {
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
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}

export function rangeStartFor(blockNumber: bigint): bigint {
  if (blockNumber < 0n) {
    throw new Error("Block number cannot be negative");
  }
  return blockNumber - (blockNumber % RANGE_SIZE);
}

export function rangeEndFor(rangeStart: bigint): bigint {
  return rangeStart + RANGE_SIZE - 1n;
}

export function computeBlockRange(rangeStart: bigint, blocks: StoredBlock[]): BlockRangeMetrics {
  if (rangeStart < 0n || rangeStart % RANGE_SIZE !== 0n) {
    throw new Error(`Range start ${rangeStart.toString()} must be a non-negative multiple of ${RANGE_SIZE}`);
  }
  if (BigInt(blocks.length) !== RANGE_SIZE) {
    throw new Error(
      `Range ${rangeStart.toString()} requires ${RANGE_SIZE.toString()} blocks, got ${blocks.length}`,
    );
  }

  const rangeEnd = rangeEndFor(rangeStart);
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
  let transactionCount = 0;
  let gasWeightedPriorityFeeNumerator = 0n;
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
    gasWeightedPriorityFeeNumerator +=
      BigInt(block.averagePriorityFeeWeightedWei) * gasUsed;
    txWeightedPriorityFeeNumerator +=
      BigInt(block.averagePriorityFeeWei) * BigInt(block.transactionCount);
  }

  const averageBaseFee = baseFeeSum / RANGE_SIZE;
  const averagePriorityFeeWeighted =
    totalGasUsed === 0n ? 0n : gasWeightedPriorityFeeNumerator / totalGasUsed;
  const averagePriorityFee =
    transactionCount === 0
      ? 0n
      : txWeightedPriorityFeeNumerator / BigInt(transactionCount);

  return {
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
    averagePriorityFeeWeightedWei: averagePriorityFeeWeighted.toString(),
    averagePriorityFeeWei: averagePriorityFee.toString(),
  };
}
