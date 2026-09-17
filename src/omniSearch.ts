import { openDb, type Db, type DbQueryable } from "./db";
import { ResponseCache } from "./responseCache";
import { isIndexedSearchQuery, SEARCH_MAX_QUERY_LENGTH, SEARCH_QUERY_HELP, type SearchResponse, type SearchResult } from "./omniSearchTypes";

export { SEARCH_MAX_QUERY_LENGTH } from "./omniSearchTypes";
export const SEARCH_MAX_RESULTS = 30;
const SEARCH_TIMEOUT_MS = 200;
const SEARCH_BUDGET_MS = 800;

export interface SearchInput {
  query: string;
  limit: number;
  suggest: boolean;
}

export class SearchInputError extends Error {}
export class SearchBusyError extends Error {}

/** Only block numbers and indexed hexadecimal identifiers are searchable. */
export function parseSearchInput(params: URLSearchParams, suggest = false): SearchInput {
  const raw = params.get("q") ?? "";
  if (raw.length > SEARCH_MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new SearchInputError(`q must be at most ${SEARCH_MAX_QUERY_LENGTH} characters without control characters`);
  }
  const query = raw.trim();
  const rawLimit = params.get("limit") ?? (suggest ? "8" : "20");
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > SEARCH_MAX_RESULTS) {
    throw new SearchInputError(`limit must be between 1 and ${SEARCH_MAX_RESULTS}`);
  }
  if (query && !isIndexedSearchQuery(query)) throw new SearchInputError(SEARCH_QUERY_HELP);
  return { query, limit: Number(rawLimit), suggest };
}

/** An exclusive bound over *fixed-width lowercase hex*, independent of locale punctuation order. */
export function hexPrefixBounds(input: string, digits: number): [string, string] | null {
  const prefix = input.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(prefix) || prefix.length < 6 || prefix.length > digits) return null;
  const low = prefix.padEnd(digits, "0");
  const high = prefix.padEnd(digits, "f");
  return [`0x${low}`, `0x${high}`];
}

export interface SearchReader { search(input: SearchInput, transactionDataEnabled: boolean): Promise<SearchResponse> }

function blockHref(number: string, transactions: boolean): string {
  if (transactions) return `/block?block=${number}`;
  const block = BigInt(number);
  return `/blocks?${block > 0n ? `blockGt=${block - 1n}&` : ""}blockLt=${block + 1n}`;
}

/**
 * Search is a read-only query router, NOT another projection. All large-table
 * probes constrain an existing B-tree's leading columns. No DDL, DISTINCT,
 * COUNT, OFFSET, full-text index, or unbounded JSON filtering belongs here.
 */
export class OmniSearch implements SearchReader {
  private readonly prefix: string;
  private readonly cache = new ResponseCache({ maxEntries: 128, maxBytes: 2 * 1024 * 1024, ttlMs: 2_000 });
  private readonly inflight = new Map<string, Promise<SearchResponse>>();

  constructor(private readonly db: Db, private readonly entityIndex = false, schema = "public") {
    this.prefix = `"${schema.replaceAll('"', '""')}"`;
  }

  static open(url: string, entityIndex = false): OmniSearch {
    // Independent admission + pool limits: typeahead cannot queue behind or
    // consume the scanner/API pool. Opening search runs no migrations.
    return new OmniSearch(openDb(url, { max: 2 }), entityIndex);
  }

  async close(): Promise<void> { await this.db.close(); }

