// The framework-free half of the Data page's entity query: turning what the
// user typed into an `arkiv_query` call, decoding what the node sends back, and
// the small calculations the result cards show (block dates, lifetime, filter
// expressions). No React here so `bun test` can cover it.

import { RpcCallError, type BlockTiming } from "./dataRpc";

export const ENTITY_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * A bare entity key or address is the most common thing pasted into the box.
 * The 0.8 grammar wants typed literals, so rewrite those two shapes into the
 * query they mean; anything else is passed through untouched (trimmed).
 */
export function normalizeQueryInput(input: string): string {
  const trimmed = input.trim();
  if (ENTITY_KEY_PATTERN.test(trimmed)) return `$key = key(${trimmed})`;
  if (ADDRESS_PATTERN.test(trimmed)) return `$owner = addr(${trimmed})`;
  return trimmed;
}

export const PAGE_SIZE_OPTIONS = ["5", "10", "25", "50", "100"] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = "25";
/** The node caps `limit` here; anything larger is answered with -32602. */
export const MAX_QUERY_LIMIT = 200;

export function isPageSize(value: string): value is PageSize {
  return (PAGE_SIZE_OPTIONS as readonly string[]).includes(value);
}

export const EXPIRATION_FILTERS = ["all", "soon"] as const;
export type ExpirationFilter = (typeof EXPIRATION_FILTERS)[number];
export const DEFAULT_EXPIRATION_FILTER: ExpirationFilter = "all";
/** "Expiring soon" means within this many milliseconds of now. */
export const EXPIRING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isExpirationFilter(value: string): value is ExpirationFilter {
  return (EXPIRATION_FILTERS as readonly string[]).includes(value);
}

/** The URL state of `/data`, as `readFiltersFromSearch` wants it. */
export interface DataPageFilters extends Record<string, string> {
  q: string;
  pageSize: string;
  expiration: string;
}

export const DATA_FILTER_KEYS = ["q", "pageSize", "expiration"] as const;
export const EMPTY_DATA_FILTERS: DataPageFilters = { q: "", pageSize: "", expiration: "" };

/** Coerces raw URL values to the page's settings, falling back to the defaults for junk. */
export function resolvePageSize(value: string | null | undefined): PageSize {
  return value && isPageSize(value) ? value : DEFAULT_PAGE_SIZE;
}

export function resolveExpirationFilter(value: string | null | undefined): ExpirationFilter {
  return value && isExpirationFilter(value) ? value : DEFAULT_EXPIRATION_FILTER;
}

/** The URL parameters a query run should be reachable at; defaults are left out. */
export function dataPageFilters(query: string, pageSize: PageSize, expiration: ExpirationFilter): DataPageFilters {
  return {
    q: query,
    pageSize: pageSize === DEFAULT_PAGE_SIZE ? "" : pageSize,
    expiration: expiration === DEFAULT_EXPIRATION_FILTER ? "" : expiration,
  };
}

/**
 * Every projection except the payload and the values-free schema. Payloads run
 * to ~100 KB on this network, so a list must never ask for them; the attribute
 * list already carries each attribute's type.
 */
export const LIST_SELECT = {
  key: true,
  owner: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  creationFlags: true,
  contentType: true,
  attributes: true,
} as const;

export interface QueryPageRequest {
  query: string;
  pageSize: number;
  /** Continue a previous page. Only valid together with the block that page was read at. */
  cursor?: string;
  atBlock?: number;
}

export interface QueryRpcOptions {
  select: typeof LIST_SELECT;
  limit: string;
  cursor?: string;
  atBlock?: string;
}

export function buildQueryParams(request: QueryPageRequest): [string, QueryRpcOptions] {
  const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.floor(request.pageSize)));
  const options: QueryRpcOptions = { select: LIST_SELECT, limit: `0x${limit.toString(16)}` };
  if (request.cursor) {
    if (request.atBlock === undefined) {
      throw new Error("a cursor can only be resumed at the block its page was read at");
    }
    options.cursor = request.cursor;
    options.atBlock = `0x${request.atBlock.toString(16)}`;
  }
  return [request.query, options];
}

export interface EntityAttribute {
  name: string;
  /** The node's type tag: bool, i32, u64, u256, dec, bytes32, str, addr, key (bytes only backs the payload). */
  type: string;
  /** The value rendered for display and for building a filter literal. */
  value: string;
}

