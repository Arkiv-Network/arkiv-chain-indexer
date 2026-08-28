import type { BatcherMetrics } from "./batcher";

export type Hex = `0x${string}`;

export interface RpcTransaction {
  hash: Hex;
  from?: Hex;
  to?: Hex | null;
  type?: Hex;
  nonce?: Hex;
  value?: Hex;
  gas?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  input?: Hex;
}

export interface RpcBlock {
  number: Hex | null;
  hash?: Hex | null;
  parentHash?: Hex;
  timestamp: Hex;
  baseFeePerGas?: Hex;
  gasUsed: Hex;
  gasLimit: Hex;
  transactions: RpcTransaction[];
}

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  /** Position of the log within the block; absent on some fixtures/nodes, then inferred per transaction. */
  logIndex?: Hex;
}

export interface RpcReceipt {
  transactionHash: Hex;
  gasUsed: Hex;
  cumulativeGasUsed?: Hex;
  effectiveGasPrice?: Hex;
  status?: Hex;
  contractAddress?: Hex | null;
  logs?: RpcLog[];
}

export interface BlockMetrics extends BatcherMetrics {
  /** Block header hash, lowercase; null for pending blocks or rows stored before hashes were kept. */
  blockHash?: string | null;
  parentHash?: string | null;
  blockDate: string;
  blockNumber: bigint;
  blockTimeSeconds: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  totalInputDataSizeBytes: string;
  totalInputDataCompressedSizeBytes: string;
  maxGasInBlock: string;
  transactionCount: number;
  blockRewardWei: string;
  burntFeesWei: string;
  totalTransactionFeeWei: string;
  feePriceSumWei: string;
  priorityFeeSumWei: string;
  priorityFeeWeightedNumeratorWei: string;
  priorityFeeGasWeightedNumeratorWei: string;
  averageFeePriceWei: string;
  averageTransactionFeeWei: string;
  averageTransactionGasUsed: string;
  averageTransactionInputDataSizeBytes: string;
  averageTransactionInputDataCompressedSizeBytes: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}
