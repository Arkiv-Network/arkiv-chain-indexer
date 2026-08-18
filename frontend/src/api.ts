export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  blockTimeSeconds: string;
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
  averageTransactionInputDataSizeBytes: string;
  averageTransactionInputDataCompressedSizeBytes: string;
  totalGasUsed: string;
  totalInputDataSizeBytes: string;
  totalInputDataCompressedSizeBytes: string;
  maxGasInBlock: string;
  batcherQueueSize?: string | null;
  batcherIntensity?: string | null;
  batcherLowerThreshold?: string | null;
  batcherUpperThreshold?: string | null;
  batcherMaxBlockSize?: string | null;
  batcherMaxTxSize?: string | null;
}

export const BLOCK_RESPONSE_NAMES = [
  "blockNumber",
  "blockDate",
  "blockTimeSeconds",
  "baseBlockFeeWei",
  "totalGasUsed",
  "totalInputDataSizeBytes",
  "totalInputDataCompressedSizeBytes",
  "maxGasInBlock",
  "transactionCount",
  "blockRewardWei",
  "burntFeesWei",
  "totalTransactionFeeWei",
  "feePriceSumWei",
  "priorityFeeSumWei",
  "priorityFeeWeightedNumeratorWei",
  "priorityFeeGasWeightedNumeratorWei",
  "averageFeePriceWei",
  "averageTransactionFeeWei",
  "averageTransactionGasUsed",
  "averageTransactionInputDataSizeBytes",
  "averageTransactionInputDataCompressedSizeBytes",
  "averagePriorityFeeWeightedWei",
  "averagePriorityFeeWei",
  "batcherQueueSize",
  "batcherIntensity",
  "batcherLowerThreshold",
  "batcherUpperThreshold",
  "batcherMaxBlockSize",
  "batcherMaxTxSize",
] as const satisfies readonly (keyof StoredBlock)[];

export type BlockResponseName = (typeof BLOCK_RESPONSE_NAMES)[number];
export type BlockResponseValue = number | string | null;
export type BlockResponseRow = BlockResponseValue[];

export const RANGE_RESPONSE_NAMES = [
  "rangeSize",
  "rangeStart",
  "rangeEnd",
  "minBlockDate",
  "maxBlockDate",
  "averageBlockTimeSeconds",
  "minBlockTimeSeconds",
  "maxBlockTimeSeconds",
  "minBaseFeeWei",
  "maxBaseFeeWei",
  "averageBaseFeeWei",
  "totalGasUsed",
  "averageTotalGasUsed",
  "minTotalGasUsed",
  "maxTotalGasUsed",
  "totalInputDataSizeBytes",
  "averageTotalInputDataSizeBytes",
  "minTotalInputDataSizeBytes",
  "maxTotalInputDataSizeBytes",
  "totalInputDataCompressedSizeBytes",
  "averageTotalInputDataCompressedSizeBytes",
  "minTotalInputDataCompressedSizeBytes",
  "maxTotalInputDataCompressedSizeBytes",
  "totalMaxGas",
  "minMaxGasInBlock",
  "maxMaxGasInBlock",
  "transactionCount",
  "totalBlockRewardWei",
  "totalBurntFeesWei",
  "averageBlockRewardWei",
  "averageBurntFeesWei",
  "averageFeePriceWei",
  "averageTransactionGasUsed",
  "averageTransactionInputDataSizeBytes",
  "averageTransactionInputDataCompressedSizeBytes",
  "averagePriorityFeeWeightedWei",
  "averagePriorityFeeWei",
  "minBatcherQueueSize",
  "maxBatcherQueueSize",
  "averageBatcherQueueSize",
  "averageBatcherIntensity",
  "averageBatcherLowerThreshold",
  "averageBatcherUpperThreshold",
  "averageBatcherMaxBlockSize",
  "averageBatcherMaxTxSize",
] as const satisfies readonly (keyof StoredBlockRange)[];

export type RangeResponseName = (typeof RANGE_RESPONSE_NAMES)[number];
export type RangeResponseValue = number | string | null;
export type RangeResponseRow = RangeResponseValue[];

