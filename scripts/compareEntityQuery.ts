#!/usr/bin/env bun
/**
 * Differential (and timing) check of the experimental entity index against a
 * real node.
 *
 * Two sources answer the same `arkiv_*` questions: a node — any URL that serves
 * `arkiv_query`, such as the pooled `rpc-proxy` or the indexer's own
 * `/shadow-rpc`, which relays those methods — and the indexer's
 * `/shadow-rpc/experimental`. This script asks both the same questions at the
 * same block and reports every difference: result order, every selected
 * field, page boundaries, counts, `arkiv_getEntity`, and the error
 * code/message/position for invalid input.
 *
 * What the index cannot see is kept out of the comparison rather than papered
 * over. Entities created before the index floor are unknown to it, and
 * results come newest-first on both sides, so a node page walk is cut at the
 * first entity older than the floor and the index must match that prefix
 * exactly. Counts are compared inside a `$createdAt >= u64(<floor>)` window
 * (slow on the node — a range scan — so only the first few generic queries
 * get one; fixture queries need no window). The payload is never selected,
 * and a `creationFlags` the index reports as `null` (a creation it knows from
 * calldata only) is counted, not flagged.
 *
 * Cursors are opaque and differ by construction — the node resumes below an
 * internal entity id, the index below a creation position — so only their
 * presence (does a next page exist) is compared, never their bytes.
 *
 * The query set is discovered from the data — owners, attribute values and
 * types seen on the first pages of `*` become equality, range, prefix and
 * boolean-combination queries — and extended by the fixture manifest that
 * `seedEntityQueryFixtures.ts` writes, which also pins the blocks its
 * transactions landed in so both sides are compared block-exactly around
 * every mutation.
 *
 * Usage:
 *   bun run scripts/compareEntityQuery.ts \
 *     --node http://172.21.0.2:8788 \
 *     --index http://127.0.0.1:3100/shadow-rpc/experimental \
 *     [--manifest fixtures.json] [--bench 20]
 *
 * Options:
 *   --at-block <n|0xhex>   block to evaluate at (default: the index head)
 *   --since-block <n>      index floor (default: read from /health next to --index)
 *   --health <url>         where to read the floor
 *   --queries <file>       JSON array of extra query strings
 *   --manifest <file>      fixture manifest from seedEntityQueryFixtures.ts
 *   --limit <n>            page size (default 100)
 *   --max-pages <n>        pages per query per side (default 50)
 *   --window-counts <n>    generic queries that also get a windowed count (default 6)
 *   --bench <n>            time each query n times per side (default 0 = off)
 *   --concurrency <n>      parallel requests in the throughput run (default 8)
 *   --bench-seconds <n>    throughput run length per side (default 10)
 *   --report <file>        write the machine-readable report here (JSON)
 *   --verbose              print every request
 *
 * Exit status is 1 when any difference was found.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI

const { values: args } = parseArgs({
  options: {
    node: { type: "string" },
    index: { type: "string" },
    "at-block": { type: "string" },
    "since-block": { type: "string" },
    health: { type: "string" },
    queries: { type: "string" },
    manifest: { type: "string" },
    limit: { type: "string", default: "100" },
    "max-pages": { type: "string", default: "50" },
    "window-counts": { type: "string", default: "6" },
    bench: { type: "string", default: "0" },
    concurrency: { type: "string", default: "8" },
    "bench-seconds": { type: "string", default: "10" },
    report: { type: "string" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help || !args.node || !args.index) {
  console.log(
    "usage: bun run scripts/compareEntityQuery.ts --node <url> --index <url> [--at-block n] [--since-block n]\n" +
      "       [--queries file.json] [--manifest fixtures.json] [--limit 100] [--max-pages 50] [--window-counts 6]\n" +
      "       [--bench 20 --concurrency 8 --bench-seconds 10] [--report out.json] [--verbose]",
  );
  process.exit(args.help ? 0 : 2);
}

const PAGE_LIMIT = Number(args.limit);
const MAX_PAGES = Number(args["max-pages"]);
const WINDOW_COUNTS = Number(args["window-counts"]);
const BENCH_ROUNDS = Number(args.bench);
const CONCURRENCY = Number(args.concurrency);
const BENCH_SECONDS = Number(args["bench-seconds"]);
const VERBOSE = args.verbose;

// ---------------------------------------------------------------------------
// JSON-RPC plumbing

interface RpcSource {
  name: "node" | "index";
  url: string;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcOutcome {
  result?: unknown;
  error?: RpcError;
  ms: number;
}

const NODE: RpcSource = { name: "node", url: args.node };
const INDEX: RpcSource = { name: "index", url: args.index };
const SOURCES = [NODE, INDEX] as const;

let nextId = 1;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const USER_AGENT = "Mozilla/5.0 (compatible; compareEntityQuery/1.0)";

/**
 * A relay caps how many calls it forwards upstream (600 a minute by default),
 * so a comparison run outruns the relay long before it outruns the node. The
 * correctness phases wait that cap out, because a refusal there is not a real
 * disagreement; the benchmark counts refusals instead, because pausing would
 * measure the cap rather than the two engines.
 */
