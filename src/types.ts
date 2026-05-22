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
}

export interface RpcBlock {
  number: Hex | null;
  timestamp: Hex;
  baseFeePerGas?: Hex;
  gasUsed: Hex;
  gasLimit: Hex;
  transactions: RpcTransaction[];
}

export interface RpcReceipt {
  transactionHash: Hex;
  gasUsed: Hex;
  cumulativeGasUsed?: Hex;
  effectiveGasPrice?: Hex;
  status?: Hex;
  contractAddress?: Hex | null;
}

export interface BlockMetrics extends BatcherMetrics {
  blockDate: string;
  blockNumber: bigint;
  baseBlockFeeWei: string;
  totalGasUsed: string;
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
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}
