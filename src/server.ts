import { readFile } from "node:fs/promises";
import { DEFAULT_RANGE_SIZE, parseRangeSize } from "./ranges";
import { type ArkivOperationSummaryEntry } from "./arkivOperations";
import { type BlockInspectionResult } from "./blockInspector";
import {
  DEFAULT_GUZZLER_LIMIT,
  GUZZLER_WINDOWS,
  MAX_GUZZLER_LIMIT,
  buildGuzzlerHistory,
  emptyLeaderboards,
  sliceLeaderboards,
  type GuzzlerHistory,
  type GuzzlerHistoryPoint,
  type GuzzlerLeaderboards,
  type GuzzlerStat,
  type GuzzlerStore,
  type GuzzlerWindow,
  type GuzzlerWindowLeaderboard,
} from "./guzzlers";
import { type BaseloadRuntime, type BaseloadState } from "./baseloadRuntime";
import { normalizeBaseloadConfig } from "./baseloadConfig";
import { readBuildInfo, type BuildInfo } from "./buildInfo";
import { computeSyncStatus, type SyncStatus } from "./syncStatus";
import {
  buildPayloadProviderPaymentBreakdown,
  PayloadProviderPaymentResolver,
  type PayloadProviderPaymentBreakdown,
} from "./payloadProviderPayments";
import { ResponseCache, type CachedResponse } from "./responseCache";
import {
  DEFAULT_ENTITY_HISTORY_LIMIT,
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  MAX_SENDERS_PER_QUERY,
  DEFAULT_TRANSACTION_RECORDS_PER_CATEGORY,
  MAX_TRANSACTIONS_PER_QUERY,
  ScannerStorage,
  type BlockQueryFilter,
  type BlockRangeQueryFilter,
  type DatabaseStats,
  type QueryOrder,
  type SenderStatsQueryFilter,
  type StoredBlock,
  type StoredBlockRange,
  type StoredBaseloadConfig,
  type StoredBaseloadConfigSummary,
  type StoredEntityOperation,
  type StoredSenderStats,
  type StoredTransaction,
  type StoredTransactionRecord,
  type StoredTransactionRecordsByCategory,
  type TransactionQueryFilter,
  type TransactionRecordsQueryFilter,
} from "./storage";

export interface BlockServerOptions {
  port?: number;
  hostname?: string;
  transactionDataEnabled?: boolean;
  baseloadRuntime?: BaseloadRuntime;
  baseloadAdminBearerToken?: string;
  guzzlerStore?: GuzzlerStore;
  payloadProviderPaymentResolver?: PayloadProviderPaymentResolver;
  /**
   * Bounded cache for /entity/:entityKey responses. Omitted (e.g. in most
   * tests) the endpoint hits storage on every request; serve.ts always
   * provides one, wired to storage's entity-operation invalidation channel.
   */
  entityHistoryCache?: ResponseCache;
  /** Most-recent operations returned per entity; defaults to 100. */
  entityHistoryLimit?: number;
  /**
   * Bounded cache for /blocks and /ranges responses, keyed by query string
   * and encoding. serve.ts clears it whenever a block-stored notification
   * arrives; a short TTL backstops missed notifications.
   */
  listCache?: ResponseCache;
  /**
   * Actively precomputed /sync response (recomputed on every stored block
   * plus a periodic refresh). When it has a value, /sync serves it with zero
   * storage work; otherwise the handler computes on demand.
   */
  syncStatusProvider?: { get(): CachedResponse | null };
}

export interface BlocksResponseBody {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    blockGt: string | null;
    blockLt: string | null;
    dateGt: string | null;
    dateLt: string | null;
  };
  names: typeof BLOCK_RESPONSE_NAMES;
  blocks: BlockResponseRow[];
}

export interface RangesResponseBody {
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
  names: typeof RANGE_RESPONSE_NAMES;
  ranges: RangeResponseRow[];
}

export interface TransactionsResponseBody {
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
  names: typeof TRANSACTION_RESPONSE_NAMES;
  transactions: TransactionResponseRow[];
}

export interface TransactionByHashResponseBody {
  transaction: StoredTransaction & {
    payloadProviderPayments?: PayloadProviderPaymentBreakdown;
  };
}

export interface EntityByKeyResponseBody {
  entityKey: string;
  /** Number of operations in `operations` (the returned slice). */
  count: number;
  /** Total stored operations for the key, including ones outside the slice. */
  totalOperations: number;
  /** True when older operations were cut off by the history limit. */
  truncated: boolean;
  /** Field order for the compact `operations` / `firstOperation` rows. */
  names: typeof ENTITY_OPERATION_RESPONSE_NAMES;
  /** Most recent operations in chain order, capped at the history limit. */
  operations: EntityOperationResponseRow[];
  /** Earliest stored operation; present only when `truncated`. */
  firstOperation?: EntityOperationResponseRow;
}

export interface TransactionRecordsResponseBody {
  limit: number;
  names: typeof TRANSACTION_RECORD_RESPONSE_NAMES;
  records: {
    [Category in keyof StoredTransactionRecordsByCategory]: TransactionRecordResponseRow[];
  };
}

export interface SendersResponseBody {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    order: QueryOrder;
  };
  names: typeof SENDER_STATS_RESPONSE_NAMES;
  senders: SenderStatsResponseRow[];
}

export interface GuzzlersResponseBody {
  generatedAt: string;
  /** How long buckets are retained - equal to the largest window. */
  retentionMs: number;
  /** The top-N cut applied to each window. */
  limit: number;
  names: typeof GUZZLER_STAT_RESPONSE_NAMES;
  windows: GuzzlerWindowLeaderboardResponseRow[];
}

export interface GuzzlerWindowLeaderboardResponseRow {
  label: string;
  windowMs: number;
  count: number;
  guzzlers: GuzzlerStatResponseRow[];
}

export type GuzzlerHistoryResponseBody = Omit<GuzzlerHistory, "points"> & {
  names: typeof GUZZLER_HISTORY_POINT_RESPONSE_NAMES;
  points: GuzzlerHistoryPointResponseRow[];
};

export interface BaseloadConfigsResponseBody {
  configs: StoredBaseloadConfigSummary[];
}

export type BaseloadConfigResponseBody = StoredBaseloadConfig;

export type BlockInspectResponseBody = BlockInspectionResult;