const RATE_LIMIT_CODE = -32005;
let rateLimitPauses = 0;
let rateLimitedCalls = 0;
let benchMode = false;

function isRateLimited(error: RpcError | undefined): boolean {
  return error !== undefined && error.code === RATE_LIMIT_CODE && /rate limited/i.test(error.message);
}

async function rpc(source: RpcSource, method: string, params: unknown[]): Promise<RpcOutcome> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(source.url, {
        method: "POST",
        // Cloudflare fronts some edges and answers non-browser agents with 403.
        headers: { "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
    } catch (error) {
      if (attempt >= 5) throw new Error(`${source.name}: ${method} failed after ${attempt} attempts: ${String(error)}`);
      await Bun.sleep(250 * attempt);
      continue;
    }
    const text = await response.text();
    const ms = performance.now() - started;
    if (RETRYABLE_STATUS.has(response.status) && attempt < 5) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "0");
      await Bun.sleep(Math.max(250 * attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
      continue;
    }
    let body: { result?: unknown; error?: RpcError };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new Error(`${source.name}: ${method} answered HTTP ${response.status} with non-JSON: ${text.slice(0, 200)}`);
    }
    if (VERBOSE) {
      const summary = body.error ? `error ${body.error.code} ${body.error.message}` : "ok";
      console.log(`  [${source.name}] ${method} ${JSON.stringify(params).slice(0, 120)} → ${summary} (${ms.toFixed(1)}ms)`);
    }
    if (isRateLimited(body.error)) {
      rateLimitedCalls += 1;
      if (!benchMode && attempt < 12) {
        rateLimitPauses += 1;
        if (rateLimitPauses === 1 || rateLimitPauses % 25 === 0) {
          console.log(`  … ${source.name} refused a forwarded call as rate limited, waiting it out (${rateLimitPauses} pause(s) so far)`);
        }
        await Bun.sleep(Math.min(15_000, 3_000 * attempt));
        continue;
      }
    }
    if (body.error) return { error: body.error, ms };
    return { result: body.result, ms };
  }
}

// ---------------------------------------------------------------------------
// Findings

interface Finding {
  scope: string;
  detail: string;
}

const findings: Finding[] = [];
let checks = 0;
let creationFlagsUnknown = 0;

function diff(scope: string, detail: string): void {
  findings.push({ scope, detail });
  console.log(`  DIFF ${scope}: ${detail}`);
}

function short(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Deep JSON equality with the one tolerance the index documents: `creationFlags: null` on its side. */
function sameJson(a: unknown, b: unknown, path: string, out: string[]): void {
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: length ${a.length} vs ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) sameJson(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const key of keys) {
      const sub = path ? `${path}.${key}` : key;
      if (key === "creationFlags" && bo[key] === null && ao[key] !== null) {
        creationFlagsUnknown += 1;
        continue;
      }
      if (!(key in ao)) out.push(`${sub}: missing on node, index has ${short(bo[key])}`);
      else if (!(key in bo)) out.push(`${sub}: missing on index, node has ${short(ao[key])}`);
      else sameJson(ao[key], bo[key], sub, out);
    }
    return;
  }
  out.push(`${path}: ${short(a)} vs ${short(b)}`);
}

// ---------------------------------------------------------------------------
// Helpers

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

const FULL_SELECT = {
  key: true,
  owner: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  creationFlags: true,
  contentType: true,
  attributeSchema: true,
  attributes: true,
};

function windowed(query: string, since: bigint | undefined): string {
  if (since === undefined) return query;
  const window = `$createdAt >= u64(${since})`;
  return query.trim() === "*" ? window : `(${query}) AND ${window}`;
}

function quoteStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface WireAttribute {
  name: string;
  type: string;
  value: unknown;
}

interface WireEntity {
  key: string;
  owner?: string;
  creator?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  contentType?: string;
  attributes?: WireAttribute[];
  [field: string]: unknown;
}

/** The query literal for a wire value, or undefined for a type that cannot be written. */
function literalFor(attribute: WireAttribute): string | undefined {
  const { type, value } = attribute;
  switch (type) {
    case "bool":
      return String(Boolean(value));
    case "i32":
      return `i32(${Number(value)})`;
    case "u64":
      return `u64(${BigInt(String(value))})`;
    case "u256":
      return `u256(${BigInt(String(value))})`;
    case "dec":
      return `dec(${String(value)})`;
    case "bytes32":
      return `bytes32(${String(value)})`;
    case "str":
      return `str(${quoteStr(String(value))})`;
    case "addr":
      return `addr(${String(value)})`;
    case "key":
      return `key(${String(value)})`;
    default:
      return undefined;
  }
}

const ORDERED_TYPES = new Set(["i32", "u64", "u256", "dec"]);

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

// ---------------------------------------------------------------------------
// Page walks

