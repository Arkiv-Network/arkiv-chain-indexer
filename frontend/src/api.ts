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
  batcherQueueSize?: string | null;
  batcherIntensity?: string | null;
  batcherLowerThreshold?: string | null;
  batcherUpperThreshold?: string | null;
  batcherMaxBlockSize?: string | null;
  batcherMaxTxSize?: string | null;
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
  minBatcherQueueSize?: string | null;
  maxBatcherQueueSize?: string | null;
  averageBatcherQueueSize?: string | null;
  averageBatcherIntensity?: string | null;
  averageBatcherLowerThreshold?: string | null;
  averageBatcherUpperThreshold?: string | null;
  averageBatcherMaxBlockSize?: string | null;
  averageBatcherMaxTxSize?: string | null;
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
  blockRewardWei?: string;
  burntFeesWei?: string;
  totalTransactionFeeWei?: string;
  averageFeePriceWei?: string;
  averageTransactionFeeWei?: string;
  averageTransactionGasUsed?: string;
  averagePriorityFeeWeightedWei?: string;
  averagePriorityFeeWei?: string;
  batcherQueueSize?: string | null;
  batcherIntensity?: string | null;
  batcherLowerThreshold?: string | null;
  batcherUpperThreshold?: string | null;
  batcherMaxBlockSize?: string | null;
  batcherMaxTxSize?: string | null;
  transactions: InspectedTransaction[];
}

export interface BlockInspectResponse {
  cached: boolean;
  transactionLoadError?: string;
  block: InspectedBlock;
}

export type StoredTransaction = InspectedTransaction &
  Required<
    Pick<InspectedTransaction, "blockNumber" | "blockNumberDecimal" | "blockDate" | "baseBlockFeeWei">
  >;

export type TransactionRecordCategory = "gas_used" | "transaction_fee" | "effective_fee";

export interface StoredTransactionRecord extends StoredTransaction {
  category: TransactionRecordCategory;
  recordValue: string;
  rank: number;
  recordedAt: string;
}

export type TransactionRecordsByCategory = Record<TransactionRecordCategory, StoredTransactionRecord[]>;

export interface TransactionRecordsResponse {
  limit: number;
  records: TransactionRecordsByCategory;
}

export interface TransactionsResponse {
  count: number;
  limit: number;
  truncated: boolean;
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  filters: {
    block: string | null;
    blockGt: string | null;
    blockLt: string | null;
    address: string | null;
    nonceGt: string | null;
    nonceLt: string | null;
    dateGt: string | null;
    dateLt: string | null;
  };
  transactions: StoredTransaction[];
}

export interface StoredSenderStats {
  address: string;
  latestNonce: string | null;
  transactionCount: string;
  totalGasUsed: string;
  totalTransactionFeeWei: string;
  totalValueWei: string;
  averageGasUsed: string;
  averageTransactionFeeWei: string;
  firstBlockNumber: number;
  firstBlockNumberDecimal: string;
  lastBlockNumber: number;
  lastBlockNumberDecimal: string;
  firstBlockDate: string;
  lastBlockDate: string;
  aggregatedAt: string;
}

export interface SendersResponse {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    order: "asc" | "desc";
  };
  senders: StoredSenderStats[];
}

export interface DatabaseTableStats {
  tableName: string;
  rowCount: string;
  tableSizeBytes: string;
  indexesSizeBytes: string;
  totalSizeBytes: string;
}

export interface HealthResponse {
  ok: boolean;
  serverTimeUtc: string;
  build: {
    commit: string | null;
    builtAtUtc: string | null;
  };
  scanner: {
    lastSuccessfulBlock: string | null;
    lastSuccessfulBlockDate: string | null;
    lastSuccessfulScannedAtUtc: string | null;
    lastBlockAgeSeconds: number | null;
    backfillNextBlock: string | null;
    latestObservedBlock: string | null;
    safeHeadBlock: string | null;
    latestObservedAtUtc: string | null;
    latestObservationAgeSeconds: number | null;
    headLagBlocks: string | null;
    safeHeadLagBlocks: string | null;
  };
  database: {
    totalSizeBytes: string;
    tables: DatabaseTableStats[];
  };
  features: {
    transactionData: boolean;
  };
}

export interface BaseloadWorkerConfig {
  id: string;
  maxGasPriceGwei: number;
  createsPerMinute: number;
  singleCreatePayloadSize: number;
  singleCreateStringArgumentCount: number;
  singleCreateNumberArgumentCount: number;
  walletNumber: number;
  walletAddress: string;
  startBlock: number;
  endBlock: number | null;
  durationSeconds: number | null;
  ttlSeconds: number;
}

export interface BaseloadConfig {
  version: 1;
  workers: BaseloadWorkerConfig[];
}