export interface StoredBlockRange {
  rangeSize: number;
  rangeStart: number;
  rangeEnd: number;
  minBlockDate: string;
  maxBlockDate: string;
  averageBlockTimeSeconds: string;
  minBlockTimeSeconds: string;
  maxBlockTimeSeconds: string;
  minBaseFeeWei: string;
  maxBaseFeeWei: string;
  averageBaseFeeWei: string;
  averageFeePriceWei: string;
  averagePriorityFeeWei: string;
  averagePriorityFeeWeightedWei: string;
  averageTransactionGasUsed: string;
  averageTransactionInputDataSizeBytes: string;
  averageTransactionInputDataCompressedSizeBytes: string;
  totalBlockRewardWei: string;
  totalBurntFeesWei: string;
  averageBlockRewardWei: string;
  averageBurntFeesWei: string;
  transactionCount: number;
  totalGasUsed: string;
  averageTotalGasUsed: string;
  minTotalGasUsed: string;
  maxTotalGasUsed: string;
  totalInputDataSizeBytes: string;
  averageTotalInputDataSizeBytes: string;
  minTotalInputDataSizeBytes: string;
  maxTotalInputDataSizeBytes: string;
  totalInputDataCompressedSizeBytes: string;
  averageTotalInputDataCompressedSizeBytes: string;
  minTotalInputDataCompressedSizeBytes: string;
  maxTotalInputDataCompressedSizeBytes: string;
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

interface CompactBlocksResponse {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    blockGt: string | null;
    blockLt: string | null;
    dateGt: string | null;
    dateLt: string | null;
  };
  names: string[];
  blocks: BlockResponseRow[];
}

let latestBlockResponseNames: readonly string[] = BLOCK_RESPONSE_NAMES;

export interface BlockRequestDebugSample {
  ok: boolean;
  status: number | null;
  durationMs: number;
  transferredBytes: number;
}

export type BlockRequestDebugObserver = (sample: BlockRequestDebugSample) => void;

export interface RangesResponse {
  count: number;
  limit: number;
  truncated: boolean;
  ranges: StoredBlockRange[];
}

interface CompactRangesResponse {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    rangeSize: string;
    rangeStartGt: string | null;
    rangeStartLt: string | null;
    dateGt: string | null;
    dateLt: string | null;
  };
  names: string[];
  ranges: RangeResponseRow[];
}

export interface ArkivOperationAttribute {
  key: string;
  valueType: number;
  valueTypeName: string; // "uint" | "string" | "entityKey" | "unknown"
  value: string;
}

export interface ArkivReferenceVerification {
  valid: boolean;
  signerTrusted: boolean;
  chainId: number;
  claimedSigner: string | null;
  recoveredSigner: string | null;
  messageHash: string | null;
  errors: string[];
}

export interface ArkivPayloadReference {
  kind: string;
  version: number;
  provider: string;
  id: string;
  namespace: string;
  contentType?: string;
  checksum: string;
  sizeBytes: number;
  submittedAt: string;
  nonce: string;
  /** Signed provider payment gas units. Converted to wei with the block base fee. */
  payment: number;
  signature: {
    scheme: string;
    signer: string;
    receipt: Record<string, unknown>;
    messageHash: string;
    signature: string;
    r: string;
    s: string;
    v: number;
  };
}

export interface ArkivOperation {
  opIndex: number; // 0-based index of the operation within the tx's execute() call
  operationType: number; // 1=create 2=update 3=extend 4=transfer 5=delete 6=expire
  operation: string; // "create" | "update" | "extend" | "transfer" | "delete" | "expire" | "unknown(N)"
  entityKey: string | null; // bytes32 hex as returned by decoder
  contentType: string | null; // decoded MIME-ish string or null
  payloadSizeBytes: number; // SIZE ONLY — the payload bytes/hex/text are NEVER stored anywhere
  attributes: ArkivOperationAttribute[];
  expiresAtBlocks: number; // uint32 from decoder (0 when not applicable)
  newOwner: string | null; // address for transfer ops, null otherwise
  // Reference mode (optional: absent on pre-reference rows / older fixtures).
  isReference?: boolean; // true when the payload is a v1 payload reference
  payloadReference?: ArkivPayloadReference | null; // provider receipt metadata, never entity bytes
  referenceVerification?: ArkivReferenceVerification | null; // offline EIP-191 verdict
  referenceError?: string | null; // set when a reference payload failed to parse
}