export interface HealthResponseBody {
  ok: boolean;
  serverTimeUtc: string;
  build: BuildInfo;
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
  /** Same payload as `GET /sync`. */
  sync: SyncStatus;
  database: DatabaseStats;
  features: {
    transactionData: boolean;
    guzzlers: boolean;
  };
  guzzlers: {
    enabled: boolean;
    /** Number of senders held in the Redis cache, or null when disabled/unavailable. */
    entryCount: number | null;
    /** Number of one-minute buckets held in the cached leaderboard snapshot, or null. */
    bucketCount: number | null;
    /** ISO timestamp for the oldest cached bucket start, or null. */
    oldestBucket: string | null;
    /** ISO timestamp for the newest cached bucket start, or null. */
    newestBucket: string | null;
    /** Approximate total size of the cached entries in bytes, or null. */
    totalSizeBytes: string | null;
  };
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

export type RangeResponseValue = number | string | null;
export type RangeResponseRow = RangeResponseValue[];

export const GUZZLER_STAT_RESPONSE_NAMES = [
  "address",
  "transactionCount",
  "totalGasUsed",
  "totalFeeWei",
  "firstSeen",
  "lastSeen",
] as const satisfies readonly (keyof GuzzlerStat)[];

export type GuzzlerStatResponseValue = number | string | null;
export type GuzzlerStatResponseRow = GuzzlerStatResponseValue[];

export const GUZZLER_HISTORY_POINT_RESPONSE_NAMES = [
  "minute",
  "startTime",
  "transactionCount",
  "totalGasUsed",
  "totalFeeWei",
  "firstSeen",
  "lastSeen",
] as const satisfies readonly (keyof GuzzlerHistoryPoint)[];

export type GuzzlerHistoryPointResponseValue = number | string | null;
export type GuzzlerHistoryPointResponseRow = GuzzlerHistoryPointResponseValue[];

/** Flat stored-transaction fields shared by /transactions and /transaction-records rows. */
const TRANSACTION_RESPONSE_BASE_NAMES = [
  "blockNumber",
  "blockNumberDecimal",
  "blockDate",
  "baseBlockFeeWei",
  "position",
  "hash",
  "from",
  "to",
  "type",
  "nonce",
  "valueWei",
  "gasLimit",
  "gasUsed",
  "inputDataSizeBytes",
  "inputDataCompressedSizeBytes",
  "cumulativeGasUsed",
  "gasPriceWei",
  "maxFeePerGasWei",
  "maxPriorityFeePerGasWei",
  "effectiveGasPriceWei",
  "priorityFeeWei",
  "transactionFeeWei",
  "status",
  "contractAddress",
] as const satisfies readonly (keyof StoredTransaction)[];

export const TRANSACTION_RESPONSE_NAMES = [
  ...TRANSACTION_RESPONSE_BASE_NAMES,
  "operationsSummary",
] as const satisfies readonly (keyof StoredTransaction)[];

export type TransactionResponseName = (typeof TRANSACTION_RESPONSE_NAMES)[number];
export type TransactionResponseValue =
  | Exclude<StoredTransaction[TransactionResponseName], undefined>
  | null;
export type TransactionResponseRow = TransactionResponseValue[];

export function transactionToResponseRow(transaction: StoredTransaction): TransactionResponseRow {
  return TRANSACTION_RESPONSE_NAMES.map((name) => transaction[name] ?? null);
}

export const TRANSACTION_RECORD_RESPONSE_NAMES = [
  ...TRANSACTION_RESPONSE_BASE_NAMES,
  "category",
  "recordValue",
  "rank",
  "recordedAt",
] as const satisfies readonly (keyof StoredTransactionRecord)[];

export type TransactionRecordResponseName = (typeof TRANSACTION_RECORD_RESPONSE_NAMES)[number];
export type TransactionRecordResponseValue =
  | Exclude<StoredTransactionRecord[TransactionRecordResponseName], undefined>
  | null;
export type TransactionRecordResponseRow = TransactionRecordResponseValue[];

export function transactionRecordToResponseRow(
  record: StoredTransactionRecord,
): TransactionRecordResponseRow {
  return TRANSACTION_RECORD_RESPONSE_NAMES.map((name) => record[name] ?? null);
}

export const SENDER_STATS_RESPONSE_NAMES = [
  "address",
  "latestNonce",
  "transactionCount",
  "totalGasUsed",
  "totalTransactionFeeWei",
  "totalValueWei",
  "averageGasUsed",
  "averageTransactionFeeWei",
  "firstBlockNumber",
  "firstBlockNumberDecimal",
  "lastBlockNumber",
  "lastBlockNumberDecimal",
  "firstBlockDate",
  "lastBlockDate",
  "aggregatedAt",
] as const satisfies readonly (keyof StoredSenderStats)[];

export type SenderStatsResponseName = (typeof SENDER_STATS_RESPONSE_NAMES)[number];
export type SenderStatsResponseValue = number | string | null;
export type SenderStatsResponseRow = SenderStatsResponseValue[];

export function senderStatsToResponseRow(sender: StoredSenderStats): SenderStatsResponseRow {
  return SENDER_STATS_RESPONSE_NAMES.map((name) => sender[name] ?? null);
}

export const ENTITY_OPERATION_RESPONSE_NAMES = [
  "blockNumber",
  "blockNumberDecimal",
  "blockDate",
  "position",
  "hash",
  "opIndex",
  "operationType",
  "operation",
  "entityKey",
  "contentType",
  "payloadSizeBytes",
  "attributes",
  "expiresAtBlocks",
  "newOwner",
  "isReference",
  "payloadReference",
  "referenceVerification",
  "referenceError",
] as const satisfies readonly (keyof StoredEntityOperation)[];

export type EntityOperationResponseName = (typeof ENTITY_OPERATION_RESPONSE_NAMES)[number];
export type EntityOperationResponseValue =
  | Exclude<StoredEntityOperation[EntityOperationResponseName], undefined>
  | null;
export type EntityOperationResponseRow = EntityOperationResponseValue[];

export function entityOperationToResponseRow(
  operation: StoredEntityOperation,
): EntityOperationResponseRow {
  return ENTITY_OPERATION_RESPONSE_NAMES.map((name) => operation[name] ?? null);
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};
const LLMS_TXT_FILE = new URL("../llms.txt", import.meta.url);

export function createBlockServer(storage: ScannerStorage, options: BlockServerOptions = {}) {
  const transactionDataEnabled = options.transactionDataEnabled ?? true;
  const serveOptions: { port: number; fetch: (request: Request) => Promise<Response>; hostname?: string } = {
    port: options.port ?? 0,
    fetch: (request) =>
      handleRequest(request, storage, {
        transactionDataEnabled,
        ...(options.baseloadRuntime ? { baseloadRuntime: options.baseloadRuntime } : {}),
        ...(options.baseloadAdminBearerToken !== undefined
          ? { baseloadAdminBearerToken: options.baseloadAdminBearerToken }
          : {}),
        ...(options.guzzlerStore ? { guzzlerStore: options.guzzlerStore } : {}),
        ...(options.payloadProviderPaymentResolver
          ? { payloadProviderPaymentResolver: options.payloadProviderPaymentResolver }
          : {}),
        ...(options.entityHistoryCache ? { entityHistoryCache: options.entityHistoryCache } : {}),
        ...(options.entityHistoryLimit !== undefined
          ? { entityHistoryLimit: options.entityHistoryLimit }
          : {}),
        ...(options.listCache ? { listCache: options.listCache } : {}),
        ...(options.syncStatusProvider ? { syncStatusProvider: options.syncStatusProvider } : {}),
      }),
  };
  if (options.hostname !== undefined) {
    serveOptions.hostname = options.hostname;
  }
  return Bun.serve(serveOptions);
}

export async function handleRequest(
  request: Request,
  storage: ScannerStorage,
  options: BlockServerOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const transactionDataEnabled = options.transactionDataEnabled ?? true;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (url.pathname === "/admin/verify") {
    return handleAdminVerifyRequest(request, options.baseloadAdminBearerToken);
  }

  if (url.pathname === "/baseload") {
    return handleBaseloadRequest(request, options.baseloadRuntime, options.baseloadAdminBearerToken);
  }

  if (url.pathname === "/baseload/configs" || url.pathname.startsWith("/baseload/configs/")) {
    return handleBaseloadConfigsRequest(
      request,
      url,
      storage,
      options.baseloadRuntime,
      options.baseloadAdminBearerToken,
    );
  }

  if (request.method !== "GET") {
    return jsonError(405, `Method ${request.method} is not allowed`);
  }

  if (url.pathname === "/llms.txt") {
    return handleGetLlmsTxt();
  }

  if (url.pathname === "/health") {
    return handleGetHealth(storage, transactionDataEnabled, options.guzzlerStore);
  }

  if (url.pathname === "/sync") {
    return handleGetSyncStatus(storage, options);
  }

  if (url.pathname === "/guzzlers") {
    return handleGetGuzzlers(request, url, options.guzzlerStore);
  }

  const guzzlerHistoryMatch = url.pathname.match(/^\/guzzler\/(.+)$/);
  if (guzzlerHistoryMatch?.[1]) {
    return handleGetGuzzlerHistory(decodeURIComponent(guzzlerHistoryMatch[1]), options.guzzlerStore);
  }

  if (url.pathname === "/blocks") {
    return handleGetBlocks(request, url, storage, options);
  }

  const singleBlockMatch = url.pathname.match(/^\/blocks\/(\d+)$/);
  if (singleBlockMatch?.[1]) {
    return handleGetBlockByNumber(singleBlockMatch[1], storage);
  }

  const blockInspectMatch = url.pathname.match(/^\/block\/(\d+)$/);
  if (blockInspectMatch?.[1]) {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetBlockInspect(blockInspectMatch[1], storage);
  }

  if (url.pathname === "/ranges") {
    return handleGetRanges(request, url, storage, options);
  }

  if (url.pathname === "/transactions") {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetTransactions(request, url, storage);
  }

  const transactionByHashMatch = url.pathname.match(/^\/transaction\/(0x[0-9a-fA-F]{64})$/);
  if (transactionByHashMatch?.[1]) {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetTransactionByHash(
      transactionByHashMatch[1],
      storage,
      options.payloadProviderPaymentResolver,
    );
  }

  const entityByKeyMatch = url.pathname.match(/^\/entity\/(0x[0-9a-fA-F]{64})$/);
  if (entityByKeyMatch?.[1]) {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetEntityByKey(entityByKeyMatch[1], storage, options);
  }

  if (url.pathname === "/transaction-records") {
    return handleGetTransactionRecords(request, url, storage);
  }

  if (url.pathname === "/senders") {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetSenders(request, url, storage);
  }

  return jsonError(404, `Not found: ${url.pathname}`);
}

async function handleBaseloadRequest(
  request: Request,
  baseloadRuntime: BaseloadRuntime | undefined,
  adminBearerToken: string | undefined,
): Promise<Response> {
  if (!baseloadRuntime) {
    return jsonError(503, "Baseload runtime is unavailable");
  }

  if (request.method === "GET") {
    return jsonResponse(baseloadRuntime.getState() satisfies BaseloadState);
  }

  if (request.method === "PUT") {
    const authError = requireAdminBearerToken(request, adminBearerToken);
    if (authError) return authError;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "Request body must be valid JSON");
    }