  async search(input: SearchInput, transactionDataEnabled: boolean): Promise<SearchResponse> {
    const key = JSON.stringify([input, transactionDataEnabled]);
    const hit = this.cache.get(key);
    if (hit) return JSON.parse(typeof hit.body === "string" ? hit.body : new TextDecoder().decode(hit.body)) as SearchResponse;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.inflight.size >= 2) throw new SearchBusyError("Search is busy. Please try again shortly.");
    const work = this.execute(input, transactionDataEnabled).then(async (body) => {
      // Byte bodies make the cache's byte limit exact for Unicode metadata too.
      if (!body.partial) await this.cache.load(key, async () => ({ status: 200, body: new TextEncoder().encode(JSON.stringify(body)) }));
      return body;
    });
    this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }

  private async read<T>(fn: (tx: DbQueryable) => Promise<T>, timeout = SEARCH_BUDGET_MS): Promise<T> {
    const deadline = Date.now() + timeout;
    return this.db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION READ ONLY");
      await tx.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.min(SEARCH_TIMEOUT_MS, timeout))}ms'`);
      await tx.query("SET LOCAL lock_timeout = '50ms'");
      await tx.query("SET LOCAL max_parallel_workers_per_gather = 0");
      await tx.query("SET LOCAL jit = off");
      return fn({ query: (sql, params) => {
        if (Date.now() >= deadline) throw Object.assign(new Error("Search deadline reached"), { code: "57014" });
        return tx.query(sql, params);
      } });
    });
  }

  private async execute(input: SearchInput, transactionDataEnabled: boolean): Promise<SearchResponse> {
    const body: SearchResponse = {
      query: input.query, results: [], suggestions: [], truncated: false, partial: false, notes: [],
      coverage: { attributeIndex: false, attributeHead: null,
        recentOperations: 0, recentTransactions: 0, recentLogs: 0 },
    };
    if (!input.query) return body;
    const deadline = Date.now() + SEARCH_BUDGET_MS;
    const run = async (fn: (tx: DbQueryable) => Promise<void>) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { body.partial = true; return; }
      try { await this.read(fn, remaining); } catch (error) {
        if (["57014", "55P03"].includes(String((error as { code?: string }).code))) body.partial = true;
        else throw error;
      }
    };
    const add = (result: SearchResult) => {
      if (!body.results.some((r) => r.kind === result.kind && r.href === result.href && r.label === result.label)) {
        body.results.push(result);
      }
    };
    const q = input.query;
    if (/^\d+$/.test(q) && BigInt(q) <= 9223372036854775807n) {
      await run(async (tx) => {
        const { rows } = await tx.query<{ block: string }>(
          `SELECT block_number::text AS block FROM ${this.prefix}.blocks WHERE block_number = $1`, [BigInt(q).toString()]);
        for (const r of rows) add({ kind: "block", label: `Block ${r.block}`, detail: "Block number", scope: "indexed",
          href: blockHref(r.block, transactionDataEnabled) });
      });
    }
    const isHex = /^(?:0x)?[0-9a-f]{6,64}$/i.test(q);
    if (isHex) {
      body.truncated = await this.identifiers(input, transactionDataEnabled, run, add);
      body.notes.push("Identifier prefixes search stored block/transaction hashes, entity keys, senders and balance addresses, plus projected owners/creators when enabled. Other address roles are not indexed by search. A full address can still be opened directly.");
    }
    if (body.partial) body.notes.push("Some lookups reached the search time budget. Results may be incomplete; refine the query or retry.");
    body.truncated ||= body.results.length > input.limit;
    body.results = body.results.slice(0, input.limit);
    body.suggestions = body.results.map((r) => ({
      label: r.label, query: r.label, detail: r.detail, href: r.href,
    }));
    return body;
  }

  private async identifiers(
    input: SearchInput, transactions: boolean,
    run: (fn: (tx: DbQueryable) => Promise<void>) => Promise<void>, add: (r: SearchResult) => void,
  ): Promise<boolean> {
    let truncated = false;
    const sources: Array<{ table: string; column: string; digits: number; kind: SearchResult["kind"]; detail: string }> = [
      { table: "blocks", column: "block_hash", digits: 64, kind: "block", detail: "Block hash" },
      ...(transactions ? [
        { table: "transactions", column: "hash", digits: 64, kind: "transaction" as const, detail: "Transaction hash" },
        { table: "transaction_operations", column: "entity_key", digits: 64, kind: "entity" as const, detail: "Entity key" },
        { table: "transactions", column: "lower(from_address)", digits: 40, kind: "address" as const, detail: "Sender address" },
        { table: "account_balances", column: "address", digits: 40, kind: "address" as const, detail: "Balance address" },
      ] : []),
      ...(transactions && this.entityIndex ? [
        { table: "entity_versions", column: "entity_key", digits: 64, kind: "entity" as const, detail: "Projected entity key" },
        { table: "entity_versions", column: "owner", digits: 40, kind: "address" as const, detail: "Entity owner address (including history)" },
        { table: "entity_versions", column: "creator", digits: 40, kind: "address" as const, detail: "Entity creator address" },
      ] : []),
    ];
    for (const source of sources) {
      const bounds = hexPrefixBounds(input.query, source.digits);
      if (!bounds) continue;
      await run(async (tx) => {
        // Recursive loose index scan: jump past each returned identifier.
        // SELECT DISTINCT could walk millions of duplicate sender/entity rows.
        const { table, column } = source;
        const { rows } = await tx.query<{ value: string }>(`
          WITH RECURSIVE hits(value, n) AS (
            (SELECT ${column}, 1 FROM ${this.prefix}.${table}
             WHERE ${column} >= $1 AND ${column} <= $2 ORDER BY ${column} LIMIT 1)
            UNION ALL
            SELECT next.value, hits.n + 1 FROM hits
            CROSS JOIN LATERAL (SELECT ${column} AS value FROM ${this.prefix}.${table}
              WHERE ${column} > hits.value AND ${column} <= $2 ORDER BY ${column} LIMIT 1) next
            WHERE hits.n < $3
          ) SELECT value FROM hits`, [...bounds, input.limit + 1]);
        truncated ||= rows.length > input.limit;
        for (const r of rows.slice(0, input.limit)) {
          let href = source.kind === "entity" ? `/entity/${r.value}` : source.kind === "transaction" ? `/tx/${r.value}` : `/address/${r.value}`;
          if (source.kind === "block") {
            const block = await tx.query<{ block: string }>(
              `SELECT block_number::text AS block FROM ${this.prefix}.blocks WHERE block_hash = $1 LIMIT 1`, [r.value]);
            if (!block.rows[0]) continue;
            const number = block.rows[0].block;
            href = blockHref(number, transactions);
          }
          add({ kind: source.kind, label: r.value, detail: source.detail, href, scope: "indexed" });
        }
      });
    }
    return truncated;
  }
}