export interface ArkivOperationSummaryEntry {
  operation: string;
  operationType: number;
  count: number;
}

export interface PayloadProviderPaymentEntry {
  opIndex: number;
  provider: string;
  signer: string | null;
  payloadId: string;
  paymentGasUnits?: string;
  paymentWei: string;
  providerEarnedWei: string;
  burnedWei: string;
}

export interface PayloadProviderPaymentProviderTotal {
  provider: string;
  signer: string | null;
  paymentCount: number;
  paymentGasUnits?: string;
  paymentWei: string;
  providerEarnedWei: string;
  burnedWei: string;
}

export interface PayloadProviderPaymentBreakdown {
  enabled: boolean;
  providerShareBps: number | null;
  minimumPaymentGasUnits?: string | null;
  minimumPaymentWei: string | null;
  totalPaymentGasUnits?: string;
  totalPaymentWei: string;
  totalProviderEarnedWei: string;
  totalBurnedWei: string;
  entries: PayloadProviderPaymentEntry[];
  providers: PayloadProviderPaymentProviderTotal[];
  source: "protocolSchedule" | "configuredShareBps" | "unconfigured";
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
  contractAddress: string | null;
  /** Decoded Arkiv operations; present on /transaction/<hash> detail responses. */
  operations?: ArkivOperation[];
  /** Per-operation-type counts; present on /transactions list rows that have stored operations. */
  operationsSummary?: ArkivOperationSummaryEntry[];
  /** Payload-reference payment split for transaction detail rows. */
  payloadProviderPayments?: PayloadProviderPaymentBreakdown;
}