    try {
      return jsonResponse(baseloadRuntime.updateConfig(body) satisfies BaseloadState);
    } catch (error) {
      return jsonError(400, error instanceof Error ? error.message : String(error));
    }
  }

  return jsonError(405, `Method ${request.method} is not allowed`);
}

async function handleBaseloadConfigsRequest(
  request: Request,
  url: URL,
  storage: ScannerStorage,
  baseloadRuntime: BaseloadRuntime | undefined,
  adminBearerToken: string | undefined,
): Promise<Response> {
  const authError = requireAdminBearerToken(request, adminBearerToken);
  if (authError) return authError;

  if (url.pathname === "/baseload/configs") {
    if (request.method !== "GET") {
      return jsonError(405, `Method ${request.method} is not allowed`);
    }
    return jsonResponse({
      configs: await storage.listBaseloadConfigs(),
    } satisfies BaseloadConfigsResponseBody);
  }

  const loadMatch = url.pathname.match(/^\/baseload\/configs\/([^/]+)\/load$/);
  if (loadMatch?.[1]) {
    if (request.method !== "PUT") {
      return jsonError(405, `Method ${request.method} is not allowed`);
    }
    if (!baseloadRuntime) {
      return jsonError(503, "Baseload runtime is unavailable");
    }
    let name: string;
    try {
      name = parseBaseloadConfigName(loadMatch[1]);
    } catch (error) {
      return jsonError(400, error instanceof Error ? error.message : String(error));
    }
    const saved = await storage.getBaseloadConfig(name);
    if (!saved) {
      return jsonError(404, `Baseload config ${name} was not found`);
    }
    try {
      return jsonResponse(baseloadRuntime.updateConfig(saved.config) satisfies BaseloadState);
    } catch (error) {
      return jsonError(400, error instanceof Error ? error.message : String(error));
    }
  }

  const configMatch = url.pathname.match(/^\/baseload\/configs\/([^/]+)$/);
  if (!configMatch?.[1]) {
    return jsonError(404, `Not found: ${url.pathname}`);
  }
  let name: string;
  try {
    name = parseBaseloadConfigName(configMatch[1]);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  if (request.method === "GET") {
    const saved = await storage.getBaseloadConfig(name);
    if (!saved) {
      return jsonError(404, `Baseload config ${name} was not found`);
    }
    return jsonResponse(saved satisfies BaseloadConfigResponseBody);
  }

  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "Request body must be valid JSON");
    }

    try {
      const config = baseloadRuntime
        ? baseloadRuntime.normalizeConfig(body)
        : normalizeBaseloadConfig(body);
      return jsonResponse(await storage.saveBaseloadConfig(name, config));
    } catch (error) {
      return jsonError(400, error instanceof Error ? error.message : String(error));
    }
  }

  if (request.method === "DELETE") {
    return jsonResponse({ deleted: await storage.deleteBaseloadConfig(name) });
  }

  return jsonError(405, `Method ${request.method} is not allowed`);
}