interface Walk {
  entities: WireEntity[];
  /** Whether each page came with a cursor (a next page exists). */
  hasMore: boolean[];
  pageMs: number[];
  error?: RpcError;
  /** Stopped by --max-pages. */
  truncated: boolean;
  /** Cut at the first entity older than the floor. */
  cutAtFloor: boolean;
  blockNumbers: Set<string>;
}

async function walk(source: RpcSource, query: string, block: bigint, limit: number, maxPages: number, stopBelow?: bigint): Promise<Walk> {
  const out: Walk = { entities: [], hasMore: [], pageMs: [], truncated: false, cutAtFloor: false, blockNumbers: new Set() };
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const options: Record<string, unknown> = { atBlock: hex(block), select: FULL_SELECT, limit };
    if (cursor) options.cursor = cursor;
    const outcome = await rpc(source, "arkiv_query", [query, options]);
    out.pageMs.push(outcome.ms);
    if (outcome.error) {
      out.error = outcome.error;
      return out;
    }
    const result = outcome.result as { data: WireEntity[]; blockNumber: string; cursor?: string };
    out.blockNumbers.add(result.blockNumber);
    out.hasMore.push(result.cursor !== undefined);
    if (stopBelow !== undefined) {
      const cut = result.data.findIndex((entity) => entity.createdAt !== undefined && BigInt(entity.createdAt) < stopBelow);
      if (cut >= 0) {
        out.entities.push(...result.data.slice(0, cut));
        out.cutAtFloor = true;
        return out;
      }
    }
    out.entities.push(...result.data);
    cursor = result.cursor;
    if (!cursor) return out;
  }
  out.truncated = true;
  return out;
}

interface QueryReport {
  label: string;
  query: string;
  block: string;
  entities: number;
  pages: number;
  count?: { query: string; node: number | string; index: number | string };
  nodeMsPerPage: number;
  indexMsPerPage: number;
  ok: boolean;
}

const queryReports: QueryReport[] = [];

interface CompareOptions {
  /** Cut node walks at this floor; window the count with it. */
  since?: bigint | undefined;
  /** Compare counts (windowed when `since` is set — slow on the node). */
  count: boolean;
}

