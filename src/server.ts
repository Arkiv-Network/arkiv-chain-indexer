import { DEFAULT_RANGE_SIZE, parseRangeSize } from "./ranges";
import { type BlockInspectionResult } from "./blockInspector";
import {
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  MAX_TRANSACTIONS_PER_QUERY,
  ScannerStorage,
  type BlockQueryFilter,
  type BlockRangeQueryFilter,
  type QueryOrder,
  type StoredBlock,
  type StoredBlockRange,
  type StoredTransaction,
  type TransactionQueryFilter,
} from "./storage";

export interface BlockServerOptions {
  port?: number;
  hostname?: string;
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
  blocks: StoredBlock[];
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
  filters: {
    block: string | null;
    blockGt: string | null;
    blockLt: string | null;
    dateGt: string | null;
    dateLt: string | null;
  };
  transactions: StoredTransaction[];
}

export type BlockInspectResponseBody = BlockInspectionResult;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function createBlockServer(storage: ScannerStorage, options: BlockServerOptions = {}) {
  const serveOptions: { port: number; fetch: (request: Request) => Promise<Response>; hostname?: string } = {
    port: options.port ?? 0,
    fetch: (request) => handleRequest(request, storage),
  };
  if (options.hostname !== undefined) {
    serveOptions.hostname = options.hostname;
  }
  return Bun.serve(serveOptions);
}

export async function handleRequest(
  request: Request,
  storage: ScannerStorage,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET") {
    return jsonError(405, `Method ${request.method} is not allowed`);
  }

  if (url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/blocks") {
    return handleGetBlocks(url, storage);
  }

  const blockInspectMatch = url.pathname.match(/^\/block\/(\d+)$/);
  if (blockInspectMatch?.[1]) {
    return handleGetBlockInspect(blockInspectMatch[1], storage);
  }

  if (url.pathname === "/ranges") {
    return handleGetRanges(url, storage);
  }

  if (url.pathname === "/transactions") {
    return handleGetTransactions(url, storage);
  }

  return jsonError(404, `Not found: ${url.pathname}`);
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
    blocks,
  };

  return jsonResponse(body);
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

  const transactions = await storage.queryTransactions(filter);
  const effectiveLimit = Math.min(
    filter.limit ?? MAX_TRANSACTIONS_PER_QUERY,
    MAX_TRANSACTIONS_PER_QUERY,
  );

  const body: TransactionsResponseBody = {
    count: transactions.length,
    limit: effectiveLimit,
    truncated: transactions.length >= effectiveLimit,
    filters: {
      block: filter.blockNumber !== undefined ? filter.blockNumber.toString() : null,
      blockGt: filter.blockGt !== undefined ? filter.blockGt.toString() : null,
      blockLt: filter.blockLt !== undefined ? filter.blockLt.toString() : null,
      dateGt: filter.dateGt ?? null,
      dateLt: filter.dateLt ?? null,
    },
    transactions,
  };

  return jsonResponse(body);
}

export function parseFilterFromQuery(params: URLSearchParams): BlockQueryFilter {
  const filter: BlockQueryFilter = {};

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
  const filter: BlockRangeQueryFilter = {};

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

function parseBlockParam(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(value);
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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, { ...init, headers: { ...CORS_HEADERS, ...(init.headers ?? {}) } });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status });
}