export interface InspectedBlock {
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

export interface GuzzlerStat {
  address: string;
  transactionCount: number;
  totalGasUsed: string;
  totalFeeWei: string;
  firstSeen: string;
  lastSeen: string;
}

export interface GuzzlerWindowLeaderboard {
  label: string;
  windowMs: number;
  count: number;
  guzzlers: GuzzlerStat[];
}

export interface GuzzlersResponse {
  generatedAt: string;
  retentionMs: number;
  limit: number;
  windows: GuzzlerWindowLeaderboard[];
}

export const GUZZLER_STAT_RESPONSE_NAMES = [
  "address",
  "transactionCount",
  "totalGasUsed",
  "totalFeeWei",
  "firstSeen",
  "lastSeen",
] as const satisfies readonly (keyof GuzzlerStat)[];

export type GuzzlerStatResponseName = (typeof GUZZLER_STAT_RESPONSE_NAMES)[number];
export type GuzzlerStatResponseValue = number | string | null;
export type GuzzlerStatResponseRow = GuzzlerStatResponseValue[];

interface CompactGuzzlerWindowLeaderboard {
  label: string;
  windowMs: number;
  count: number;
  guzzlers: GuzzlerStatResponseRow[];
}

interface CompactGuzzlersResponse {
  generatedAt: string;
  retentionMs: number;
  limit: number;
  names: string[];
  windows: CompactGuzzlerWindowLeaderboard[];
}

export interface GuzzlerHistoryPoint {
  minute: number;
  startTime: string;
  transactionCount: number;
  totalGasUsed: string;
  totalFeeWei: string;
  firstSeen: string;
  lastSeen: string;
}

export const GUZZLER_HISTORY_POINT_RESPONSE_NAMES = [
  "minute",
  "startTime",
  "transactionCount",
  "totalGasUsed",
  "totalFeeWei",
  "firstSeen",
  "lastSeen",
] as const satisfies readonly (keyof GuzzlerHistoryPoint)[];

export type GuzzlerHistoryPointResponseName =
  (typeof GUZZLER_HISTORY_POINT_RESPONSE_NAMES)[number];
export type GuzzlerHistoryPointResponseValue = number | string | null;
export type GuzzlerHistoryPointResponseRow = GuzzlerHistoryPointResponseValue[];

export interface GuzzlerHistoryResponse {
  address: string;
  generatedAt: string;
  retentionMs: number;
  bucketMs: number;
  count: number;
  points: GuzzlerHistoryPoint[];
}

interface CompactGuzzlerHistoryResponse {
  address: string;
  generatedAt: string;
  retentionMs: number;
  bucketMs: number;
  count: number;
  names: string[];
  points: GuzzlerHistoryPointResponseRow[];
}

export interface DatabaseTableStats {
  tableName: string;
  rowCount: string;
  tableSizeBytes: string;
  indexesSizeBytes: string;
  totalSizeBytes: string;
}

export type SyncState =
  | "synced"
  | "catching-up"
  | "falling-behind"
  | "holding"
  | "stalled"
  | "unknown";

/** Scanner sync progress, as served by `GET /sync` and embedded in `GET /health`. */
export interface SyncStatus {
  state: SyncState;
  summary: string;
  lastSuccessfulBlock: string | null;
  lastSuccessfulBlockDate: string | null;
  latestObservedBlock: string | null;
  latestObservedAtUtc: string | null;
  headObservationAgeSeconds: number | null;
  headObservationStale: boolean;
  estimatedHeadBlock: string | null;
  observedLagBlocks: string | null;
  lagBlocks: string | null;
  lagSeconds: number | null;
  chainBlockTimeSeconds: number | null;
  chainBlocksPerSecond: number | null;
  scanBlocksPerSecond: number | null;
  speedupFactor: number | null;
  netCatchUpBlocksPerSecond: number | null;
  etaSeconds: number | null;
  etaUtc: string | null;
  measuredWindowSeconds: number | null;
  measuredBlocks: number | null;
}

export interface SyncStatusResponse {
  ok: boolean;
  serverTimeUtc: string;
  sync: SyncStatus;
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
  sync?: SyncStatus;
  database: {
    totalSizeBytes: string;
    tables: DatabaseTableStats[];
  };
  features: {
    transactionData: boolean;
    guzzlers?: boolean;
  };
  guzzlers?: {
    enabled: boolean;
    entryCount: number | null;
    bucketCount: number | null;
    oldestBucket: string | null;
    newestBucket: string | null;
    totalSizeBytes: string | null;
  };
}

export const BASELOAD_WORKER_BEHAVIORS = [
  "create",
  "create-update",
  "create-ownership",
  "time-bomb",
  "create-update-delete",
] as const;

export type BaseloadWorkerBehavior = (typeof BASELOAD_WORKER_BEHAVIORS)[number];

export interface BaseloadWorkerConfig {
  id: string;
  behavior: BaseloadWorkerBehavior;
  maxGasPriceGwei: number;
  opsPerMinute: number;
  entitiesPerRequest: number;
  singleCreatePayloadSize: number;
  singleCreateStringArgumentCount: number;
  singleCreateNumberArgumentCount: number;
  entityPoolSize: number;
  timeBombOffsetSeconds: number;
  walletNumber: number;
  walletAddress: string;
  startBlock: number;
  endBlock: number | null;
  durationSeconds: number | null;
  ttlSeconds: number;
}

export interface BaseloadConfig {
  version: 2;
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
  updatedCount?: number;
  deletedCount?: number;
  ownershipChangedCount?: number;
  poolSize?: number;
  detonationAt?: string;
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

async function getJson<T>(
  path: string,
  params: URLSearchParams,
  debugObserver?: BlockRequestDebugObserver,
): Promise<T> {
  const qs = params.toString();
  const url = qs ? `/api${path}?${qs}` : `/api${path}`;
  if (debugObserver) {
    return fetchJsonWithDebug<T>(url, debugObserver);
  }

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

export function fetchBlocks(
  params: URLSearchParams,
  debugObserver?: BlockRequestDebugObserver,
): Promise<BlocksResponse> {
  return getJson<CompactBlocksResponse>("/blocks", params, debugObserver).then(expandBlocksResponse);
}

export async function fetchBlockByNumber(
  blockNumber: string | number,
  debugObserver?: BlockRequestDebugObserver,
): Promise<StoredBlock | null> {
  const url = `/api/blocks/${encodeURIComponent(blockNumber)}`;
  if (!debugObserver) {
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    const row = (await response.json()) as BlockResponseRow;
    return decodeBlockResponseRow(row, namesForBlockResponseRow(row));
  }

  const startedAt = nowMs();
  let response: Response | null = null;
  let text = "";
  try {
    response = await fetch(url);
    text = await response.text();
    const durationMs = nowMs() - startedAt;
    if (response.status === 404) {
      debugObserver({
        ok: true,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      return null;
    }
    if (!response.ok) {
      debugObserver({
        ok: false,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    try {
      const row = JSON.parse(text) as BlockResponseRow;
      const block = decodeBlockResponseRow(row, namesForBlockResponseRow(row));
      debugObserver({
        ok: true,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      return block;
    } catch (error) {
      debugObserver({
        ok: false,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      throw error;
    }
  } catch (error) {
    if (response === null) {
      debugObserver({
        ok: false,
        status: null,
        durationMs: nowMs() - startedAt,
        transferredBytes: 0,
      });
    }
    throw error;
  }
}

function expandBlocksResponse(response: CompactBlocksResponse): BlocksResponse {
  latestBlockResponseNames = response.names.length > 0 ? response.names : BLOCK_RESPONSE_NAMES;

  return {
    count: response.count,
    limit: response.limit,
    truncated: response.truncated,
    blocks: response.blocks.map((row) => decodeBlockResponseRow(row, response.names)),
  };
}

function expandRangesResponse(response: CompactRangesResponse): RangesResponse {
  return {
    count: response.count,
    limit: response.limit,
    truncated: response.truncated,
    ranges: response.ranges.map((row) => decodeRangeResponseRow(row, response.names)),
  };
}

function expandGuzzlerHistoryResponse(
  response: CompactGuzzlerHistoryResponse,
): GuzzlerHistoryResponse {
  return {
    address: response.address,
    generatedAt: response.generatedAt,
    retentionMs: response.retentionMs,
    bucketMs: response.bucketMs,
    count: response.count,
    points: response.points.map((row) => decodeGuzzlerHistoryPointResponseRow(row, response.names)),
  };
}

function expandGuzzlersResponse(response: CompactGuzzlersResponse): GuzzlersResponse {
  return {
    generatedAt: response.generatedAt,
    retentionMs: response.retentionMs,
    limit: response.limit,
    windows: response.windows.map((window) => ({
      label: window.label,
      windowMs: window.windowMs,
      count: window.count,
      guzzlers: window.guzzlers.map((row) => decodeGuzzlerStatResponseRow(row, response.names)),
    })),
  };
}

function namesForBlockResponseRow(row: BlockResponseRow): readonly string[] {
  return latestBlockResponseNames.length === row.length ? latestBlockResponseNames : BLOCK_RESPONSE_NAMES;
}

function decodeBlockResponseRow(row: BlockResponseRow, names: readonly string[] = BLOCK_RESPONSE_NAMES): StoredBlock {
  const values = new Map<string, BlockResponseValue>();
  names.forEach((name, index) => values.set(name, row[index] ?? null));

  const block: StoredBlock = {
    blockNumber: numberValue(values.get("blockNumber") ?? null),
    blockDate: stringValue(values.get("blockDate") ?? null),
    blockTimeSeconds: stringValue(values.get("blockTimeSeconds") ?? null),
    baseBlockFeeWei: stringValue(values.get("baseBlockFeeWei") ?? null),
    totalGasUsed: stringValue(values.get("totalGasUsed") ?? null),
    totalInputDataSizeBytes: stringValue(values.get("totalInputDataSizeBytes") ?? null),
    totalInputDataCompressedSizeBytes: stringValue(
      values.get("totalInputDataCompressedSizeBytes") ?? null,
    ),
    maxGasInBlock: stringValue(values.get("maxGasInBlock") ?? null),
    transactionCount: numberValue(values.get("transactionCount") ?? null),
    averageFeePriceWei: stringValue(values.get("averageFeePriceWei") ?? null),
    averageTransactionFeeWei: stringValue(values.get("averageTransactionFeeWei") ?? null),
    averageTransactionGasUsed: stringValue(values.get("averageTransactionGasUsed") ?? null),
    averageTransactionInputDataSizeBytes: stringValue(
      values.get("averageTransactionInputDataSizeBytes") ?? null,
    ),
    averageTransactionInputDataCompressedSizeBytes: stringValue(
      values.get("averageTransactionInputDataCompressedSizeBytes") ?? null,
    ),
    averagePriorityFeeWeightedWei: stringValue(values.get("averagePriorityFeeWeightedWei") ?? null),
    averagePriorityFeeWei: stringValue(values.get("averagePriorityFeeWei") ?? null),
    batcherQueueSize: nullableString(values.get("batcherQueueSize") ?? null),
    batcherIntensity: nullableString(values.get("batcherIntensity") ?? null),
    batcherLowerThreshold: nullableString(values.get("batcherLowerThreshold") ?? null),
    batcherUpperThreshold: nullableString(values.get("batcherUpperThreshold") ?? null),
    batcherMaxBlockSize: nullableString(values.get("batcherMaxBlockSize") ?? null),
    batcherMaxTxSize: nullableString(values.get("batcherMaxTxSize") ?? null),
  };

  assignOptionalString(block, "blockRewardWei", values.get("blockRewardWei") ?? null);
  assignOptionalString(block, "burntFeesWei", values.get("burntFeesWei") ?? null);
  assignOptionalString(block, "totalTransactionFeeWei", values.get("totalTransactionFeeWei") ?? null);
  assignOptionalString(block, "feePriceSumWei", values.get("feePriceSumWei") ?? null);
  assignOptionalString(block, "priorityFeeSumWei", values.get("priorityFeeSumWei") ?? null);
  assignOptionalString(
    block,
    "priorityFeeWeightedNumeratorWei",
    values.get("priorityFeeWeightedNumeratorWei") ?? null,
  );
  assignOptionalString(
    block,
    "priorityFeeGasWeightedNumeratorWei",
    values.get("priorityFeeGasWeightedNumeratorWei") ?? null,
  );

  return block;
}

function decodeRangeResponseRow(
  row: RangeResponseRow,
  names: readonly string[] = RANGE_RESPONSE_NAMES,
): StoredBlockRange {
  const values = valuesByName(names, row);

  const range: StoredBlockRange = {
    rangeSize: numberValue(values.get("rangeSize") ?? null),
    rangeStart: numberValue(values.get("rangeStart") ?? null),
    rangeEnd: numberValue(values.get("rangeEnd") ?? null),
    minBlockDate: stringValue(values.get("minBlockDate") ?? null),
    maxBlockDate: stringValue(values.get("maxBlockDate") ?? null),
    averageBlockTimeSeconds: stringValue(values.get("averageBlockTimeSeconds") ?? null),
    minBlockTimeSeconds: stringValue(values.get("minBlockTimeSeconds") ?? null),
    maxBlockTimeSeconds: stringValue(values.get("maxBlockTimeSeconds") ?? null),
    minBaseFeeWei: stringValue(values.get("minBaseFeeWei") ?? null),
    maxBaseFeeWei: stringValue(values.get("maxBaseFeeWei") ?? null),
    averageBaseFeeWei: stringValue(values.get("averageBaseFeeWei") ?? null),
    averageFeePriceWei: stringValue(values.get("averageFeePriceWei") ?? null),
    averagePriorityFeeWei: stringValue(values.get("averagePriorityFeeWei") ?? null),
    averagePriorityFeeWeightedWei: stringValue(
      values.get("averagePriorityFeeWeightedWei") ?? null,
    ),
    averageTransactionGasUsed: stringValue(values.get("averageTransactionGasUsed") ?? null),
    averageTransactionInputDataSizeBytes: stringValue(
      values.get("averageTransactionInputDataSizeBytes") ?? null,
    ),
    averageTransactionInputDataCompressedSizeBytes: stringValue(
      values.get("averageTransactionInputDataCompressedSizeBytes") ?? null,
    ),
    totalBlockRewardWei: stringValue(values.get("totalBlockRewardWei") ?? null),
    totalBurntFeesWei: stringValue(values.get("totalBurntFeesWei") ?? null),
    averageBlockRewardWei: stringValue(values.get("averageBlockRewardWei") ?? null),
    averageBurntFeesWei: stringValue(values.get("averageBurntFeesWei") ?? null),
    transactionCount: numberValue(values.get("transactionCount") ?? null),
    totalGasUsed: stringValue(values.get("totalGasUsed") ?? null),
    averageTotalGasUsed: stringValue(values.get("averageTotalGasUsed") ?? null),
    minTotalGasUsed: stringValue(values.get("minTotalGasUsed") ?? null),
    maxTotalGasUsed: stringValue(values.get("maxTotalGasUsed") ?? null),
    totalInputDataSizeBytes: stringValue(values.get("totalInputDataSizeBytes") ?? null),
    averageTotalInputDataSizeBytes: stringValue(values.get("averageTotalInputDataSizeBytes") ?? null),
    minTotalInputDataSizeBytes: stringValue(values.get("minTotalInputDataSizeBytes") ?? null),
    maxTotalInputDataSizeBytes: stringValue(values.get("maxTotalInputDataSizeBytes") ?? null),
    totalInputDataCompressedSizeBytes: stringValue(
      values.get("totalInputDataCompressedSizeBytes") ?? null,
    ),
    averageTotalInputDataCompressedSizeBytes: stringValue(
      values.get("averageTotalInputDataCompressedSizeBytes") ?? null,
    ),
    minTotalInputDataCompressedSizeBytes: stringValue(
      values.get("minTotalInputDataCompressedSizeBytes") ?? null,
    ),
    maxTotalInputDataCompressedSizeBytes: stringValue(
      values.get("maxTotalInputDataCompressedSizeBytes") ?? null,
    ),
    totalMaxGas: stringValue(values.get("totalMaxGas") ?? null),
    minMaxGasInBlock: stringValue(values.get("minMaxGasInBlock") ?? null),
    maxMaxGasInBlock: stringValue(values.get("maxMaxGasInBlock") ?? null),
    minBatcherQueueSize: nullableString(values.get("minBatcherQueueSize") ?? null),
    maxBatcherQueueSize: nullableString(values.get("maxBatcherQueueSize") ?? null),
    averageBatcherQueueSize: nullableString(values.get("averageBatcherQueueSize") ?? null),
    averageBatcherIntensity: nullableString(values.get("averageBatcherIntensity") ?? null),
    averageBatcherLowerThreshold: nullableString(
      values.get("averageBatcherLowerThreshold") ?? null,
    ),
    averageBatcherUpperThreshold: nullableString(
      values.get("averageBatcherUpperThreshold") ?? null,
    ),
    averageBatcherMaxBlockSize: nullableString(values.get("averageBatcherMaxBlockSize") ?? null),
    averageBatcherMaxTxSize: nullableString(values.get("averageBatcherMaxTxSize") ?? null),
  };

  return range;
}

function decodeGuzzlerHistoryPointResponseRow(
  row: GuzzlerHistoryPointResponseRow,
  names: readonly string[] = GUZZLER_HISTORY_POINT_RESPONSE_NAMES,
): GuzzlerHistoryPoint {
  const values = valuesByName(names, row);
  return {
    minute: numberValue(values.get("minute") ?? null),
    startTime: stringValue(values.get("startTime") ?? null),
    transactionCount: numberValue(values.get("transactionCount") ?? null),
    totalGasUsed: stringValue(values.get("totalGasUsed") ?? null),
    totalFeeWei: stringValue(values.get("totalFeeWei") ?? null),
    firstSeen: stringValue(values.get("firstSeen") ?? null),
    lastSeen: stringValue(values.get("lastSeen") ?? null),
  };
}

function decodeGuzzlerStatResponseRow(
  row: GuzzlerStatResponseRow,
  names: readonly string[] = GUZZLER_STAT_RESPONSE_NAMES,
): GuzzlerStat {
  const values = valuesByName(names, row);
  return {
    address: stringValue(values.get("address") ?? null),
    transactionCount: numberValue(values.get("transactionCount") ?? null),
    totalGasUsed: stringValue(values.get("totalGasUsed") ?? null),
    totalFeeWei: stringValue(values.get("totalFeeWei") ?? null),
    firstSeen: stringValue(values.get("firstSeen") ?? null),
    lastSeen: stringValue(values.get("lastSeen") ?? null),
  };
}

function valuesByName<T extends number | string | null>(
  names: readonly string[],
  row: readonly T[],
): Map<string, T | null> {
  const values = new Map<string, T | null>();
  names.forEach((name, index) => values.set(name, row[index] ?? null));
  return values;
}

function assignOptionalString(
  block: StoredBlock,
  name: Extract<
    BlockResponseName,
    | "blockRewardWei"
    | "burntFeesWei"
    | "totalTransactionFeeWei"
    | "feePriceSumWei"
    | "priorityFeeSumWei"
    | "priorityFeeWeightedNumeratorWei"
    | "priorityFeeGasWeightedNumeratorWei"
  >,
  value: BlockResponseValue,
): void {
  if (value !== null) {
    block[name] = stringValue(value);
  }
}

function numberValue(value: BlockResponseValue): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function stringValue(value: BlockResponseValue): string {
  return value === null ? "" : String(value);
}

function nullableString(value: BlockResponseValue): string | null {
  return value === null ? null : String(value);
}

async function fetchJsonWithDebug<T>(
  url: string,
  debugObserver: BlockRequestDebugObserver,
): Promise<T> {
  const startedAt = nowMs();
  let response: Response | null = null;
  let text = "";
  try {
    response = await fetch(url);
    text = await response.text();
    const durationMs = nowMs() - startedAt;
    if (!response.ok) {
      debugObserver({
        ok: false,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    try {
      const body = JSON.parse(text) as T;
      debugObserver({
        ok: true,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      return body;
    } catch (error) {
      debugObserver({
        ok: false,
        status: response.status,
        durationMs,
        transferredBytes: byteLength(text),
      });
      throw error;
    }
  } catch (error) {
    if (response === null) {
      debugObserver({
        ok: false,
        status: null,
        durationMs: nowMs() - startedAt,
        transferredBytes: 0,
      });
    }
    throw error;
  }
}

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function fetchRanges(params: URLSearchParams): Promise<RangesResponse> {
  return getJson<CompactRangesResponse>("/ranges", params).then(expandRangesResponse);
}

export async function fetchBlockInspect(blockNumber: string): Promise<BlockInspectResponse> {
  const block = await fetchBlockByNumber(blockNumber);
  if (!block) {
    throw new Error(`Block ${blockNumber} was not found in storage`);
  }

  return inspectStoredBlock(block, blockNumber);
}

export async function fetchLatestBlockInspect(): Promise<BlockInspectResponse> {
  const params = new URLSearchParams({ limit: "1" });
  const response = await fetchBlocks(params);
  const [latestBlock] = response.blocks;
  if (!latestBlock) {
    throw new Error("No blocks were found in storage");
  }

  return inspectStoredBlock(latestBlock, String(latestBlock.blockNumber));
}

async function inspectStoredBlock(block: StoredBlock, blockNumber: string): Promise<BlockInspectResponse> {
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

export interface TransactionByHashResponse {
  transaction: StoredTransaction;
}

export async function fetchTransactionByHash(hash: string): Promise<StoredTransaction | null> {
  const response = await fetch(`/api/transaction/${encodeURIComponent(hash)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  const body = (await response.json()) as TransactionByHashResponse;
  return body.transaction;
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

/** Cheap poll for the scanner sync banner; `/health` is too heavy to poll. */
export function fetchSyncStatus(): Promise<SyncStatusResponse> {
  return getJson<SyncStatusResponse>("/sync", new URLSearchParams());
}

export function fetchGuzzlers(limit?: number, window?: string): Promise<GuzzlersResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) {
    params.set("limit", String(limit));
  }
  if (window !== undefined) {
    params.set("window", window);
  }
  return getJson<CompactGuzzlersResponse>("/guzzlers", params).then(expandGuzzlersResponse);
}

export function fetchGuzzlerHistory(address: string): Promise<GuzzlerHistoryResponse> {
  return getJson<CompactGuzzlerHistoryResponse>(
    `/guzzler/${encodeURIComponent(address)}`,
    new URLSearchParams(),
  ).then(expandGuzzlerHistoryResponse);
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