async function handleAdminVerifyRequest(
  request: Request,
  adminBearerToken: string | undefined,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonError(405, `Method ${request.method} is not allowed`);
  }
  if (!adminBearerToken) {
    return jsonError(503, "Admin bearer token is not configured on the backend");
  }
  const authError = requireAdminBearerToken(request, adminBearerToken);
  if (authError) return authError;
  return jsonResponse({ authorized: true });
}

function requireAdminBearerToken(request: Request, adminBearerToken: string | undefined): Response | null {
  if (!adminBearerToken) return null;

  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return jsonError(401, "Admin bearer token is required");
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return jsonError(401, "Authorization header must use Bearer token");
  }

  if (match[1] !== adminBearerToken) {
    return jsonError(403, "Admin bearer token is invalid");
  }

  return null;
}

async function handleGetHealth(
  storage: ScannerStorage,
  transactionDataEnabled: boolean,
  guzzlerStore: GuzzlerStore | undefined,
): Promise<Response> {
  const guzzlers = await readGuzzlerCacheHealth(guzzlerStore);
  const now = new Date();
  const [progress, samples, database] = await Promise.all([
    storage.getScannerProgress(),
    storage.getForwardScanSamples(),
    storage.getDatabaseStats(),
  ]);
  const sync = computeSyncStatus({ now, ...progress, samples });
  const lastBlockAgeSeconds = secondsBetween(now, progress.lastSuccessfulBlockDate);
  const latestObservationAgeSeconds = secondsBetween(now, progress.latestObservedAt);
  const headLagBlocks =
    progress.latestObservedBlock !== undefined && progress.lastSuccessfulBlock !== undefined
      ? clampLag(progress.latestObservedBlock - progress.lastSuccessfulBlock)
      : null;
  const safeHeadLagBlocks =
    progress.safeHeadBlock !== undefined && progress.lastSuccessfulBlock !== undefined
      ? clampLag(progress.safeHeadBlock - progress.lastSuccessfulBlock)
      : null;

  const body: HealthResponseBody = {
    ok: true,
    serverTimeUtc: now.toISOString(),
    build: readBuildInfo(),
    scanner: {
      lastSuccessfulBlock: progress.lastSuccessfulBlock?.toString() ?? null,
      lastSuccessfulBlockDate: progress.lastSuccessfulBlockDate ?? null,
      lastSuccessfulScannedAtUtc: progress.lastSuccessfulScannedAt ?? null,
      lastBlockAgeSeconds,
      backfillNextBlock: progress.backfillNextBlock?.toString() ?? null,
      latestObservedBlock: progress.latestObservedBlock?.toString() ?? null,
      safeHeadBlock: progress.safeHeadBlock?.toString() ?? null,
      latestObservedAtUtc: progress.latestObservedAt ?? null,
      latestObservationAgeSeconds,
      headLagBlocks,
      safeHeadLagBlocks,
    },
    sync,
    database,
    features: {
      transactionData: transactionDataEnabled,
      guzzlers: guzzlerStore !== undefined,
    },
    guzzlers,
  };

  return jsonResponse(body);
}

