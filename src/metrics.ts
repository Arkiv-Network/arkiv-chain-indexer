import { average, hexToBigInt } from "./math";
import type { BlockMetrics, RpcBlock, RpcReceipt } from "./types";

export function computeBlockMetrics(block: RpcBlock, receipts: RpcReceipt[]): BlockMetrics {
  if (block.number === null) {
    throw new Error("Cannot store metrics for a pending block");
  }

  if (receipts.length !== block.transactions.length) {
    throw new Error(
      `Receipt count (${receipts.length}) does not match transaction count (${block.transactions.length})`,
    );
  }

  const receiptsByHash = new Map(receipts.map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]));
  const blockNumber = hexToBigInt(block.number);
  const blockTimestampSeconds = hexToBigInt(block.timestamp);
  const baseFee = hexToBigInt(block.baseFeePerGas);
  const priorityFees: bigint[] = [];
  let totalTransactionFee = 0n;
  let weightedPriorityFeeNumerator = 0n;

  for (const transaction of block.transactions) {
    const receipt = receiptsByHash.get(transaction.hash.toLowerCase());
    if (!receipt) {
      throw new Error(`Missing receipt for transaction ${transaction.hash}`);
    }

    const gasUsed = hexToBigInt(receipt.gasUsed);
    const effectiveGasPrice = hexToBigInt(receipt.effectiveGasPrice ?? transaction.gasPrice);
    const transactionFee = gasUsed * effectiveGasPrice;
    const priorityFee = effectiveGasPrice > baseFee ? effectiveGasPrice - baseFee : 0n;

    priorityFees.push(priorityFee);
    totalTransactionFee += transactionFee;
    weightedPriorityFeeNumerator += priorityFee * transactionFee;
  }

  const weightedPriorityFee =
    totalTransactionFee === 0n ? 0n : weightedPriorityFeeNumerator / totalTransactionFee;
  const transactionCount = block.transactions.length;
  const averageTransactionFee =
    transactionCount === 0 ? 0n : totalTransactionFee / BigInt(transactionCount);

  return {
    blockDate: new Date(Number(blockTimestampSeconds) * 1000).toISOString(),
    blockNumber,
    baseBlockFeeWei: baseFee.toString(),
    totalGasUsed: hexToBigInt(block.gasUsed).toString(),
    maxGasInBlock: hexToBigInt(block.gasLimit).toString(),
    transactionCount,
    averageTransactionFeeWei: averageTransactionFee.toString(),
    averagePriorityFeeWeightedWei: weightedPriorityFee.toString(),
    averagePriorityFeeWei: average(priorityFees).toString(),
  };
}
