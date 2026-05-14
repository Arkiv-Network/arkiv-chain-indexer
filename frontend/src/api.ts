export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  transactionCount: number;
  baseBlockFeeWei: string;
  averagePriorityFeeWei: string;
  averagePriorityFeeWeightedWei: string;
  averageTransactionFeeWei: string;
  totalGasUsed: string;
  maxGasInBlock: string;
}

export interface StoredBlockRange {
  rangeSize: number;
  rangeStart: number;
  rangeEnd: number;
  minBlockDate: string;
  maxBlockDate: string;
  averageBaseFeeWei: string;
  averagePriorityFeeWei: string;
  averagePriorityFeeWeightedWei: string;
  transactionCount: number;
  totalGasUsed: string;
  totalMaxGas: string;
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
