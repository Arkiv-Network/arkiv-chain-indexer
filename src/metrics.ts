import { average, hexToBigInt } from "./math";
import { shouldIgnoreTransaction } from "./transactionFilter";
import type { BlockMetrics, RpcBlock, RpcReceipt } from "./types";

export function computeBlockMetrics(block: RpcBlock, receipts: RpcReceipt[]): BlockMetrics {
  if (block.number === null) {
    throw new Error("Cannot store metrics for a pending block");
  }

  const includedTransactions = block.transactions.filter((transaction) => !shouldIgnoreTransaction(transaction));

  if (receipts.length < includedTransactions.length) {
    throw new Error(
      `Receipt count (${receipts.length}) is less than included transaction count (${includedTransactions.length})`,
    );
  }

  const receiptsByHash = new Map(receipts.map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]));
  const blockNumber = hexToBigInt(block.number);
  const blockTimestampSeconds = hexToBigInt(block.timestamp);
  const baseFee = hexToBigInt(block.baseFeePerGas);
  const totalGasUsed = hexToBigInt(block.gasUsed);
  const priorityFees: bigint[] = [];
  const feePrices: bigint[] = [];
  let totalTransactionFee = 0n;
  let feePriceSum = 0n;
  let priorityFeeSum = 0n;
  let weightedPriorityFeeNumerator = 0n;
  let gasWeightedPriorityFeeNumerator = 0n;
  let totalReceiptGasUsed = 0n;

  for (const transaction of includedTransactions) {
    const receipt = receiptsByHash.get(transaction.hash.toLowerCase());
    if (!receipt) {
      throw new Error(`Missing receipt for transaction ${transaction.hash}`);
    }

    const gasUsed = hexToBigInt(receipt.gasUsed);
    const effectiveGasPrice = hexToBigInt(receipt.effectiveGasPrice ?? transaction.gasPrice);
    const transactionFee = gasUsed * effectiveGasPrice;
    const priorityFee = effectiveGasPrice > baseFee ? effectiveGasPrice - baseFee : 0n;

    feePrices.push(effectiveGasPrice);
    priorityFees.push(priorityFee);
    totalTransactionFee += transactionFee;
    feePriceSum += effectiveGasPrice;
    priorityFeeSum += priorityFee;
    weightedPriorityFeeNumerator += priorityFee * transactionFee;
    gasWeightedPriorityFeeNumerator += priorityFee * gasUsed;
    totalReceiptGasUsed += gasUsed;
  }

  const weightedPriorityFee =
    totalReceiptGasUsed === 0n ? 0n : gasWeightedPriorityFeeNumerator / totalReceiptGasUsed;
  const transactionCount = includedTransactions.length;
  const averageTransactionFee =
    transactionCount === 0 ? 0n : totalTransactionFee / BigInt(transactionCount);
  const averageTransactionGasUsed =
    transactionCount === 0 ? 0n : totalReceiptGasUsed / BigInt(transactionCount);

  return {
    blockDate: new Date(Number(blockTimestampSeconds) * 1000).toISOString(),
    blockNumber,
    baseBlockFeeWei: baseFee.toString(),
    totalGasUsed: totalGasUsed.toString(),
    maxGasInBlock: hexToBigInt(block.gasLimit).toString(),
    transactionCount,
    blockRewardWei: gasWeightedPriorityFeeNumerator.toString(),
    burntFeesWei: (baseFee * totalGasUsed).toString(),
    totalTransactionFeeWei: totalTransactionFee.toString(),
    feePriceSumWei: feePriceSum.toString(),
    priorityFeeSumWei: priorityFeeSum.toString(),
    priorityFeeWeightedNumeratorWei: weightedPriorityFeeNumerator.toString(),
    priorityFeeGasWeightedNumeratorWei: gasWeightedPriorityFeeNumerator.toString(),
    averageFeePriceWei: average(feePrices).toString(),
    averageTransactionFeeWei: averageTransactionFee.toString(),
    averageTransactionGasUsed: averageTransactionGasUsed.toString(),
    averagePriorityFeeWeightedWei: weightedPriorityFee.toString(),
    averagePriorityFeeWei: average(priorityFees).toString(),
  };
}
