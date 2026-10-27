// The framework-free half of the entity explorer's entity query: turning what the
// user typed into a query, the page's URL state, explaining a failed query,
// and the block-timing arithmetic the results show. No React here so
// `bun test` can cover it.

import { MAX_EXPIRES_AT } from "@arkiv-network/sdk";
import type { BlockTiming } from "./client";

export const ENTITY_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const KEY_LOOKUP_PATTERN = /^\$key\s*=\s*key\(0x[0-9a-fA-F]{64}\)$/;

/**
 * A bare entity key or address is the most common thing pasted into the box.
 * The grammar wants typed literals, so rewrite those two shapes into the query
 * they mean; anything else is passed through untouched (trimmed).
 */
export function normalizeQueryInput(input: string): string {
  const trimmed = input.trim();
  if (ENTITY_KEY_PATTERN.test(trimmed)) return `$key = key(${trimmed})`;
  if (ADDRESS_PATTERN.test(trimmed)) return `$owner = addr(${trimmed})`;
  return trimmed;
}

export const PAGE_SIZE_OPTIONS = ["5", "10", "25", "50", "100"] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = "50";
/** The node caps `limit` here; anything larger is refused. */
export const MAX_QUERY_LIMIT = 100;

export const EXPIRATION_FILTERS = ["all", "soon"] as const;
export type ExpirationFilter = (typeof EXPIRATION_FILTERS)[number];
export const DEFAULT_EXPIRATION_FILTER: ExpirationFilter = "all";
/** "Expiring soon" means within this many milliseconds of now. */
export const EXPIRING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The URL state of `/entity-explorer`, for building links to a run. */
export interface ExplorerLinkFilters extends Record<string, string> {
  q: string;
  pageSize: string;
  expiration: string;
}


/** The URL parameters a query run should be reachable at; defaults are left out. */
export function explorerLinkFilters(
  query: string,
  pageSize: PageSize,
  expiration: ExpirationFilter,
): ExplorerLinkFilters {
  return {
    q: query,
    pageSize: pageSize === DEFAULT_PAGE_SIZE ? "" : pageSize,
    expiration: expiration === DEFAULT_EXPIRATION_FILTER ? "" : expiration,
  };
}

