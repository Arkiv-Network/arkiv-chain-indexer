import {
  MAX_BLOCKS_PER_QUERY,
  ScannerStorage,
  type BlockQueryFilter,
  type StoredBlock,
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
