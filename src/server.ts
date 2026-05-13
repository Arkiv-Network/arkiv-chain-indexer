import { DEFAULT_RANGE_SIZE, parseRangeSize } from "./ranges";
import {
  MAX_BLOCKS_PER_QUERY,
  MAX_RANGES_PER_QUERY,
  ScannerStorage,
  type BlockQueryFilter,
  type BlockRangeQueryFilter,
  type StoredBlock,
  type StoredBlockRange,
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

export async function handleRequest(request: Request, storage: ScannerStorage): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return jsonError(405, `Method ${request.method} is not allowed`);
  }

  if (url.pathname === "/blocks") {
    return handleGetBlocks(url, storage);
  }

  if (url.pathname === "/ranges") {
    return handleGetRanges(url, storage);
  }

  return jsonError(404, `Not found: ${url.pathname}`);
}

function handleGetBlocks(url: URL, storage: ScannerStorage): Response {
  let filter: BlockQueryFilter;
  try {
    filter = parseFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  const blocks = storage.queryBlocks(filter);

  const body: BlocksResponseBody = {
    count: blocks.length,
    limit: MAX_BLOCKS_PER_QUERY,
    truncated: blocks.length >= MAX_BLOCKS_PER_QUERY,
    filters: {
      blockGt: filter.blockGt !== undefined ? filter.blockGt.toString() : null,
      blockLt: filter.blockLt !== undefined ? filter.blockLt.toString() : null,
      dateGt: filter.dateGt ?? null,
      dateLt: filter.dateLt ?? null,
    },
    blocks,
  };

  return Response.json(body);
}

function handleGetRanges(url: URL, storage: ScannerStorage): Response {
  let filter: BlockRangeQueryFilter;
  try {
    filter = parseRangeFilterFromQuery(url.searchParams);
  } catch (error) {
    return jsonError(400, error instanceof Error ? error.message : String(error));
  }

  const ranges = storage.queryBlockRanges(filter);

  const rangeSize = filter.rangeSize ?? DEFAULT_RANGE_SIZE;
  const body: RangesResponseBody = {
    count: ranges.length,
    limit: MAX_RANGES_PER_QUERY,
    truncated: ranges.length >= MAX_RANGES_PER_QUERY,
    filters: {
      rangeSize: rangeSize.toString(),
      rangeStartGt: filter.rangeStartGt !== undefined ? filter.rangeStartGt.toString() : null,
      rangeStartLt: filter.rangeStartLt !== undefined ? filter.rangeStartLt.toString() : null,
      dateGt: filter.dateGt ?? null,
      dateLt: filter.dateLt ?? null,
    },
    ranges,
  };

  return Response.json(body);
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

  return filter;
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

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