/** Joins with the uppercase keyword; `&&` is a parse error at the node. */
export function appendQueryExpression(current: string, expression: string): string {
  const base = current.trim();
  if (!base) return expression;
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

/** Walks the `cause` chain, since viem wraps the HTTP error several layers deep. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== null && current !== undefined && chain.length < 10) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function isRateLimitError(error: unknown): boolean {
  return errorChain(error).some((link) => {
    if (typeof link !== "object" || link === null) return false;
    if ((link as { status?: unknown }).status === 429) return true;
    const message = (link as { message?: unknown }).message;
    return typeof message === "string" && (message.includes("ANON_RATE_LIMITED") || message.includes("rate limit exceeded"));
  });
}

/** What each SDK `QueryError` kind means, from the query language reference. */
const QUERY_ERRORS: Record<string, { title: string; detail: string }> = {
  parse: { title: "Query syntax error", detail: "The query doesn't parse." },
  type: {
    title: "Type error",
    detail:
      "A condition uses the wrong type for its operator, such as < on an addr, or filters on a field that isn't filterable.",
  },
  literal: {
    title: "Invalid value",
    detail: "A value is invalid, such as an i32 out of range or an address with a bad checksum.",
  },
  limits: { title: "Query too large", detail: "The query goes over a node limit, such as its length or nesting depth." },
  cursor: { title: "Cursor expired", detail: "The page cursor expired. Run the query again." },
  block: {
    title: "Block unavailable",
    detail: "The node no longer keeps the block these pages were read at. Run the query again.",
  },
};

/**
 * The SDK raises a `QueryError` with a `kind` and the node's structured `data`
 * but not its message, so the detail comes from the kind. A parse error also
 * says where, which the page points at under the query.
 */
export function describeQueryError(error: unknown): QueryErrorDescription {
  if (isRateLimitError(error)) {
    return {
      title: "Rate limited",
      detail: "The RPC rate-limits anonymous callers. Wait a moment and run the query again.",
      position: null,
    };
  }
  const { name, kind, data } = (error ?? {}) as Record<string, unknown>;
  if (name === "QueryError" && typeof kind === "string") {
    const known = QUERY_ERRORS[kind] ?? { title: "Query failed", detail: "The node rejected the query." };
    const { position, expected, got } = (data ?? {}) as Record<string, unknown>;
    if (kind !== "parse" || typeof position !== "number") return { ...known, position: null };
    const near = `${typeof expected === "string" ? ` Expected ${expected}` : ""}${typeof got === "string" ? `, got ${got}` : ""}`;
    return { title: known.title, detail: `${known.detail}${near ? `${near}.` : ""}`, position };
  }
  const detail = error instanceof Error && error.message ? error.message : String(error);
  return { title: "Query failed", detail, position: null };
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

export function isPermanentExpiry(expiresAt: bigint): boolean {
  return expiresAt === MAX_EXPIRES_AT;
}

export function estimateBlockTimestampMs(blockNumber: bigint, timing: BlockTiming): number {
  const deltaBlocks = Number(blockNumber - timing.currentBlock);
  return (timing.currentBlockTime + deltaBlocks * timing.blockDuration) * 1000;
}

/** An ISO time for `fmtDate`, or null when the estimate falls outside what a Date can hold. */
export function estimateBlockIso(blockNumber: bigint, timing: BlockTiming): string | null {
  const date = new Date(estimateBlockTimestampMs(blockNumber, timing));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface LifetimeProgress {
  consumedPct: number;
  leftPct: number;
  expired: boolean;
}

export function lifetimeProgress(createdAt: bigint, expiresAt: bigint, currentBlock: bigint): LifetimeProgress {
  if (isPermanentExpiry(expiresAt)) return { consumedPct: 0, leftPct: 100, expired: false };
  const total = Number(expiresAt - createdAt);
  if (total <= 0) return { consumedPct: 100, leftPct: 0, expired: currentBlock >= expiresAt };
  const ratio = Math.max(0, Math.min(1, Number(currentBlock - createdAt) / total));
  const consumedPct = ratio * 100;
  return { consumedPct, leftPct: 100 - consumedPct, expired: currentBlock >= expiresAt };
}

export function isExpiringSoon(
  expiresAt: bigint,
  timing: BlockTiming,
  nowMs: number,
  windowMs: number = EXPIRING_SOON_WINDOW_MS,
): boolean {
  if (isPermanentExpiry(expiresAt)) return false;
  const at = estimateBlockTimestampMs(expiresAt, timing);
  return at >= nowMs && at - nowMs < windowMs;
}

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "in 3 hours", "2 days ago", from a millisecond delta. */
export function formatRelativeMs(targetMs: number, nowMs: number): string {
  if (Number.isNaN(new Date(targetMs).getTime())) {
    return targetMs > nowMs ? "in the far future" : "in the far past";
  }
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
// Examples and the SDK snippet

export interface ExampleQuery {
  label: string;
  query: string;
}

/**
 * Written against the explorer-demo entities seeded on Jalebi; literals are
 * typed constructor calls, and `0x` marks a value to fill in.
 */
export const EXAMPLE_QUERIES: readonly ExampleQuery[] = [
  { label: "By entity key", query: "$key = key(0x)" },
  { label: "By owner", query: "$owner = addr(0x)" },
  { label: "By schema", query: "arkiv.schema = str('explorer-demo.posts')" },
  { label: "Decimal range", query: "arkiv.schema = str('explorer-demo.sensors') AND temperature < dec(20)" },
  { label: "Text prefix", query: "device STARTSWITH str('warsaw')" },
  { label: "Same name, other type", query: "TYPEOF(score) = i32" },
  { label: "Latest entities", query: "$expiresAt >= u64(0)" },
];

function templateLiteral(text: string): string {
  return `\`${text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

/** The same query as SDK code, so a reader can take it from the page into their own app. */
export function typescriptSnippet(query: string, sdkVersion: string): string {
  const normalized = normalizeQueryInput(query) || "<QUERY>";
  // The node is left to fill in, so the snippet does not tie a reader's app to
  // the testnet this page happens to read.
  return `// @arkiv-network/sdk ${sdkVersion}
import { createPublicClient } from "@arkiv-network/sdk"
import { http } from "viem"

const publicClient = createPublicClient({
  transport: http("<RPC URL>"),
})

// A raw query string goes to the node unchecked. Through a schema,
// select().from(Schema).where(...) types and checks every column.
const { entities } = await publicClient.query(${templateLiteral(normalized)}, {
  select: { $key: true, $owner: true, $attributes: true },
  limit: 50,
})

for (const row of entities) {
  for (const [name, attribute] of Object.entries(row.$attributes)) {
    console.log(row.$key, name, attribute.type, attribute.value)
  }
}`;
}