/** Compare one query end to end: page walk, page boundaries, count and a few getEntity spot checks. */
async function compareQuery(label: string, query: string, block: bigint, options: CompareOptions): Promise<WireEntity[]> {
  const before = findings.length;
  const [node, index] = await Promise.all(SOURCES.map((source) => walk(source, query, block, PAGE_LIMIT, MAX_PAGES, options.since)));
  checks += 1;
  const report: QueryReport = {
    label,
    query,
    block: block.toString(),
    entities: 0,
    pages: node!.pageMs.length,
    nodeMsPerPage: mean(node!.pageMs),
    indexMsPerPage: mean(index!.pageMs),
    ok: true,
  };

  if (node!.error || index!.error) {
    if (!node!.error || !index!.error) {
      diff(label, `only one side failed: node ${short(node!.error ?? "ok")}, index ${short(index!.error ?? "ok")}`);
    } else if (node!.error.code !== index!.error.code || node!.error.message !== index!.error.message) {
      diff(label, `both failed differently: node ${short(node!.error)}, index ${short(index!.error)}`);
    }
    report.ok = findings.length === before;
    queryReports.push(report);
    console.log(`${report.ok ? "ok  " : "DIFF"} ${label}: both sides answered an error (${short(node!.error ?? index!.error, 80)})`);
    return [];
  }

  for (const side of [node!, index!]) {
    const seen = [...side.blockNumbers];
    if (seen.length !== 1 || seen[0] !== hex(block)) {
      diff(label, `${side === node ? "node" : "index"} answered blockNumber ${seen.join(",")} for atBlock ${hex(block)}`);
    }
  }

  const nodeKeys = node!.entities.map((entity) => entity.key);
  const indexKeys = index!.entities.map((entity) => entity.key);
  report.entities = nodeKeys.length;
  if (nodeKeys.length !== indexKeys.length) {
    const nodeSet = new Set(nodeKeys);
    const indexSet = new Set(indexKeys);
    const onlyNode = nodeKeys.filter((key) => !indexSet.has(key));
    const onlyIndex = indexKeys.filter((key) => !nodeSet.has(key));
    diff(
      label,
      `${nodeKeys.length} entities on the node vs ${indexKeys.length} on the index` +
        (onlyNode.length ? `; only node: ${onlyNode.slice(0, 3).join(", ")}${onlyNode.length > 3 ? ` (+${onlyNode.length - 3})` : ""}` : "") +
        (onlyIndex.length ? `; only index: ${onlyIndex.slice(0, 3).join(", ")}${onlyIndex.length > 3 ? ` (+${onlyIndex.length - 3})` : ""}` : ""),
    );
  } else {
    let orderDiffs = 0;
    for (let i = 0; i < nodeKeys.length; i++) {
      if (nodeKeys[i] !== indexKeys[i]) {
        if (orderDiffs < 3) diff(label, `position ${i}: node ${nodeKeys[i]} vs index ${indexKeys[i]}`);
        orderDiffs += 1;
      }
    }
    if (orderDiffs > 3) diff(label, `…and ${orderDiffs - 3} more positions differ`);
    if (orderDiffs === 0) {
      let fieldDiffs = 0;
      for (let i = 0; i < node!.entities.length; i++) {
        const problems: string[] = [];
        sameJson(node!.entities[i], index!.entities[i], "", problems);
        for (const problem of problems) {
          if (fieldDiffs < 5) diff(label, `${nodeKeys[i]}: ${problem}`);
          fieldDiffs += 1;
        }
      }
      if (fieldDiffs > 5) diff(label, `…and ${fieldDiffs - 5} more field differences`);
    }
  }

  // Page boundaries: the same pages must exist on both sides. When the node
  // walk was cut at the floor its later pages hold entities the index never
  // had, so only the pages before the cut are comparable.
  const comparablePages = node!.cutAtFloor ? node!.hasMore.length - 1 : node!.hasMore.length;
  for (let i = 0; i < comparablePages; i++) {
    if (index!.hasMore[i] === undefined) {
      diff(label, `page ${i + 1}: the node has it, the index walk ended after ${index!.hasMore.length} page(s)`);
      break;
    }
    if (node!.hasMore[i] !== index!.hasMore[i]) {
      diff(label, `page ${i + 1}: node ${node!.hasMore[i] ? "has" : "has no"} next page, index ${index!.hasMore[i] ? "has" : "has no"} next page`);
      break;
    }
  }

  if (options.count) {
    const countQuery = windowed(query, options.since);
    const [nodeCount, indexCount] = await Promise.all(
      SOURCES.map((source) => rpc(source, "arkiv_getEntityCount", [{ query: countQuery, block: Number(block) }])),
    );
    const counts = {
      query: countQuery,
      node: nodeCount!.error ? `error ${nodeCount!.error.code}` : (nodeCount!.result as number),
      index: indexCount!.error ? `error ${indexCount!.error.code}` : (indexCount!.result as number),
    };
    report.count = counts;
    if (counts.node !== counts.index) diff(label, `count ${counts.node} on the node vs ${counts.index} on the index`);
    if (!node!.truncated && typeof counts.node === "number" && counts.node !== nodeKeys.length) {
      diff(label, `node count ${counts.node} but the page walk returned ${nodeKeys.length}`);
    }
  }

  // getEntity spot checks: first, middle and last of the walk.
  const sample = [...new Set([node!.entities[0], node!.entities[Math.floor(node!.entities.length / 2)], node!.entities.at(-1)])].filter(
    (entity): entity is WireEntity => entity !== undefined,
  );
  for (const entity of sample) await compareGetEntity(label, entity.key, block);

  report.ok = findings.length === before;
  queryReports.push(report);
  const status = report.ok ? "ok  " : "DIFF";
  console.log(
    `${status} ${label}: ${nodeKeys.length} entities in ${node!.pageMs.length} page(s)` +
      (node!.cutAtFloor ? " (cut at the floor)" : node!.truncated ? " (max pages)" : "") +
      (report.count ? `, count ${report.count.node}` : "") +
      `; node ${mean(node!.pageMs).toFixed(0)}ms/page, index ${mean(index!.pageMs).toFixed(0)}ms/page`,
  );
  return node!.entities;
}

async function compareGetEntity(label: string, key: string, block: bigint | undefined): Promise<void> {
  checks += 1;
  const params: unknown[] = block === undefined ? [key] : [key, Number(block)];
  const [node, index] = await Promise.all(SOURCES.map((source) => rpc(source, "arkiv_getEntity", params)));
  if (node!.error || index!.error) {
    if (!node!.error || !index!.error || node!.error.code !== index!.error.code) {
      diff(`${label} getEntity ${key}`, `node ${short(node!.error ?? "ok")}, index ${short(index!.error ?? "ok")}`);
    }
    return;
  }
  const nodeEntity = node!.result as Record<string, unknown> | null;
  const indexEntity = index!.result as Record<string, unknown> | null;
  if (nodeEntity === null || indexEntity === null) {
    if (nodeEntity !== indexEntity) diff(`${label} getEntity ${key}`, `node ${short(nodeEntity)}, index ${short(indexEntity)}`);
    return;
  }
  // The index never holds payload bytes and leaves the field out.
  const { payload: _payload, ...nodeWithoutPayload } = nodeEntity;
  const problems: string[] = [];
  sameJson(nodeWithoutPayload, indexEntity, "", problems);
  for (const problem of problems.slice(0, 5)) diff(`${label} getEntity ${key}`, problem);
}

// ---------------------------------------------------------------------------
// Error parity

interface ErrorCase {
  label: string;
  query: string;
  options?: Record<string, unknown>;
  /** -32006 carries each side's own `latest`; only the code is comparable. */
  codeOnly?: boolean;
}

