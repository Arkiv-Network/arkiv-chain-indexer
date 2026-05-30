import { DEFAULT_RANGE_SIZE, parseRangeSize } from "./ranges";
import { type BlockInspectionResult } from "./blockInspector";
import { readGuzzlerStatistics, type GuzzlerStat, type GuzzlerStore } from "./guzzlers";
import { type BaseloadRuntime, type BaseloadState } from "./baseloadRuntime";
import { normalizeBaseloadConfig } from "./baseloadConfig";
import { readBuildInfo, type BuildInfo } from "./buildInfo";
import {
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
  type StoredSenderStats,
  type StoredTransaction,
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
  ranges: StoredBlockRange[];
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
  transactions: StoredTransaction[];
}

export interface TransactionRecordsResponseBody {
  limit: number;
  records: StoredTransactionRecordsByCategory;
}

export interface SendersResponseBody {
  count: number;
  limit: number;
  truncated: boolean;
  filters: {
    order: QueryOrder;
  };
  senders: StoredSenderStats[];
}

export interface GuzzlersResponseBody {
  windowMs: number;
  generatedAt: string;
  count: number;
  guzzlers: GuzzlerStat[];
}

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
  database: DatabaseStats;
  features: {
    transactionData: boolean;
    guzzlers: boolean;
  };
}

export const BLOCK_RESPONSE_NAMES = [
  "blockNumber",
  "blockDate",
  "baseBlockFeeWei",
  "totalGasUsed",
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

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

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

  if (url.pathname === "/health") {
    return handleGetHealth(storage, transactionDataEnabled, options.guzzlerStore !== undefined);
  }

  if (url.pathname === "/guzzlers") {
    return handleGetGuzzlers(options.guzzlerStore);
  }

  if (url.pathname === "/blocks") {
    return handleGetBlocks(url, storage);
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
    return handleGetRanges(url, storage);
  }

  if (url.pathname === "/transactions") {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetTransactions(url, storage);
  }

  if (url.pathname === "/transaction-records") {
    return handleGetTransactionRecords(url, storage);
  }

  if (url.pathname === "/senders") {
    if (!transactionDataEnabled) {
      return jsonError(404, "Transaction data is disabled");
    }
    return handleGetSenders(url, storage);
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
  guzzlersEnabled: boolean,
): Promise<Response> {
  const now = new Date();
  const [progress, database] = await Promise.all([
    storage.getScannerProgress(),
    storage.getDatabaseStats(),
  ]);
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
    database,
    features: {
      transactionData: transactionDataEnabled,
      guzzlers: guzzlersEnabled,
    },
  };

  return jsonResponse(body);
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

async function handleGetBlocks(url: URL, storage: ScannerStorage): Promise<Response> {
  let filter: BlockQueryFilter;
  try {
    filter = parseFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

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

  return jsonResponse(body);
}

export function blockToResponseRow(block: StoredBlock): BlockResponseRow {
  return BLOCK_RESPONSE_NAMES.map((name) => block[name] ?? null);
}

async function handleGetRanges(url: URL, storage: ScannerStorage): Promise<Response> {
  let filter: BlockRangeQueryFilter;
  try {
    filter = parseRangeFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

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
    ranges,
  };

  return jsonResponse(body);
}

async function handleGetTransactions(url: URL, storage: ScannerStorage): Promise<Response> {
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
    transactions,
  };

  return jsonResponse(body);
}

async function handleGetTransactionRecords(url: URL, storage: ScannerStorage): Promise<Response> {
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

  const body: TransactionRecordsResponseBody = {
    limit,
    records: await storage.queryTransactionRecords({ limit }),
  };

  return jsonResponse(body);
}

async function handleGetGuzzlers(guzzlerStore: GuzzlerStore | undefined): Promise<Response> {
  if (!guzzlerStore) {
    return jsonError(503, "Guzzler tracking is disabled");
  }

  const statistics = await readGuzzlerStatistics(guzzlerStore, Date.now());
  const body: GuzzlersResponseBody = {
    windowMs: statistics.windowMs,
    generatedAt: statistics.generatedAt,
    count: statistics.count,
    guzzlers: statistics.guzzlers,
  };

  return jsonResponse(body);
}

async function handleGetSenders(url: URL, storage: ScannerStorage): Promise<Response> {
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
    senders,
  };

  return jsonResponse(body);
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

function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}
