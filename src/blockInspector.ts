import { hexToBigInt } from "./math";
import { shouldIgnoreTransaction } from "./transactionFilter";
import type { Hex, RpcBlock, RpcReceipt, RpcTransaction } from "./types";

export interface InspectedTransaction {
  position: number;
  hash: Hex;
  from: Hex | null;
  to: Hex | null;
  type: string | null;
  nonce: string | null;
  valueWei: string;
  gasLimit: string;
  gasUsed: string;
  cumulativeGasUsed: string | null;
  gasPriceWei: string | null;
  maxFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  effectiveGasPriceWei: string;
  priorityFeeWei: string;
  transactionFeeWei: string;
  status: string | null;
  contractAddress: Hex | null;
}

export interface InspectedBlock {
  blockNumber: number;
  blockNumberDecimal: string;
  blockDate: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  maxGasInBlock: string;
  transactionCount: number;
  blockRewardWei?: string;
  burntFeesWei?: string;
  totalTransactionFeeWei?: string;
  averageFeePriceWei?: string;
  averageTransactionFeeWei?: string;
  averageTransactionGasUsed?: string;
  averagePriorityFeeWeightedWei?: string;
  averagePriorityFeeWei?: string;
  transactions: InspectedTransaction[];
}

export interface BlockInspectionResult {
  cached: boolean;
  block: InspectedBlock;
}

export function inspectBlockFromRpc(block: RpcBlock, receipts: RpcReceipt[]): InspectedBlock {
  if (block.number === null) {
    throw new Error("Cannot inspect a pending block");
  }
  const transactions = block.transactions
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => !shouldIgnoreTransaction(transaction));

  if (receipts.length < transactions.length) {
    throw new Error(
      `Receipt count (${receipts.length}) is less than included transaction count (${transactions.length})`,
    );
  }

  const receiptsByHash = new Map(receipts.map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]));
  const blockNumber = hexToBigInt(block.number);
  const blockTimestampSeconds = hexToBigInt(block.timestamp);
  const baseFee = hexToBigInt(block.baseFeePerGas);

  return {
    blockNumber: Number(blockNumber),
    blockNumberDecimal: blockNumber.toString(),
    blockDate: new Date(Number(blockTimestampSeconds) * 1000).toISOString(),
    baseBlockFeeWei: baseFee.toString(),
    totalGasUsed: hexToBigInt(block.gasUsed).toString(),
    maxGasInBlock: hexToBigInt(block.gasLimit).toString(),
    transactionCount: transactions.length,
    transactions: transactions.map(({ transaction, index }) =>
      inspectTransaction(transaction, receiptsByHash, index, baseFee),
    ),
  };
}

function inspectTransaction(
  transaction: RpcTransaction,
  receiptsByHash: Map<string, RpcReceipt>,
  position: number,
  baseFee: bigint,
): InspectedTransaction {
  const receipt = receiptsByHash.get(transaction.hash.toLowerCase());
  if (!receipt) {
    throw new Error(`Missing receipt for transaction ${transaction.hash}`);
  }

  const gasUsed = hexToBigInt(receipt.gasUsed);
  const effectiveGasPrice = hexToBigInt(receipt.effectiveGasPrice ?? transaction.gasPrice);
  const priorityFee = effectiveGasPrice > baseFee ? effectiveGasPrice - baseFee : 0n;
  const transactionFee = gasUsed * effectiveGasPrice;

  return {
    position,
    hash: transaction.hash,
    from: transaction.from ?? null,
    to: transaction.to ?? null,
    type: hexToDecimalString(transaction.type),
    nonce: hexToDecimalString(transaction.nonce),
    valueWei: hexToBigInt(transaction.value).toString(),
    gasLimit: hexToBigInt(transaction.gas).toString(),
    gasUsed: gasUsed.toString(),
    cumulativeGasUsed: hexToDecimalString(receipt.cumulativeGasUsed),
    gasPriceWei: hexToDecimalString(transaction.gasPrice),
    maxFeePerGasWei: hexToDecimalString(transaction.maxFeePerGas),
    maxPriorityFeePerGasWei: hexToDecimalString(transaction.maxPriorityFeePerGas),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
    priorityFeeWei: priorityFee.toString(),
    transactionFeeWei: transactionFee.toString(),
    status: hexToDecimalString(receipt.status),
    contractAddress: receipt.contractAddress ?? null,
  };
}

function hexToDecimalString(value: Hex | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return hexToBigInt(value).toString();
}