function errorCases(head: bigint): ErrorCase[] {
  const many = Array.from({ length: 65 }, (_, i) => `a${i} = ${i}`).join(" AND ");
  const deep = `${"(".repeat(33)}x = 1${")".repeat(33)}`;
  const huge = `x = str('${"a".repeat(100)}')${" OR x = 1".repeat(900)}`;
  return [
    { label: "empty query", query: "" },
    { label: "star with predicate", query: "* AND x = 1" },
    { label: "double equals", query: "x == 1" },
    { label: "not-equals", query: "x != 1" },
    { label: "updatedAt not queryable", query: "$updatedAt > u64(1)" },
    { label: "payload not queryable", query: "$payload = str('a')" },
    { label: "stray paren", query: "x = str('a'))" },
    { label: "unclosed paren", query: "(x = 1" },
    { label: "dangling AND", query: "x = 1 AND" },
    { label: "bare NOT", query: "NOT" },
    { label: "i32 overflow", query: "x = i32(2147483648)" },
    { label: "negative u64", query: "x = u64(-1)" },
    { label: "u64 overflow", query: "x = u64(18446744073709551616)" },
    { label: "dec too many places", query: "x = dec(1.1234567890123456789)" },
    { label: "STARTSWITH on i32", query: "x STARTSWITH i32(1)" },
    { label: "range on str", query: "x > str('a')" },
    { label: "range on bool", query: "x >= true" },
    { label: "bare address for owner", query: "$owner = 0xabc" },
    { label: "bad checksum", query: "x = addr(0xAbCdEf0123456789AbCdEf0123456789AbCdEf01)" },
    { label: "short key", query: "$key = key(0x12)" },
    { label: "reserved word as name", query: "and = true" },
    { label: "bare string on user attr", query: "x = 'str'" },
    { label: "bare int on builtin", query: "$expiresAt > 5" },
    { label: "string too long", query: `x = str('${"b".repeat(129)}')` },
    { label: "name too long", query: `${"n".repeat(33)} = 1` },
    { label: "too many predicates", query: many },
    { label: "too deep", query: deep },
    { label: "too long", query: huge },
    { label: "limit 0", query: "*", options: { limit: 0 } },
    { label: "limit 201", query: "*", options: { limit: 201 } },
    { label: "limit as string", query: "*", options: { limit: "abc" } },
    { label: "unknown option", query: "*", options: { bogus: 1 } },
    { label: "unknown select field", query: "*", options: { select: { bogus: true } } },
    { label: "select not an object", query: "*", options: { select: 5 } },
    { label: "atBlock pending", query: "*", options: { atBlock: "pending" } },
    { label: "atBlock number", query: "*", options: { atBlock: 5 } },
    { label: "atBlock far ahead", query: "*", options: { atBlock: hex(head + 100_000_000n) }, codeOnly: true },
    { label: "cursor not a string", query: "*", options: { cursor: 5 } },
    { label: "cursor malformed", query: "*", options: { cursor: "b64:not-base64!" } },
    { label: "cursor garbage", query: "*", options: { cursor: "nope" } },
    { label: "cursor wrong length", query: "*", options: { cursor: "b64:AAAA" } },
    { label: "cursor from another query", query: "*", options: { cursor: "b64:AAAAAAAAAAAAAAAAAAAAAA" } },
  ];
}

async function compareErrors(head: bigint): Promise<void> {
  console.log("\nError parity");
  const cases = errorCases(head);
  const before = findings.length;
  for (const testCase of cases) {
    checks += 1;
    const params: unknown[] = testCase.options ? [testCase.query, testCase.options] : [testCase.query];
    const [node, index] = await Promise.all(SOURCES.map((source) => rpc(source, "arkiv_query", params)));
    const label = `error/${testCase.label}`;
    if (!node!.error || !index!.error) {
      diff(label, `node ${short(node!.error ?? "ok")}, index ${short(index!.error ?? "ok")}`);
      continue;
    }
    if (node!.error.code !== index!.error.code) {
      diff(label, `code ${node!.error.code} (${node!.error.message}) vs ${index!.error.code} (${index!.error.message})`);
      continue;
    }
    if (testCase.codeOnly) continue;
    if (node!.error.message !== index!.error.message) {
      // The node wraps serde's option-parsing errors in a Debug dump of its
      // own error object (`ErrorObject { code: InvalidParams, … data:
      // Some(RawValue("<the message> at line 1 column 7")) }`); the index
      // answers the message itself. Parity there means the index says what
      // serde said, minus the byte position in the request.
      const wrapped = /RawValue\("(.*)"\)\)/.exec(node!.error.message);
      const inner = wrapped ? wrapped[1]!.replace(/\\"/g, '"').replace(/ at line \d+ column \d+$/, "") : undefined;
      if (inner === undefined || !index!.error.message.includes(inner)) {
        diff(label, `message ${JSON.stringify(node!.error.message)} vs ${JSON.stringify(index!.error.message)}`);
      }
      continue;
    }
    const problems: string[] = [];
    sameJson(node!.error.data ?? null, index!.error.data ?? null, "data", problems);
    for (const problem of problems) diff(label, problem);
  }
  const bad = findings.length - before;
  console.log(`${bad === 0 ? "ok  " : "DIFF"} ${cases.length} invalid requests compared, ${bad} difference(s)`);
}

// ---------------------------------------------------------------------------
// Query discovery

