export type Hex = `0x${string}`;

export interface RpcTransaction {
  hash: Hex;
  gasPrice?: Hex;
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
  effectiveGasPrice?: Hex;
}

export interface BlockMetrics {
  blockDate: string;
  blockNumber: bigint;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  maxGasInBlock: string;
  transactionCount: number;
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
