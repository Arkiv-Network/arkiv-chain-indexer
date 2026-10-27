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
  /**
   * Wei the transaction burned as storage rent, beside `gasUsed ×
   * effectiveGasPrice` (Arkiv UDC nodes; `0x0` when it failed). Absent on a
   * node that charges no rent, which reads as zero.
   */
  rentFee?: Hex;
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
  /** Base fee × gas used: the gas side of what the block burned. */
  burntFeesWei: string;
  /** Gas fees only (`Σ gasUsed × effectiveGasPrice`); rent is {@link totalRentFeeWei}. */
  totalTransactionFeeWei: string;
  /** Σ receipt `rentFee`: storage rent the block's transactions burned, outside gas. */
  totalRentFeeWei: string;
  /** `burntFeesWei + totalRentFeeWei`. */
  totalBurnedWei: string;
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