function discoverQueries(entities: WireEntity[], head: bigint, since: bigint | undefined): string[] {
  const queries: string[] = [];
  const owners = [...new Set(entities.map((entity) => entity.owner).filter((owner): owner is string => typeof owner === "string"))];
  const creators = [...new Set(entities.map((entity) => entity.creator).filter((c): c is string => typeof c === "string"))];
  const contentTypes = [...new Set(entities.map((entity) => entity.contentType).filter((c): c is string => typeof c === "string"))];
  for (const owner of owners.slice(0, 3)) queries.push(`$owner = addr(${owner})`);
  if (owners[0]) queries.push(`$owner = '${owners[0]}'`);
  for (const creator of creators.slice(0, 2)) queries.push(`$creator = addr(${creator})`);
  for (const contentType of contentTypes.slice(0, 2)) queries.push(`$contentType = ${quoteStr(contentType)}`);
  if (entities[0]) queries.push(`$key = key(${entities[0].key})`);
  queries.push(`$expiresAt > u64(${head + 10_000n})`, `$expiresAt <= u64(${head + 10_000n})`);
  if (since !== undefined) queries.push(`$createdAt < u64(${since + 1_000n})`);
  queries.push(`$createdAt >= u64(${head > 500n ? head - 500n : 0n})`);

  // Attribute-driven: one equality per (name, type), a range for ordered
  // types, a prefix for strings, then combinations. The most common names
  // carry it; a long tail of one-off names would multiply the run time
  // without adding a new case.
  const byName = new Map<string, WireAttribute[]>();
  for (const entity of entities) {
    for (const attribute of entity.attributes ?? []) {
      const list = byName.get(attribute.name) ?? [];
      list.push(attribute);
      byName.set(attribute.name, list);
    }
  }
  const commonNames = [...byName.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  const equalityQueries: string[] = [];
  for (const [name, values] of commonNames) {
    const sample = values[Math.floor(values.length / 2)]!;
    const literal = literalFor(sample);
    if (!literal) continue;
    equalityQueries.push(`${name} = ${literal}`);
    if (ORDERED_TYPES.has(sample.type)) {
      queries.push(`${name} >= ${literal}`, `${name} < ${literal}`, `${name} > ${literal} OR ${name} <= ${literal}`);
    }
    if (sample.type === "str" && String(sample.value).length >= 2) {
      queries.push(`${name} STARTSWITH str(${quoteStr(String(sample.value).slice(0, 2))})`);
      queries.push(`${name} STARTSWITH str('')`);
    }
    if (sample.type === "i32") queries.push(`${name} = ${Number(sample.value)}`);
    if (sample.type === "bool") queries.push(`${name} = ${!sample.value}`, `NOT ${name} = ${sample.value}`);
  }
  queries.push(...equalityQueries);
  if (equalityQueries.length >= 2) {
    queries.push(`${equalityQueries[0]} AND ${equalityQueries[1]}`);
    queries.push(`${equalityQueries[0]} OR ${equalityQueries[1]}`);
    queries.push(`NOT (${equalityQueries[0]}) AND ${equalityQueries[1]}`);
    queries.push(`(${equalityQueries[0]} OR ${equalityQueries[1]}) AND NOT ${equalityQueries[0]}`);
  }
  if (equalityQueries[0] && owners[0]) queries.push(`$owner = addr(${owners[0]}) AND NOT ${equalityQueries[0]}`);
  queries.push("nosuchattribute_zz = 1", "nosuchattribute_zz STARTSWITH str('x') OR $owner = addr(0x0000000000000000000000000000000000000000)");
  queries.push("-- a comment\n* ");
  return [...new Set(queries)];
}

// ---------------------------------------------------------------------------
// Fixture manifest

interface Manifest {
  suite: string;
  run: string;
  queries?: string[];
  entities?: Record<string, string>;
  checkpoints?: number[];
}

async function compareManifest(manifest: Manifest, head: bigint): Promise<void> {
  console.log(`\nFixture suite ${manifest.suite} run ${manifest.run}`);
  const suiteQuery = `suite = str(${quoteStr(manifest.suite)}) AND run = str(${quoteStr(manifest.run)})`;
  await compareQuery("fixtures/all", suiteQuery, head, { count: true });
  for (const query of manifest.queries ?? []) {
    await compareQuery(`fixtures/${short(query, 70)}`, `(${query}) AND ${suiteQuery}`, head, { count: true });
  }
  for (const [name, key] of Object.entries(manifest.entities ?? {})) {
    await compareGetEntity(`fixtures/${name}`, key, head);
  }
  // Block-exact: the state right before and right at every mutation the seed
  // recorded, so a transition applied one block early or late shows up.
  const checkpoints = [...new Set(manifest.checkpoints ?? [])].filter((block) => BigInt(block) <= head).sort((a, b) => a - b);
  for (const checkpoint of checkpoints) {
    await compareQuery(`fixtures/all@${checkpoint}`, suiteQuery, BigInt(checkpoint), { count: true });
    for (const [name, key] of Object.entries(manifest.entities ?? {})) {
      await compareGetEntity(`fixtures/${name}@${checkpoint}`, key, BigInt(checkpoint));
    }
  }
}

// ---------------------------------------------------------------------------
// Timing

interface Stats {
  n: number;
  errors: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

function stats(samples: number[], errors: number): Stats {
  return {
    n: samples.length,
    errors,
    mean: mean(samples),
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples.length ? Math.max(...samples) : 0,
  };
}

function formatStats(s: Stats): string {
  return `n=${s.n} mean ${s.mean.toFixed(1)}ms p50 ${s.p50.toFixed(1)}ms p95 ${s.p95.toFixed(1)}ms max ${s.max.toFixed(1)}ms${s.errors ? ` errors ${s.errors}` : ""}`;
}

interface BenchCase {
  label: string;
  method: "arkiv_query" | "arkiv_getEntityCount" | "arkiv_getEntity";
  params: (block: bigint | "latest") => unknown[];
}

interface BenchRow {
  label: string;
  at: string;
  node: Stats;
  index: Stats;
}

function benchCases(queries: string[], since: bigint | undefined, sampleKey: string | undefined): BenchCase[] {
  const cases: BenchCase[] = queries.map((query) => ({
    label: `query ${short(query, 60)}`,
    method: "arkiv_query",
    params: (block) => [query, { ...(block === "latest" ? {} : { atBlock: hex(block) }), select: FULL_SELECT, limit: PAGE_LIMIT }],
  }));
  cases.push({
    label: "query * keys only, limit 200",
    method: "arkiv_query",
    params: (block) => ["*", { ...(block === "latest" ? {} : { atBlock: hex(block) }), limit: 200 }],
  });
  if (since !== undefined) {
    cases.push({
      label: `query $createdAt >= u64(${since}) (range scan)`,
      method: "arkiv_query",
      params: (block) => [`$createdAt >= u64(${since})`, { ...(block === "latest" ? {} : { atBlock: hex(block) }), select: FULL_SELECT, limit: PAGE_LIMIT }],
    });
  }
  cases.push({ label: "count *", method: "arkiv_getEntityCount", params: (block) => [block === "latest" ? {} : { block: Number(block) }] });
  if (queries[1]) {
    const query = queries[1];
    cases.push({ label: `count ${short(query, 50)}`, method: "arkiv_getEntityCount", params: (block) => [block === "latest" ? { query } : { query, block: Number(block) }] });
  }
  if (sampleKey) {
    cases.push({ label: "getEntity", method: "arkiv_getEntity", params: (block) => (block === "latest" ? [sampleKey] : [sampleKey, Number(block)]) });
  }
  return cases;
}

async function benchSequential(cases: BenchCase[], block: bigint, rounds: number): Promise<BenchRow[]> {
  console.log(`\nLatency, ${rounds} sequential rounds per request per side, at each side's latest and at block ${block}`);
  const rows: BenchRow[] = [];
  for (const testCase of cases) {
    for (const at of ["latest", block] as const) {
      const samples = { node: [] as number[], index: [] as number[] };
      const errors = { node: 0, index: 0 };
      for (let round = 0; round < rounds; round++) {
        for (const source of SOURCES) {
          const outcome = await rpc(source, testCase.method, testCase.params(at));
          if (outcome.error) errors[source.name] += 1;
          else samples[source.name].push(outcome.ms);
        }
      }
      const row = { label: testCase.label, at: at === "latest" ? "latest" : `block ${block}`, node: stats(samples.node, errors.node), index: stats(samples.index, errors.index) };
      rows.push(row);
      console.log(`  ${row.label} @ ${row.at}\n    node  ${formatStats(row.node)}\n    index ${formatStats(row.index)}`);
    }
  }
  return rows;
}

async function benchThroughput(source: RpcSource, cases: BenchCase[], block: bigint, concurrency: number, seconds: number): Promise<Stats & { perSecond: number }> {
  const deadline = performance.now() + seconds * 1000;
  const samples: number[] = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (performance.now() < deadline) {
      const testCase = cases[next++ % cases.length]!;
      const outcome = await rpc(source, testCase.method, testCase.params(block));
      if (outcome.error) errors += 1;
      else samples.push(outcome.ms);
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  return { ...stats(samples, errors), perSecond: (samples.length + errors) / elapsed };
}

// ---------------------------------------------------------------------------
// Main

async function readFloor(): Promise<bigint | undefined> {
  if (args["since-block"]) return BigInt(args["since-block"]);
  const healthUrl = args.health ?? args.index!.replace(/\/shadow-rpc\/experimental\/?$/, "/health");
  try {
    const response = await fetch(healthUrl, { headers: { "user-agent": USER_AGENT } });
    const health = (await response.json()) as { features?: { entityQueryIndex?: { floorBlock?: string | null } | false } };
    const feature = health.features?.entityQueryIndex;
    if (feature && feature.floorBlock) return BigInt(feature.floorBlock);
  } catch (error) {
    console.log(`could not read the index floor from ${healthUrl}: ${String(error)}`);
  }
  return undefined;
}

async function main(): Promise<void> {
  const since = await readFloor();
  let block: bigint;
  if (args["at-block"]) {
    block = BigInt(args["at-block"]);
  } else {
    const probe = await rpc(INDEX, "arkiv_query", ["*", { limit: 1 }]);
    if (probe.error) throw new Error(`index probe failed: ${short(probe.error)}`);
    block = BigInt((probe.result as { blockNumber: string }).blockNumber);
  }
  const nodeProbe = await rpc(NODE, "arkiv_query", ["*", { limit: 1 }]);
  if (nodeProbe.error) throw new Error(`node probe failed: ${short(nodeProbe.error)}`);
  const nodeHead = BigInt((nodeProbe.result as { blockNumber: string }).blockNumber);
  console.log(
    `node ${NODE.url} (head ${nodeHead})\nindex ${INDEX.url}\ncomparing at block ${block}` +
      (since !== undefined ? `; the index floor is block ${since}, node walks are cut there` : ""),
  );

  console.log("\nDiscovery");
  const seed = await compareQuery("*", "*", block, { since, count: WINDOW_COUNTS > 0 });
  const discovered = discoverQueries(seed, block, since);
  const extra: string[] = args.queries ? (JSON.parse(readFileSync(args.queries, "utf8")) as string[]) : [];
  console.log(`\nDiscovered ${discovered.length} queries from the data${extra.length ? `, ${extra.length} from --queries` : ""}`);
  let windowedCounts = 1;
  for (const query of [...discovered, ...extra]) {
    const count = windowedCounts < WINDOW_COUNTS;
    if (count) windowedCounts += 1;
    await compareQuery(short(query, 90), query, block, { since, count });
  }

  // Historical: the same discovered queries a few hundred blocks back.
  if (since === undefined || block - 300n > since) {
    const past = block - 300n;
    console.log(`\nHistorical, at block ${past}`);
    for (const query of ["*", ...discovered.slice(0, 8)]) await compareQuery(`${short(query, 80)} @${past}`, query, past, { since, count: false });
  }

  let manifest: Manifest | undefined;
  if (args.manifest) {
    manifest = JSON.parse(readFileSync(args.manifest, "utf8")) as Manifest;
    await compareManifest(manifest, block);
  }

  await compareErrors(block);

  // A key nobody owns.
  await compareGetEntity("missing key", `0x${"ab".repeat(32)}`, block);

  let bench: { latency: BenchRow[]; throughput: Record<string, Stats & { perSecond: number }> } | undefined;
  if (BENCH_ROUNDS > 0) {
    const benchQueries = ["*", ...discovered.filter((query) => !query.startsWith("$createdAt") && !query.startsWith("$expiresAt")).slice(0, 8)];
    if (manifest) benchQueries.push(`suite = str(${quoteStr(manifest.suite)}) AND run = str(${quoteStr(manifest.run)})`);
    const cases = benchCases(benchQueries, since, seed[0]?.key);
    const refusedBefore = rateLimitedCalls;
    benchMode = true;
    const latency = await benchSequential(cases, block, BENCH_ROUNDS);
    console.log(`\nThroughput, ${CONCURRENCY} concurrent clients for ${BENCH_SECONDS}s per side, at block ${block}, all requests but the range scan`);
    const mix = cases.filter((testCase) => !testCase.label.includes("range scan"));
    const throughput: Record<string, Stats & { perSecond: number }> = {};
    for (const source of SOURCES) {
      const result = await benchThroughput(source, mix, block, CONCURRENCY, BENCH_SECONDS);
      throughput[source.name] = result;
      console.log(`  ${source.name.padEnd(5)} ${result.perSecond.toFixed(1)} req/s, ${formatStats(result)}`);
    }
    benchMode = false;
    const refused = rateLimitedCalls - refusedBefore;
    if (refused > 0) {
      console.log(
        `\n  Note: ${refused} benchmark call(s) were refused as rate limited. A relay caps forwarded calls, so those` +
          ` numbers measure the cap, not the engine — point --node at the upstream RPC directly to time the node.`,
      );
    }
    bench = { latency, throughput };
  }

  console.log(
    `\n${checks} checks, ${findings.length} difference(s)` +
      (creationFlagsUnknown ? `, creationFlags unknown on the index for ${creationFlagsUnknown} entity read(s)` : ""),
  );
  for (const finding of findings.slice(0, 50)) console.log(`  ${finding.scope}: ${finding.detail}`);
  if (findings.length > 50) console.log(`  …and ${findings.length - 50} more`);

  if (args.report) {
    writeFileSync(
      args.report,
      JSON.stringify(
        {
          node: NODE.url,
          index: INDEX.url,
          block: block.toString(),
          nodeHead: nodeHead.toString(),
          since: since?.toString() ?? null,
          checks,
          creationFlagsUnknown,
          rateLimitPauses,
          rateLimitedCalls,
          findings,
          queries: queryReports,
          bench,
        },
        null,
        2,
      ),
    );
    console.log(`report written to ${args.report}`);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