export interface BaseloadTaskStatus {
  workerId: string;
  walletNumber: number;
  status: "starting" | "ready" | "updated" | "running" | "waiting" | "completed" | "error" | "stopped";
  updatedAt: string;
  currentBlock?: number;
  message?: string;
  attemptedCount?: number;
  createdCount?: number;
  entityKey?: string;
  txHash?: string;
}

export interface BaseloadWorkerBalance {
  balanceWei: string;
  updatedAt: string;
  error?: string;
}

export interface BaseloadStateResponse {
  enabled: boolean;
  config: BaseloadConfig;
  statuses: Record<string, BaseloadTaskStatus>;
  balances: Record<string, BaseloadWorkerBalance>;
}

export interface StoredBaseloadConfigSummary {
  name: string;
  workerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredBaseloadConfig extends StoredBaseloadConfigSummary {
  config: BaseloadConfig;
}

export interface BaseloadConfigsResponse {
  configs: StoredBaseloadConfigSummary[];
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

async function getAdminJson<T>(path: string, bearerToken?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(`/api${path}`, { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

async function putJson<T>(path: string, body: unknown, bearerToken?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(`/api${path}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

async function deleteJson<T>(path: string, bearerToken?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(`/api${path}`, {
    method: "DELETE",
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export function fetchBlocks(params: URLSearchParams): Promise<BlocksResponse> {
  return getJson<BlocksResponse>("/blocks", params);
}

export async function fetchBlockByNumber(blockNumber: string | number): Promise<StoredBlock | null> {
  const response = await fetch(`/api/blocks/${encodeURIComponent(blockNumber)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return (await response.json()) as StoredBlock;
}

export function fetchRanges(params: URLSearchParams): Promise<RangesResponse> {
  return getJson<RangesResponse>("/ranges", params);
}

export async function fetchBlockInspect(blockNumber: string): Promise<BlockInspectResponse> {
  const block = await fetchBlockByNumber(blockNumber);
  if (!block) {
    throw new Error(`Block ${blockNumber} was not found in storage`);
  }

  const transactionParams = new URLSearchParams({
    block: blockNumber,
    limit: "1000",
    order: "asc",
  });

  try {
    const transactions = await fetchTransactions(transactionParams);
    return {
      cached: true,
      block: {
        ...block,
        blockNumberDecimal: String(block.blockNumber),
        transactions: transactions.transactions,
      },
    };
  } catch (error) {
    return {
      cached: true,
      transactionLoadError: error instanceof Error ? error.message : String(error),
      block: {
        ...block,
        blockNumberDecimal: String(block.blockNumber),
        transactions: [],
      },
    };
  }
}

export function fetchTransactions(params: URLSearchParams): Promise<TransactionsResponse> {
  return getJson<TransactionsResponse>("/transactions", params);
}

export function fetchTransactionRecords(params: URLSearchParams): Promise<TransactionRecordsResponse> {
  return getJson<TransactionRecordsResponse>("/transaction-records", params);
}

export function fetchSenders(params: URLSearchParams): Promise<SendersResponse> {
  return getJson<SendersResponse>("/senders", params);
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/health", new URLSearchParams());
}

export interface AdminVerifyResponse {
  authorized: true;
}

export async function verifyAdminToken(bearerToken: string): Promise<AdminVerifyResponse> {
  const headers: Record<string, string> = {};
  const trimmed = bearerToken.trim();
  if (trimmed) {
    headers.authorization = `Bearer ${trimmed}`;
  }
  const response = await fetch("/api/admin/verify", { headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json() as Promise<AdminVerifyResponse>;
}

export function fetchBaseloadState(): Promise<BaseloadStateResponse> {
  return getJson<BaseloadStateResponse>("/baseload", new URLSearchParams());
}

export function updateBaseloadConfig(
  config: BaseloadConfig,
  adminBearerToken?: string,
): Promise<BaseloadStateResponse> {
  return putJson<BaseloadStateResponse>("/baseload", config, adminBearerToken);
}

export function fetchBaseloadConfigs(adminBearerToken?: string): Promise<BaseloadConfigsResponse> {
  return getAdminJson<BaseloadConfigsResponse>("/baseload/configs", adminBearerToken);
}

export function saveBaseloadConfig(
  name: string,
  config: BaseloadConfig,
  adminBearerToken?: string,
): Promise<StoredBaseloadConfig> {
  return putJson<StoredBaseloadConfig>(
    `/baseload/configs/${encodeURIComponent(name)}`,
    config,
    adminBearerToken,
  );
}

export function loadBaseloadConfig(
  name: string,
  adminBearerToken?: string,
): Promise<BaseloadStateResponse> {
  return putJson<BaseloadStateResponse>(
    `/baseload/configs/${encodeURIComponent(name)}/load`,
    {},
    adminBearerToken,
  );
}

export function deleteBaseloadConfig(
  name: string,
  adminBearerToken?: string,
): Promise<{ deleted: boolean }> {
  return deleteJson<{ deleted: boolean }>(
    `/baseload/configs/${encodeURIComponent(name)}`,
    adminBearerToken,
  );
}
