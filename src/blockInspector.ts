import { hexToBigInt } from "./math";
import { shouldIgnoreTransaction } from "./transactionFilter";
import type { BatcherMetrics } from "./batcher";
import type { Hex, RpcBlock, RpcLog, RpcReceipt, RpcTransaction } from "./types";

export interface InspectedLog {
  /** Index of the log within its block (the receipt's `logIndex`). */
  logIndex: number;
  address: Hex;
  topics: Hex[];
  data: Hex;
}

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
  inputDataSizeBytes: string;
  inputDataCompressedSizeBytes: string;
  cumulativeGasUsed: string | null;
  gasPriceWei: string | null;
  maxFeePerGasWei: string | null;
  maxPriorityFeePerGasWei: string | null;
  effectiveGasPriceWei: string;
  priorityFeeWei: string;
  transactionFeeWei: string;
  status: string | null;
  contractAddress: Hex | null;
  /**
   * Event logs from the receipt (address, topics, data — never calldata).
   * Undefined when the receipt carried no `logs` field at all, which storage
   * records as "not indexed" rather than "no events".
   */
  logs?: InspectedLog[];
}

export interface InspectedBlock extends BatcherMetrics {
  blockNumber: number;
  blockNumberDecimal: string;
  blockDate: string;
  blockTimeSeconds: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  totalInputDataSizeBytes?: string;
  totalInputDataCompressedSizeBytes?: string;
  maxGasInBlock: string;
  transactionCount: number;
  blockRewardWei?: string;
  burntFeesWei?: string;
  totalTransactionFeeWei?: string;
  averageFeePriceWei?: string;
  averageTransactionFeeWei?: string;
  averageTransactionGasUsed?: string;
  averageTransactionInputDataSizeBytes?: string;
  averageTransactionInputDataCompressedSizeBytes?: string;
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
    blockTimeSeconds: "2",
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
    inputDataSizeBytes: hexDataByteLength(transaction.input).toString(),
    inputDataCompressedSizeBytes: compressedHexDataByteLength(transaction.input).toString(),
    cumulativeGasUsed: hexToDecimalString(receipt.cumulativeGasUsed),
    gasPriceWei: hexToDecimalString(transaction.gasPrice),
    maxFeePerGasWei: hexToDecimalString(transaction.maxFeePerGas),
    maxPriorityFeePerGasWei: hexToDecimalString(transaction.maxPriorityFeePerGas),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
    priorityFeeWei: priorityFee.toString(),
    transactionFeeWei: transactionFee.toString(),
    status: hexToDecimalString(receipt.status),
    contractAddress: receipt.contractAddress ?? null,
    ...(receipt.logs === undefined ? {} : { logs: inspectLogs(receipt.logs) }),
  };
}

function inspectLogs(logs: RpcLog[]): InspectedLog[] {
  return logs.map((log, index) => ({
    logIndex: log.logIndex === undefined ? index : Number(hexToBigInt(log.logIndex)),
    address: log.address.toLowerCase() as Hex,
    topics: log.topics.map((topic) => topic.toLowerCase() as Hex),
    data: (log.data ? log.data.toLowerCase() : "0x") as Hex,
  }));
}

function hexToDecimalString(value: Hex | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return hexToBigInt(value).toString();
}

export function hexDataByteLength(value: Hex | undefined | null): number {
  return hexDataToBytes(value).byteLength;
}

export function compressedHexDataByteLength(value: Hex | undefined | null): number {
  return Bun.zstdCompressSync(hexDataToBytes(value)).byteLength;
}

function hexDataToBytes(value: Hex | undefined | null): Uint8Array {
  if (value === undefined || value === null || value === "0x") return new Uint8Array();
  const hex = value.slice(2);
  if (hex.length % 2 !== 0) {
    throw new Error("Hex input data must contain a whole number of bytes");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