export interface EntityCreationFlags {
  readonly: boolean;
  permissionlessExtension: boolean;
  raw: number;
}

export interface EntityRecord {
  key: string;
  owner: string | null;
  creator: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  expiresAt: number | null;
  creationFlags: EntityCreationFlags | null;
  contentType: string | null;
  attributes: EntityAttribute[];
}

export interface QueryPage {
  entities: EntityRecord[];
  /** The block the page was read at; the cursor must be resumed at it. */
  blockNumber: number;
  cursor: string | null;
}

function hexToNumber(value: unknown, what: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return Number(BigInt(value));
  throw new Error(`${what} is not a hex quantity: ${JSON.stringify(value)}`);
}

function optionalBlock(value: unknown, what: string): number | null {
  return value === undefined || value === null ? null : hexToNumber(value, what);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Renders a node attribute value the way a person would write it in a query. */
export function formatAttributeValue(type: string, value: unknown): string {
  switch (type) {
    case "bool":
      if (typeof value === "boolean") return value ? "true" : "false";
      if (value === "true" || value === "false") return value;
      return JSON.stringify(value);
    case "i32":
    case "u64":
    case "u256":
      if (typeof value === "number" && Number.isInteger(value)) return String(value);
      if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value).toString();
      if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
      return JSON.stringify(value);
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

export function decodeEntity(raw: unknown): EntityRecord {
  if (!raw || typeof raw !== "object") throw new Error("entity is not an object");
  const entity = raw as Record<string, unknown>;
  if (typeof entity.key !== "string") throw new Error("entity has no key");

  const flags = entity.creationFlags as Record<string, unknown> | undefined;
  const attributes = Array.isArray(entity.attributes) ? entity.attributes : [];

  return {
    key: entity.key,
    owner: optionalString(entity.owner),
    creator: optionalString(entity.creator),
    createdAt: optionalBlock(entity.createdAt, "createdAt"),
    updatedAt: optionalBlock(entity.updatedAt, "updatedAt"),
    expiresAt: optionalBlock(entity.expiresAt, "expiresAt"),
    creationFlags:
      flags && typeof flags === "object"
        ? {
            readonly: flags.readonly === true,
            permissionlessExtension: flags.permissionlessExtension === true,
            raw: typeof flags.raw === "number" ? flags.raw : 0,
          }
        : null,
    contentType: optionalString(entity.contentType),
    attributes: attributes
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .filter((item) => typeof item.name === "string" && typeof item.type === "string")
      .map((item) => ({
        name: item.name as string,
        type: item.type as string,
        value: formatAttributeValue(item.type as string, item.value),
      })),
  };
}

export function decodeQueryResult(raw: unknown): QueryPage {
  if (!raw || typeof raw !== "object") throw new Error("query result is not an object");
  const result = raw as { data?: unknown; blockNumber?: unknown; cursor?: unknown };
  if (!Array.isArray(result.data)) throw new Error("query result carries no data array");
  return {
    entities: result.data.map(decodeEntity),
    blockNumber: hexToNumber(result.blockNumber, "blockNumber"),
    cursor: typeof result.cursor === "string" && result.cursor ? result.cursor : null,
  };
}

export const NUMERIC_ATTRIBUTE_TYPES: ReadonlySet<string> = new Set(["i32", "u64", "u256", "dec"]);

/** The typed literal the 0.8 grammar expects for an attribute value. */
export function formatQueryLiteral(type: string, value: string): string {
  // Single quotes, doubled to escape: str('it''s') parses at the node.
  if (type === "str") return `str('${value.replace(/'/g, "''")}')`;
  // Booleans are written bare; the node rejects bool(true).
  if (type === "bool") return value === "true" ? "true" : "false";
  return `${type}(${value})`;
}

export function attributeFilterExpression(attribute: EntityAttribute): string {
  return `${attribute.name} = ${formatQueryLiteral(attribute.type, attribute.value)}`;
}

/**
 * Joins with the uppercase keyword; `&&` is a parse error at the node. A bare
 * `*` is replaced rather than joined, since the node refuses `*` in an AND.
 */
export function appendQueryExpression(current: string, expression: string): string {
  const base = current.trim();
  if (!base || base === "*") return expression;
  return `${base}\n    AND ${expression}`;
}

// ---------------------------------------------------------------------------
// Errors

export interface QueryErrorDescription {
  title: string;
  detail: string;
  /** Character offset into the query when the node pointed at one. */
  position: number | null;
}

/** The node's syntax errors carry `data.position`; surface it so the page can point at the spot. */
export function describeQueryError(error: unknown): QueryErrorDescription {
  if (error instanceof RpcCallError) {
    const data = error.data as { message?: unknown; position?: unknown } | undefined;
    const detail = data && typeof data.message === "string" ? data.message : stripMethodPrefix(error.message);
    const position = data && typeof data.position === "number" ? data.position : null;
    if (error.httpStatus === 429 || error.code === 429) {
      return { title: "Rate limited", detail: `${detail} Try again in a moment or switch the RPC endpoint.`, position: null };
    }
    if (error.code === -32001) return { title: "Query syntax error", detail, position };
    if (error.code === -32002) return { title: "Unsupported query", detail, position };
    if (error.code === -32601) {
      return { title: "Method not available", detail: `${detail} This endpoint does not serve entity queries.`, position: null };
    }
    if (error.code === -32602) return { title: "Invalid query parameters", detail, position };
    if (error.cause instanceof DOMException && error.cause.name === "TimeoutError") {
      return { title: "Timed out", detail, position: null };
    }
    return { title: "Query failed", detail, position };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { title: "Query failed", detail, position: null };
}

function stripMethodPrefix(message: string): string {
  return message.replace(/^arkiv_query (?:was rejected(?: \(-?\d+\))?|answered)(?::\s*)?/, "").trim() || message;
}

/** Where a character offset lands, for pointing at it under the query text. */
export function locateQueryPosition(query: string, position: number): { line: number; column: number; lineText: string } {
  const clamped = Math.max(0, Math.min(position, query.length));
  const before = query.slice(0, clamped);
  const lines = before.split("\n");
  const line = lines.length - 1;
  const column = lines[line].length;
  return { line, column, lineText: query.split("\n")[line] ?? "" };
}

// ---------------------------------------------------------------------------
// Block timing

export function estimateBlockTimestampMs(blockNumber: number, timing: BlockTiming): number {
  const deltaBlocks = blockNumber - timing.currentBlock;
  return (timing.currentBlockTime + deltaBlocks * timing.blockDurationSeconds) * 1000;
}

export interface LifetimeProgress {
  consumedPct: number;
  leftPct: number;
  expired: boolean;
}

export function lifetimeProgress(createdAt: number, expiresAt: number, currentBlock: number): LifetimeProgress {
  const total = expiresAt - createdAt;
  if (total <= 0) return { consumedPct: 100, leftPct: 0, expired: currentBlock >= expiresAt };
  const ratio = Math.max(0, Math.min(1, (currentBlock - createdAt) / total));
  const consumedPct = ratio * 100;
  return { consumedPct, leftPct: 100 - consumedPct, expired: currentBlock >= expiresAt };
}

export function isExpiringSoon(
  expiresAt: number | null,
  timing: BlockTiming,
  nowMs: number,
  windowMs: number = EXPIRING_SOON_WINDOW_MS,
): boolean {
  if (expiresAt === null) return false;
  const at = estimateBlockTimestampMs(expiresAt, timing);
  return at >= nowMs && at - nowMs < windowMs;
}

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "in 3 hours", "2 days ago", from a millisecond delta. */
export function formatRelativeMs(targetMs: number, nowMs: number): string {
  const seconds = Math.round((targetMs - nowMs) / 1000);
  if (Math.abs(seconds) < 60) return relativeFormatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relativeFormatter.format(days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return relativeFormatter.format(months, "month");
  return relativeFormatter.format(Math.round(days / 365), "year");
}

// ---------------------------------------------------------------------------
// Examples

export interface ExampleQuery {
  label: string;
  query: string;
}

export const EXAMPLE_QUERIES: readonly ExampleQuery[] = [
  { label: "Everything", query: "*" },
  { label: "By entity key", query: "$key = key(0x)" },
  { label: "By owner", query: "$owner = addr(0x)" },
  { label: "By text attribute", query: "status = str('active')" },
  { label: "By numeric attribute", query: "score > i32(100)" },
  { label: "Text prefix", query: "name STARTSWITH str('ark')" },
  { label: "Expiring after a block", query: "$expiresAt >= u64(0)" },
];
