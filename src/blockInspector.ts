import { hexToBigInt } from "./math";
import { EthereumRpcClient } from "./rpc";
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
  transactions: InspectedTransaction[];
}

export interface BlockInspectionResult {
  cached: boolean;
  block: InspectedBlock;
}

export interface BlockInspectorOptions {
  maxCachedBlocks?: number;
}

const DEFAULT_MAX_CACHED_BLOCKS = 100;

export class BlockInspector {
  private readonly maxCachedBlocks: number;
  private readonly cache = new Map<string, InspectedBlock>();
  private readonly pending = new Map<string, Promise<InspectedBlock>>();

  constructor(
    private readonly rpc: EthereumRpcClient,
    options: BlockInspectorOptions = {},
  ) {
    this.maxCachedBlocks = options.maxCachedBlocks ?? DEFAULT_MAX_CACHED_BLOCKS;
  }

  async inspectBlock(blockNumber: bigint): Promise<BlockInspectionResult> {
    const key = blockNumber.toString();
    const cached = this.cache.get(key);
    if (cached) {
      return { cached: true, block: cached };
    }

    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.fetchAndInspectBlock(blockNumber);
      this.pending.set(key, promise);
    }

    try {
      const block = await promise;
      return { cached: false, block };
    } finally {
      this.pending.delete(key);
    }
  }

  getCachedBlockCount(): number {
    return this.cache.size;
  }

  private async fetchAndInspectBlock(blockNumber: bigint): Promise<InspectedBlock> {
    const block = await this.rpc.getBlockWithTransactions(blockNumber);
    const receipts: RpcReceipt[] = [];

    for (const transaction of block.transactions) {
      receipts.push(await this.rpc.getTransactionReceipt(transaction.hash));
    }

    const inspected = inspectBlockFromRpc(block, receipts);
    this.writeCache(blockNumber.toString(), inspected);
    return inspected;
  }

  private writeCache(key: string, block: InspectedBlock) {
    if (this.maxCachedBlocks <= 0) return;

    this.cache.set(key, block);
    while (this.cache.size > this.maxCachedBlocks) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

export function inspectBlockFromRpc(block: RpcBlock, receipts: RpcReceipt[]): InspectedBlock {
  if (block.number === null) {
    throw new Error("Cannot inspect a pending block");
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

  return {
    blockNumber: Number(blockNumber),
    blockNumberDecimal: blockNumber.toString(),
    blockDate: new Date(Number(blockTimestampSeconds) * 1000).toISOString(),
    baseBlockFeeWei: baseFee.toString(),
    totalGasUsed: hexToBigInt(block.gasUsed).toString(),
    maxGasInBlock: hexToBigInt(block.gasLimit).toString(),
    transactionCount: block.transactions.length,
    transactions: block.transactions.map((transaction, index) =>
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
