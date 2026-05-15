export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  transactionCount: number;
  baseBlockFeeWei: string;
  blockRewardWei?: string;
  burntFeesWei?: string;
  averagePriorityFeeWei: string;
  averagePriorityFeeWeightedWei: string;
  averageFeePriceWei: string;
  totalTransactionFeeWei?: string;
  feePriceSumWei?: string;
  priorityFeeSumWei?: string;
  priorityFeeWeightedNumeratorWei?: string;
  priorityFeeGasWeightedNumeratorWei?: string;
  averageTransactionFeeWei: string;
  averageTransactionGasUsed: string;
  totalGasUsed: string;
  maxGasInBlock: string;
}

export interface StoredBlockRange {
  rangeSize: number;
  rangeStart: number;
  rangeEnd: number;
  minBlockDate: string;
  maxBlockDate: string;
  minBaseFeeWei: string;
  maxBaseFeeWei: string;
  averageBaseFeeWei: string;
  averageFeePriceWei: string;
  averagePriorityFeeWei: string;
  averagePriorityFeeWeightedWei: string;
  averageTransactionGasUsed: string;
  totalBlockRewardWei: string;
  totalBurntFeesWei: string;
  averageBlockRewardWei: string;
  averageBurntFeesWei: string;
  transactionCount: number;
  totalGasUsed: string;
  totalMaxGas: string;
  minMaxGasInBlock: string;
  maxMaxGasInBlock: string;
}

export interface BlocksResponse {
  count: number;
  limit: number;
  truncated: boolean;
  blocks: StoredBlock[];
}

export interface RangesResponse {
  count: number;
  limit: number;
  truncated: boolean;
  ranges: StoredBlockRange[];
}

export interface InspectedTransaction {
  blockNumber?: number;
  blockNumberDecimal?: string;
  blockDate?: string;
  baseBlockFeeWei?: string;
  position: number;
  hash: string;
  from: string | null;
  to: string | null;
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
  contractAddress: string | null;
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

export interface BlockInspectResponse {
  cached: boolean;
  block: InspectedBlock;
}

export type StoredTransaction = InspectedTransaction &
  Required<
    Pick<InspectedTransaction, "blockNumber" | "blockNumberDecimal" | "blockDate" | "baseBlockFeeWei">
  >;

export interface TransactionsResponse {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    block: string | null;
    blockGt: string | null;
    blockLt: string | null;
    dateGt: string | null;
    dateLt: string | null;
  };
  transactions: StoredTransaction[];
}

async function getJson<T>(path: string, params: URLSearchParams): Promise<T> {
  const qs = params.toString();
  const url = qs ? `/api${path}?${qs}` : `/api${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export function fetchBlocks(params: URLSearchParams): Promise<BlocksResponse> {
  return getJson<BlocksResponse>("/blocks", params);
}

export function fetchRanges(params: URLSearchParams): Promise<RangesResponse> {
  return getJson<RangesResponse>("/ranges", params);
}

export function fetchBlockInspect(blockNumber: string): Promise<BlockInspectResponse> {
  return getJson<BlockInspectResponse>(`/block/${encodeURIComponent(blockNumber)}`, new URLSearchParams());
}

export function fetchTransactions(params: URLSearchParams): Promise<TransactionsResponse> {
  return getJson<TransactionsResponse>("/transactions", params);
}