async function handleGetLlmsTxt(): Promise<Response> {
  try {
    const body = await readFile(LLMS_TXT_FILE, "utf8");
    return new Response(body, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

async function handleGetBlockByNumber(
  rawBlockNumber: string,
  storage: ScannerStorage,
): Promise<Response> {
  let blockNumber: bigint;
  try {
    blockNumber = parseBlockParam("blockNumber", rawBlockNumber);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const [block] = await storage.queryBlocks({
      blockGt: blockNumber - 1n,
      blockLt: blockNumber + 1n,
      limit: 1,
    });
    if (!block) {
      return jsonError(404, `Block ${blockNumber.toString()} was not found in storage`);
    }
    return jsonResponse(blockToResponseRow(block));
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

async function handleGetBlockInspect(
  rawBlockNumber: string,
  storage: ScannerStorage,
): Promise<Response> {
  let blockNumber: bigint;
  try {
    blockNumber = parseBlockParam("blockNumber", rawBlockNumber);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  try {
    const block = await storage.getInspectedBlock(blockNumber);
    if (!block) {
      return jsonError(404, `Block ${blockNumber.toString()} was not found in storage`);
    }
    return jsonResponse({ cached: false, block } satisfies BlockInspectResponseBody);
  } catch (error) {
    return jsonError(500, error instanceof Error ? error.message : String(error));
  }
}

async function handleGetBlocks(
  request: Request,
  url: URL,
  storage: ScannerStorage,
  options: BlockServerOptions,
): Promise<Response> {
  let filter: BlockQueryFilter;
  try {
    filter = parseFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  return cachedListResponse(request, url, options.listCache, async () => {
    const blocks = await storage.queryBlocks(filter);
    const effectiveLimit = Math.min(filter.limit ?? MAX_BLOCKS_PER_QUERY, MAX_BLOCKS_PER_QUERY);

    const body: BlocksResponseBody = {
      count: blocks.length,
      limit: effectiveLimit,
      truncated: blocks.length >= effectiveLimit,
      filters: {
        blockGt: filter.blockGt !== undefined ? filter.blockGt.toString() : null,
        blockLt: filter.blockLt !== undefined ? filter.blockLt.toString() : null,
        dateGt: filter.dateGt ?? null,
        dateLt: filter.dateLt ?? null,
      },
      names: BLOCK_RESPONSE_NAMES,
      blocks: blocks.map(blockToResponseRow),
    };
    return JSON.stringify(body);
  });
}

export function blockToResponseRow(block: StoredBlock): BlockResponseRow {
  return BLOCK_RESPONSE_NAMES.map((name) => block[name] ?? null);
}

async function handleGetRanges(
  request: Request,
  url: URL,
  storage: ScannerStorage,
  options: BlockServerOptions,
): Promise<Response> {
  let filter: BlockRangeQueryFilter;
  try {
    filter = parseRangeFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  return cachedListResponse(request, url, options.listCache, async () => {
    const ranges = await storage.queryBlockRanges(filter);
    const effectiveLimit = Math.min(filter.limit ?? MAX_RANGES_PER_QUERY, MAX_RANGES_PER_QUERY);

    const rangeSize = filter.rangeSize ?? DEFAULT_RANGE_SIZE;
    const body: RangesResponseBody = {
      count: ranges.length,
      limit: effectiveLimit,
      truncated: ranges.length >= effectiveLimit,
      filters: {
        rangeSize: rangeSize.toString(),
        rangeStartGt: filter.rangeStartGt !== undefined ? filter.rangeStartGt.toString() : null,
        rangeStartLt: filter.rangeStartLt !== undefined ? filter.rangeStartLt.toString() : null,
        dateGt: filter.dateGt ?? null,
        dateLt: filter.dateLt ?? null,
      },
      names: RANGE_RESPONSE_NAMES,
      ranges: ranges.map(rangeToResponseRow),
    };
    return JSON.stringify(body);
  });
}

export function rangeToResponseRow(range: StoredBlockRange): RangeResponseRow {
  return RANGE_RESPONSE_NAMES.map((name) => range[name] ?? null);
}

async function handleGetTransactions(
  request: Request,
  url: URL,
  storage: ScannerStorage,
): Promise<Response> {
  let filter: TransactionQueryFilter;
  try {
    filter = parseTransactionFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  const effectiveLimit = Math.min(
    filter.limit ?? MAX_TRANSACTIONS_PER_QUERY,
    MAX_TRANSACTIONS_PER_QUERY,
  );
  const page = filter.page ?? 1;
  if (!Number.isSafeInteger((page - 1) * effectiveLimit)) {
    return jsonError(400, "page is too large");
  }

  const [transactions, totalCount] = await Promise.all([
    storage.queryTransactions(filter),
    storage.countTransactions(filter),
  ]);
  const totalPages = Math.ceil(totalCount / effectiveLimit);
  const operationsSummaries: Map<string, ArkivOperationSummaryEntry[]> =
    transactions.length > 0
      ? await storage.getOperationsSummaryForTransactions(
          transactions.map((transaction) => ({
            blockNumber: transaction.blockNumberDecimal,
            position: transaction.position,
          })),
        )
      : new Map();

  const body: TransactionsResponseBody = {
    count: transactions.length,
    limit: effectiveLimit,
    truncated: page * effectiveLimit < totalCount,
    page,
    pageSize: effectiveLimit,
    totalCount,
    totalPages,
    hasPreviousPage: page > 1,
    hasNextPage: page < totalPages,
    filters: {
      block: filter.blockNumber !== undefined ? filter.blockNumber.toString() : null,
      blockGt: filter.blockGt !== undefined ? filter.blockGt.toString() : null,
      blockLt: filter.blockLt !== undefined ? filter.blockLt.toString() : null,
      address: filter.fromAddress ?? null,
      nonceGt: filter.nonceGt !== undefined ? filter.nonceGt.toString() : null,
      nonceLt: filter.nonceLt !== undefined ? filter.nonceLt.toString() : null,
      dateGt: filter.dateGt ?? null,
      dateLt: filter.dateLt ?? null,
    },
    names: TRANSACTION_RESPONSE_NAMES,
    transactions: transactions.map((transaction) => {
      const operationsSummary = operationsSummaries.get(
        `${transaction.blockNumberDecimal}:${transaction.position}`,
      );
      return transactionToResponseRow(
        operationsSummary ? { ...transaction, operationsSummary } : transaction,
      );
    }),
  };

  return compressedJsonResponse(request, body);
}

async function handleGetTransactionByHash(
  hash: string,
  storage: ScannerStorage,
  payloadProviderPaymentResolver?: PayloadProviderPaymentResolver,
): Promise<Response> {
  const transaction = await storage.getTransactionByHash(hash);
  if (!transaction) {
    return jsonError(404, `Transaction ${hash} was not found in storage`);
  }
  const operations = await storage.getOperationsByHash(hash);
  let payloadProviderPayments: PayloadProviderPaymentBreakdown | null = null;
  if (payloadProviderPaymentResolver) {
    const resolved = await payloadProviderPaymentResolver.resolve(transaction.blockNumberDecimal);
    payloadProviderPayments = buildPayloadProviderPaymentBreakdown(
      operations,
      resolved.params,
      resolved.source,
      transaction.baseBlockFeeWei,
    );
  } else {
    payloadProviderPayments = buildPayloadProviderPaymentBreakdown(
      operations,
      null,
      "unconfigured",
      transaction.baseBlockFeeWei,
    );
  }
  return jsonResponse({
    transaction: {
      ...transaction,
      operations,
      ...(payloadProviderPayments ? { payloadProviderPayments } : {}),
    },
  } satisfies TransactionByHashResponseBody);
}

async function handleGetEntityByKey(
  entityKey: string,
  storage: ScannerStorage,
  options: BlockServerOptions,
): Promise<Response> {
  // Cache keys must be pre-normalized: the cache stores keys verbatim, and
  // the storage NOTIFY payloads that drive invalidation are lowercase.
  const normalized = entityKey.toLowerCase();
  const limit = options.entityHistoryLimit ?? DEFAULT_ENTITY_HISTORY_LIMIT;
  const loader = () => buildEntityByKeyResponse(normalized, storage, limit);
  // Not-found responses are cached too: the create NOTIFY evicts them the
  // moment the entity appears in storage.
  const cached = options.entityHistoryCache
    ? await options.entityHistoryCache.load(normalized, loader)
    : await loader();
  return responseFromCached(cached);
}

async function buildEntityByKeyResponse(
  normalizedEntityKey: string,
  storage: ScannerStorage,
  limit: number,
): Promise<CachedResponse> {
  const history = await storage.getEntityOperationHistory(normalizedEntityKey, limit);
  if (history.totalOperations === 0) {
    return {
      status: 404,
      body: JSON.stringify({
        error: `No operations for entity ${normalizedEntityKey} were found in storage`,
      }),
    };
  }
  const responseBody: EntityByKeyResponseBody = {
    entityKey: normalizedEntityKey,
    count: history.operations.length,
    totalOperations: history.totalOperations,
    truncated: history.totalOperations > history.operations.length,
    names: ENTITY_OPERATION_RESPONSE_NAMES,
    operations: history.operations.map(entityOperationToResponseRow),
    ...(history.firstOperation
      ? { firstOperation: entityOperationToResponseRow(history.firstOperation) }
      : {}),
  };
  return { status: 200, body: JSON.stringify(responseBody) };
}

async function handleGetTransactionRecords(
  request: Request,
  url: URL,
  storage: ScannerStorage,
): Promise<Response> {
  let filter: TransactionRecordsQueryFilter;
  try {
    filter = parseTransactionRecordsFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  const limit = Math.min(
    filter.limit ?? DEFAULT_TRANSACTION_RECORDS_PER_CATEGORY,
    DEFAULT_TRANSACTION_RECORDS_PER_CATEGORY,
  );

  const records = await storage.queryTransactionRecords({ limit });
  const body: TransactionRecordsResponseBody = {
    limit,
    names: TRANSACTION_RECORD_RESPONSE_NAMES,
    records: {
      gas_used: records.gas_used.map(transactionRecordToResponseRow),
      transaction_fee: records.transaction_fee.map(transactionRecordToResponseRow),
      effective_fee: records.effective_fee.map(transactionRecordToResponseRow),
    },
  };

  return compressedJsonResponse(request, body);
}

export interface SyncStatusResponseBody {
  ok: boolean;
  serverTimeUtc: string;
  sync: SyncStatus;
}

/**
 * Cheap, dedicated sync-progress endpoint. `/health` carries the same payload
 * but also walks the per-table database statistics, which is too heavy for the
 * frontend banner to poll every few seconds.
 */
async function handleGetSyncStatus(
  storage: ScannerStorage,
  options: BlockServerOptions,
): Promise<Response> {
  // Serve the actively precomputed body when available (recomputed on every
  // stored block plus a periodic refresh) — zero storage work per request.
  const precomputed = options.syncStatusProvider?.get();
  if (precomputed) {
    return responseFromCached(precomputed);
  }
  return responseFromCached(await buildSyncStatusResponse(storage));
}

/**
 * Compute the /sync response body. Exported so serve.ts can feed it to the
 * PrecomputedResponse that recomputes on block-stored notifications.
 */
export async function buildSyncStatusResponse(storage: ScannerStorage): Promise<CachedResponse> {
  const now = new Date();
  const [progress, samples] = await Promise.all([
    storage.getScannerProgress(),
    storage.getForwardScanSamples(),
  ]);
  const body: SyncStatusResponseBody = {
    ok: true,
    serverTimeUtc: now.toISOString(),
    sync: computeSyncStatus({ now, ...progress, samples }),
  };
  return { status: 200, body: JSON.stringify(body) };
}

async function readGuzzlerCacheHealth(
  guzzlerStore: GuzzlerStore | undefined,
): Promise<HealthResponseBody["guzzlers"]> {
  if (!guzzlerStore) {
    return {
      enabled: false,
      entryCount: null,
      bucketCount: null,
      oldestBucket: null,
      newestBucket: null,
      totalSizeBytes: null,
    };
  }
  try {
    const [stats, board] = await Promise.all([
      guzzlerStore.stats(),
      guzzlerStore.loadLeaderboards(),
    ]);
    return {
      enabled: true,
      entryCount: stats.entryCount,
      bucketCount: board?.cache?.bucketCount ?? null,
      oldestBucket: board?.cache?.oldestBucket ?? null,
      newestBucket: board?.cache?.newestBucket ?? null,
      totalSizeBytes: stats.totalBytes.toString(),
    };
  } catch (error) {
    // Never let a transient cache hiccup take down the health endpoint.
    console.error("Failed to read guzzler cache stats", error);
    return {
      enabled: true,
      entryCount: null,
      bucketCount: null,
      oldestBucket: null,
      newestBucket: null,
      totalSizeBytes: null,
    };
  }
}

/**
 * Parse `?limit=`, falling back to the default. The cached board only holds the
 * top {@link MAX_GUZZLER_LIMIT} senders per window, so a larger request cannot
 * be served and is rejected rather than silently clamped.
 */
function parseGuzzlerLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) {
    return DEFAULT_GUZZLER_LIMIT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error("limit must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  if (value > MAX_GUZZLER_LIMIT) {
    throw new Error(`limit must be at most ${MAX_GUZZLER_LIMIT}`);
  }
  return value;
}

function parseGuzzlerWindow(params: URLSearchParams): GuzzlerWindow | null {
  const raw = params.get("window");
  if (raw === null) {
    return null;
  }
  const window = GUZZLER_WINDOWS.find((candidate) => candidate.label === raw);
  if (!window) {
    throw new Error(
      `window must be one of ${GUZZLER_WINDOWS.map((candidate) => candidate.label).join(", ")}`,
    );
  }
  return window;
}

async function handleGetGuzzlers(
  request: Request,
  url: URL,
  guzzlerStore: GuzzlerStore | undefined,
): Promise<Response> {
  if (!guzzlerStore) {
    return jsonError(503, "Guzzler tracking is disabled");
  }

  let limit: number;
  let requestedWindow: GuzzlerWindow | null;
  try {
    limit = parseGuzzlerLimit(url.searchParams);
    requestedWindow = parseGuzzlerWindow(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  // The writer refreshes this cached board once a minute; the API just slices
  // it to the requested top-N. Before the first refresh, serve an empty board.
  const board = await guzzlerStore.loadLeaderboards();
  const sliced = board
    ? sliceLeaderboards(board, limit)
    : emptyLeaderboards(Date.now(), limit);

  const body = guzzlerLeaderboardsToResponseBody(sliced, requestedWindow);

  return compressedJsonResponse(request, body);
}

function guzzlerLeaderboardsToResponseBody(
  board: GuzzlerLeaderboards,
  requestedWindow: GuzzlerWindow | null,
): GuzzlersResponseBody {
  const windows = requestedWindow
    ? board.windows.filter((window) => window.label === requestedWindow.label)
    : board.windows;

  return {
    generatedAt: board.generatedAt,
    retentionMs: board.retentionMs,
    limit: board.limit,
    names: GUZZLER_STAT_RESPONSE_NAMES,
    windows: windows.map(guzzlerWindowToResponseRow),
  };
}

function guzzlerWindowToResponseRow(
  window: GuzzlerWindowLeaderboard,
): GuzzlerWindowLeaderboardResponseRow {
  return {
    label: window.label,
    windowMs: window.windowMs,
    count: window.count,
    guzzlers: window.guzzlers.map(guzzlerStatToResponseRow),
  };
}

function guzzlerStatToResponseRow(stat: GuzzlerStat): GuzzlerStatResponseRow {
  return GUZZLER_STAT_RESPONSE_NAMES.map((name) => stat[name] ?? null);
}

async function handleGetGuzzlerHistory(
  rawAddress: string,
  guzzlerStore: GuzzlerStore | undefined,
): Promise<Response> {
  if (!guzzlerStore) {
    return jsonError(503, "Guzzler tracking is disabled");
  }

  let address: string;
  try {
    address = parseAddressParam("address", rawAddress);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  // A single sender is one hash field, so this reads live rather than from the
  // minute-cached leaderboard. An unknown sender yields an empty history.
  const buckets = await guzzlerStore.loadSender(address);
  const history = buildGuzzlerHistory(address, buckets ?? [], Date.now());
  const body: GuzzlerHistoryResponseBody = {
    ...history,
    names: GUZZLER_HISTORY_POINT_RESPONSE_NAMES,
    points: history.points.map(guzzlerHistoryPointToResponseRow),
  };

  return jsonResponse(body);
}

export function guzzlerHistoryPointToResponseRow(
  point: GuzzlerHistoryPoint,
): GuzzlerHistoryPointResponseRow {
  return GUZZLER_HISTORY_POINT_RESPONSE_NAMES.map((name) => point[name] ?? null);
}

async function handleGetSenders(
  request: Request,
  url: URL,
  storage: ScannerStorage,
): Promise<Response> {
  let filter: SenderStatsQueryFilter;
  try {
    filter = parseSenderStatsFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  const senders = await storage.querySenderStats(filter);
  const effectiveLimit = Math.min(filter.limit ?? MAX_SENDERS_PER_QUERY, MAX_SENDERS_PER_QUERY);
  const order = filter.order ?? "desc";

  const body: SendersResponseBody = {
    count: senders.length,
    limit: effectiveLimit,
    truncated: senders.length >= effectiveLimit,
    filters: { order },
    names: SENDER_STATS_RESPONSE_NAMES,
    senders: senders.map(senderStatsToResponseRow),
  };

  return compressedJsonResponse(request, body);
}

export function parseFilterFromQuery(params: URLSearchParams): BlockQueryFilter {
  const filter: BlockQueryFilter = { order: "desc" };

  const blockGt = params.get("blockGt");
  if (blockGt !== null) {
    filter.blockGt = parseBlockParam("blockGt", blockGt);
  }

  const blockLt = params.get("blockLt");
  if (blockLt !== null) {
    filter.blockLt = parseBlockParam("blockLt", blockLt);
  }

  const dateGt = params.get("dateGt");
  if (dateGt !== null) {
    filter.dateGt = parseDateParam("dateGt", dateGt);
  }

  const dateLt = params.get("dateLt");
  if (dateLt !== null) {
    filter.dateLt = parseDateParam("dateLt", dateLt);
  }

  const limit = params.get("limit");
  if (limit !== null) {
    filter.limit = parseLimitParam(limit, MAX_BLOCKS_PER_QUERY);
  }

  const order = params.get("order");
  if (order !== null) {
    filter.order = parseOrderParam(order);
  }

  return filter;
}

export function parseRangeFilterFromQuery(params: URLSearchParams): BlockRangeQueryFilter {
  const filter: BlockRangeQueryFilter = { order: "desc" };

  const rangeSize = params.get("rangeSize");
  if (rangeSize !== null) {
    try {
      filter.rangeSize = parseRangeSize(rangeSize);
    } catch (error) {
      throw new Error(
        `rangeSize is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const rangeStartGt = params.get("rangeStartGt");
  if (rangeStartGt !== null) {
    filter.rangeStartGt = parseBlockParam("rangeStartGt", rangeStartGt);
  }

  const rangeStartLt = params.get("rangeStartLt");
  if (rangeStartLt !== null) {
    filter.rangeStartLt = parseBlockParam("rangeStartLt", rangeStartLt);
  }

  const dateGt = params.get("dateGt");
  if (dateGt !== null) {
    filter.dateGt = parseDateParam("dateGt", dateGt);
  }

  const dateLt = params.get("dateLt");
  if (dateLt !== null) {
    filter.dateLt = parseDateParam("dateLt", dateLt);
  }

  const limit = params.get("limit");
  if (limit !== null) {
    filter.limit = parseLimitParam(limit, MAX_RANGES_PER_QUERY);
  }

  const order = params.get("order");
  if (order !== null) {
    filter.order = parseOrderParam(order);
  }

  return filter;
}

export function parseTransactionFilterFromQuery(params: URLSearchParams): TransactionQueryFilter {
  const filter: TransactionQueryFilter = {};

  const block = params.get("block");
  if (block !== null) {
    filter.blockNumber = parseBlockParam("block", block);
  }

  const blockGt = params.get("blockGt");
  if (blockGt !== null) {
    filter.blockGt = parseBlockParam("blockGt", blockGt);
  }

  const blockLt = params.get("blockLt");
  if (blockLt !== null) {
    filter.blockLt = parseBlockParam("blockLt", blockLt);
  }

  const address = params.get("address");
  if (address !== null) {
    filter.fromAddress = parseAddressParam("address", address);
  }

  const nonceGt = params.get("nonceGt");
  if (nonceGt !== null) {
    filter.nonceGt = parseBlockParam("nonceGt", nonceGt);
  }

  const nonceLt = params.get("nonceLt");
  if (nonceLt !== null) {
    filter.nonceLt = parseBlockParam("nonceLt", nonceLt);
  }

  const dateGt = params.get("dateGt");
  if (dateGt !== null) {
    filter.dateGt = parseDateParam("dateGt", dateGt);
  }

  const dateLt = params.get("dateLt");
  if (dateLt !== null) {
    filter.dateLt = parseDateParam("dateLt", dateLt);
  }

  const limit = params.get("limit");
  if (limit !== null) {
    filter.limit = parseLimitParam(limit, MAX_TRANSACTIONS_PER_QUERY);
  }

  const page = params.get("page");
  if (page !== null) {
    filter.page = parsePageParam(page);
  }

  const order = params.get("order");
  if (order !== null) {
    filter.order = parseOrderParam(order);
  } else {
    filter.order = "desc";
  }

  return filter;
}

export function parseTransactionRecordsFilterFromQuery(
  params: URLSearchParams,
): TransactionRecordsQueryFilter {
  const filter: TransactionRecordsQueryFilter = {};

  const limit = params.get("limit");
  if (limit !== null) {
    filter.limit = parseLimitParam(limit, DEFAULT_TRANSACTION_RECORDS_PER_CATEGORY);
  }

  return filter;
}

export function parseSenderStatsFilterFromQuery(params: URLSearchParams): SenderStatsQueryFilter {
  const filter: SenderStatsQueryFilter = { order: "desc" };

  const limit = params.get("limit");
  if (limit !== null) {
    filter.limit = parseLimitParam(limit, MAX_SENDERS_PER_QUERY);
  }

  const order = params.get("order");
  if (order !== null) {
    filter.order = parseOrderParam(order);
  }

  return filter;
}

function parseLimitParam(value: string, hardMax: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`limit must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`limit must be a positive integer`);
  }
  if (parsed > hardMax) {
    throw new Error(`limit must be at most ${hardMax}`);
  }
  return parsed;
}

function parsePageParam(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`page must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`page must be a positive integer`);
  }
  return parsed;
}

function parseBlockParam(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(value);
}

function parseAddressParam(name: string, value: string): string {
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`${name} must be a 20-byte hex address`);
  }
  return trimmed.toLowerCase();
}

function parseDateParam(name: string, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO-8601 date string`);
  }
  return parsed.toISOString();
}

function parseOrderParam(value: string): QueryOrder {
  if (value === "asc" || value === "desc") return value;
  throw new Error(`order must be either asc or desc`);
}

function parseBaseloadConfigName(value: string): string {
  const decoded = decodeURIComponent(value).trim();
  if (!decoded) {
    throw new Error("Baseload config name is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/.test(decoded)) {
    throw new Error(
      "Baseload config name must start with a letter or number and contain only letters, numbers, spaces, dots, underscores, or hyphens",
    );
  }
  return decoded;
}

function secondsBetween(now: Date, isoDate: string | undefined): number | null {
  if (isoDate === undefined) return null;
  const timestamp = Date.parse(isoDate);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1000));
}

function clampLag(value: bigint): string {
  return value > 0n ? value.toString() : "0";
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { ...init, headers: { ...CORS_HEADERS, ...(init.headers ?? {}) } });
}

/** Build an HTTP response from a cached/precomputed serialized body. */
function responseFromCached(cached: CachedResponse): Response {
  // Slice byte bodies to a plain ArrayBuffer: BodyInit rejects views over
  // ArrayBufferLike (same dance as compressedJsonResponse).
  const body =
    typeof cached.body === "string"
      ? cached.body
      : (cached.body.buffer.slice(
          cached.body.byteOffset,
          cached.body.byteOffset + cached.body.byteLength,
        ) as ArrayBuffer);
  return new Response(body, {
    status: cached.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json;charset=utf-8",
      ...(cached.headers ?? {}),
    },
  });
}

/**
 * Serve a list endpoint (/blocks, /ranges) through the list cache, keyed by
 * path + query string + negotiated encoding. The zstd variant is derived from
 * the cached plain JSON, so the storage query runs at most once per key per
 * cache lifetime no matter which encodings clients ask for.
 */
async function cachedListResponse(
  request: Request,
  url: URL,
  cache: ResponseCache | undefined,
  buildJson: () => Promise<string>,
): Promise<Response> {
  const key = `${url.pathname}${url.search}`;
  const plainLoader = async (): Promise<CachedResponse> => ({
    status: 200,
    body: await buildJson(),
    headers: { Vary: "Accept-Encoding" },
  });
  const loadPlain = () => (cache ? cache.load(`plain|${key}`, plainLoader) : plainLoader());

  if (!acceptsEncoding(request, "zstd")) {
    return responseFromCached(await loadPlain());
  }

  const zstdLoader = async (): Promise<CachedResponse> => {
    const plain = await loadPlain();
    const compressed = await Bun.zstdCompress(new TextEncoder().encode(plain.body as string), {
      level: 1,
    });
    return {
      status: 200,
      body: compressed,
      headers: { "Content-Encoding": "zstd", Vary: "Accept-Encoding" },
    };
  };
  const zstd = cache ? await cache.load(`zstd|${key}`, zstdLoader) : await zstdLoader();
  return responseFromCached(zstd);
}

async function compressedJsonResponse(request: Request, body: unknown): Promise<Response> {
  if (!acceptsEncoding(request, "zstd")) {
    return jsonResponse(body);
  }

  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const compressed = await Bun.zstdCompress(bytes, { level: 1 });
  const responseBody = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer;
  return new Response(responseBody, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json;charset=utf-8",
      "Content-Encoding": "zstd",
      "Content-Length": String(compressed.byteLength),
      Vary: "Accept-Encoding",
    },
  });
}

function acceptsEncoding(request: Request, encoding: string): boolean {
  const header = request.headers.get("accept-encoding");
  if (!header) {
    return false;
  }
  for (const part of header.split(",")) {
    const [token, ...params] = part.split(";").map((value) => value.trim().toLowerCase());
    if (token !== encoding) {
      continue;
    }
    const q = params.find((param) => param.startsWith("q="));
    if (q === undefined) {
      return true;
    }
    const value = Number(q.slice(2));
    return !Number.isFinite(value) || value > 0;
  }
  return false;
}

function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}
