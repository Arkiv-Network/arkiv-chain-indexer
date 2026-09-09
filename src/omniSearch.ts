import { openDb, type Db, type DbQueryable } from "./db";
import { ResponseCache } from "./responseCache";
import { ValueCache } from "./valueCache";
import { TYPE_TAGS_BY_ID, toStoredAttributeValue } from "./entityValues";
import type { SearchResponse, SearchResult, SearchSuggestion } from "./omniSearchTypes";

export const SEARCH_MAX_QUERY_LENGTH = 256;
export const SEARCH_MAX_RESULTS = 30;
export const SEARCH_RECENT_ROWS = 64;
const SEARCH_TIMEOUT_MS = 200;
const SEARCH_BUDGET_MS = 800;
const ATTRIBUTE_TYPES = [1, 2, 3, 4, 5, 6, 8, 9, 10]; // Never payload bytes (type 7).

export interface SearchInput {
  query: string;
  limit: number;
  suggest: boolean;
  attribute: { key: string; value: string; prefix: boolean } | null;
}

export class SearchInputError extends Error {}
export class SearchBusyError extends Error {}

/** Only a tiny, literal grammar. SQL/tsquery/regex syntax never comes from the caller. */
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
  const equals = query.indexOf("=");
  let attribute: SearchInput["attribute"] = null;
  if (equals >= 0) {
    const key = query.slice(0, equals).trim();
    let value = query.slice(equals + 1).trim();
    let prefix = suggest || value.endsWith("*");
    if (value.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(value);
        if (typeof decoded !== "string") throw new Error();
        value = decoded;
        prefix = suggest;
      } catch {
        // Allow a quote still being typed; full searches require a closed JSON string.
        if (!suggest) throw new SearchInputError("Close the quoted value, e.g. name=\"Alice Smith\"");
        value = value.slice(1);
      }
    } else if (value.endsWith("*")) {
      value = value.slice(0, -1);
    }
    if (!key || key === "$payload" || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new SearchInputError("Specify an attribute key; payload bytes are not searchable");
    }
    attribute = { key, value, prefix };
  }
  return { query, limit: Number(rawLimit), suggest, attribute };
}

/** An exclusive bound over *fixed-width lowercase hex*, independent of locale punctuation order. */
export function hexPrefixBounds(input: string, digits: number): [string, string] | null {
  const prefix = input.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(prefix) || prefix.length < 6 || prefix.length > digits) return null;
  const low = prefix.padEnd(digits, "0");
  const high = prefix.padEnd(digits, "f");
  return [`0x${low}`, `0x${high}`];
}

/** Bounds in PostgreSQL's text_pattern_ops byte order; '%'/'_'/'\\' remain literal. */
export function textPrefixUpper(value: string): string | null {
  const points = Array.from(value);
  while (points.length) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
      return points.join("") + String.fromCodePoint(next);
    }
  }
  return null;
}

export interface SearchReader { search(input: SearchInput, transactionDataEnabled: boolean): Promise<SearchResponse> }

function blockHref(number: string, transactions: boolean): string {
  if (transactions) return `/block?block=${number}`;
  const block = BigInt(number);
  return `/blocks?${block > 0n ? `blockGt=${block - 1n}&` : ""}blockLt=${block + 1n}`;
}

interface RecentRow {
  kind: "transaction" | "operation" | "log";
  hash: string;
  block: string;
  entity: string | null;
  fields: string[];
  attributes: string;
}
interface RecentSnapshot { rows: RecentRow[] }

/**
 * Search is a read-only query router, NOT another projection. All large-table
 * probes constrain an existing B-tree's leading columns. No DDL, DISTINCT,
 * COUNT, OFFSET, full-text index, or unbounded JSON filtering belongs here.
 */
export class OmniSearch implements SearchReader {
  private readonly prefix: string;
  private readonly cache = new ResponseCache({ maxEntries: 128, maxBytes: 2 * 1024 * 1024, ttlMs: 2_000 });
  private readonly recentCache = new ValueCache<RecentSnapshot>({ maxEntries: 1, ttlMs: 5_000 });
  private readonly inflight = new Map<string, Promise<SearchResponse>>();

  constructor(private readonly db: Db, private readonly attributeIndex = false, schema = "public") {
    this.prefix = `"${schema.replaceAll('"', '""')}"`;
  }

  static open(url: string, attributeIndex = false): OmniSearch {
    // Independent admission + pool limits: typeahead cannot queue behind or
    // consume the scanner/API pool. Opening search runs no migrations.
    return new OmniSearch(openDb(url, { max: 2 }), attributeIndex);
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
      coverage: { attributeIndex: this.attributeIndex && transactionDataEnabled, attributeHead: null,
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
      body.notes.push("Identifier prefixes search stored block/transaction hashes, entity keys, senders and balance addresses, plus projected owners/creators when enabled. Other address roles appear in recent metadata.");
    }
    if (transactionDataEnabled && input.attribute && this.attributeIndex) {
      await run(async (tx) => {
        const { rows } = await tx.query<{ value: string }>(
          `SELECT value FROM ${this.prefix}.entity_index_state WHERE key = 'projected_through_block'`);
        body.coverage.attributeHead = rows[0]?.value ?? null;
      });
      // Unprojected rows are not a complete index. Report readiness explicitly.
      if (body.coverage.attributeHead !== null) await run((tx) => this.attributes(tx, input, body, add));
      body.notes.push("key=value is case-sensitive and searches the latest indexed attribute versions (including expired entities). Use key=prefix* for a prefix, or quote a literal ending in *. Payload bytes are excluded.");
      if (body.coverage.attributeHead === null) body.notes.push("The attribute projection is not ready yet; only recent metadata can be searched.");
    }
    // Arbitrary values have no leading-column index. Only inspect a fixed
    // newest-row sample, shared between callers, and disclose its coverage.
    if (transactionDataEnabled && (!isHex || body.results.length < input.limit)) {
      if (q.length >= 2 || input.attribute) {
        await run(async (tx) => {
          const snapshot = await this.recentCache.load("recent", () => this.recent(tx));
          this.matchRecent(snapshot, input, body, add);
        });
        body.notes.push(`General text and key suggestions cover at most ${SEARCH_RECENT_ROWS} recent operations, transactions and logs each; long metadata fields are shortened. They are not a search of all history.`);
        if (!this.attributeIndex) body.notes.push("The existing entity attribute index is disabled; key=value currently searches recent metadata only.");
      }
    }
    if (/^(?:0x)?[0-9a-f]{1,5}$/i.test(q) || /^0x$/i.test(q)) {
      body.notes.push("Type at least six hexadecimal digits for identifier suggestions.");
    }
    if (body.partial) body.notes.push("Some lookups reached the search time budget. Results may be incomplete; refine the query or retry.");
    body.truncated ||= body.results.length > input.limit;
    body.results = body.results.slice(0, input.limit);
    const identifiers = body.results.filter((r) => r.scope === "indexed" && r.kind !== "attribute").map((r): SearchSuggestion => ({
      label: r.label, query: r.label, detail: r.detail, href: r.href,
    }));
    const recentActions = body.results.filter((r) => r.scope === "recent").map((r): SearchSuggestion => ({
      label: r.label, query: input.query, detail: r.detail, href: r.href,
    }));
    const suggestions = [...identifiers, ...body.suggestions, ...recentActions]
      .filter((s, i, all) => all.findIndex((other) => other.query === s.query && other.href === s.href) === i);
    body.truncated ||= suggestions.length > input.limit;
    body.suggestions = suggestions.slice(0, input.limit);
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
      ...(transactions && this.attributeIndex ? [
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

  private async attributes(tx: DbQueryable, input: SearchInput, body: SearchResponse, add: (r: SearchResult) => void): Promise<void> {
    const { key, value, prefix } = input.attribute!;
    // Each type is a separate bounded seek so (name, type_id, value_text)
    // remains an index condition, including when callers don't know the type.
    for (const type of ATTRIBUTE_TYPES) {
      const tag = TYPE_TAGS_BY_ID.get(type)!;
      const normalized = prefix ? value : toStoredAttributeValue(tag, value)?.valueText;
      if (normalized === undefined) continue;
      const text = (type === 6 || type === 9 || type === 10) ? normalized.toLowerCase() : normalized;
      const params: unknown[] = [key, type, text];
      let predicate = "value_text = $3";
      if (prefix) {
        predicate = "value_text ~>=~ $3";
        const upper = textPrefixUpper(text);
        if (upper !== null) { params.push(upper); predicate += ` AND value_text ~<~ $${params.length}`; }
      }
      params.push(input.limit + 1);
      const { rows } = await tx.query<{ entity: string; value: string }>(`
        SELECT entity_key AS entity, left(value_text, 512) AS value
        FROM ${this.prefix}.entity_version_attributes
        WHERE current AND name = $1 AND type_id = $2 AND ${predicate}
        LIMIT $${params.length}`, params);
      body.truncated ||= rows.length > input.limit;
      for (const row of rows.slice(0, input.limit)) {
        add({ kind: "attribute", label: `${key}=${row.value}`, detail: `${tag} · ${row.entity}`, href: `/entity/${row.entity}`, scope: "indexed" });
      }
      if (input.suggest) {
        // Suggestions must not enumerate all duplicate values. Re-seek using
        // pattern ordering (the index's order), never DISTINCT/ORDER BY default collation.
        const suggestions = await tx.query<{ value: string }>(`
          WITH RECURSIVE hits(value, n) AS (
            (SELECT value_text, 1 FROM ${this.prefix}.entity_version_attributes
             WHERE current AND name=$1 AND type_id=$2 AND ${predicate}
             ORDER BY value_text USING ~<~ LIMIT 1)
            UNION ALL
            SELECT next.value, hits.n+1 FROM hits CROSS JOIN LATERAL (
              SELECT value_text AS value FROM ${this.prefix}.entity_version_attributes
              WHERE current AND name=$1 AND type_id=$2 AND ${predicate} AND value_text ~>~ hits.value
              ORDER BY value_text USING ~<~ LIMIT 1
            ) next WHERE hits.n < $${params.length}
          ) SELECT value FROM hits WHERE char_length(value) <= 256`, params);
        for (const row of suggestions.rows) {
          if (row.value.length + key.length + 4 > SEARCH_MAX_QUERY_LENGTH) continue;
          body.suggestions.push({ label: `${key}=${row.value}`, query: `${key}=${JSON.stringify(row.value)}`, detail: `${tag} attribute value`, href: null });
        }
      }
    }
  }

  private async recent(tx: DbQueryable): Promise<RecentSnapshot> {
      const rows: RecentRow[] = [];
      const operations = await tx.query<RecentRow>(`
        SELECT 'operation' AS kind, hash, block_number::text AS block, entity_key AS entity,
          ARRAY[operation, left(content_type,256), new_owner,
            left(payload_reference->>'provider',256), left(payload_reference->>'id',256),
            left(payload_reference->>'checksum',256), left(payload_reference->>'namespace',256),
            left(payload_reference->'signature'->>'signer',256)] AS fields,
          left(attributes::text,8192) AS attributes
        FROM ${this.prefix}.transaction_operations
        ORDER BY block_number DESC, position DESC, op_index DESC LIMIT ${SEARCH_RECENT_ROWS}`);
      rows.push(...operations.rows);
      const transactions = await tx.query<RecentRow>(`
        SELECT 'transaction' AS kind, hash, block_number::text AS block, NULL::text AS entity,
          ARRAY[from_address, to_address, contract_address, nonce, value_wei] AS fields, '[]' AS attributes
        FROM ${this.prefix}.transactions ORDER BY block_number DESC, position DESC LIMIT ${SEARCH_RECENT_ROWS}`);
      rows.push(...transactions.rows);
      const logs = await tx.query<RecentRow>(`
        SELECT 'log' AS kind, hash, block_number::text AS block, NULL::text AS entity,
          ARRAY[address, topic0, topic1, topic2, topic3] AS fields, '[]' AS attributes
        FROM ${this.prefix}.transaction_logs ORDER BY block_number DESC, position DESC, log_index DESC LIMIT ${SEARCH_RECENT_ROWS}`);
      rows.push(...logs.rows);
      return { rows };
  }

  private matchRecent(snapshot: RecentSnapshot, input: SearchInput, body: SearchResponse, add: (r: SearchResult) => void): void {
    const words = input.query.toLowerCase().split(/\s+/);
    for (const row of snapshot.rows) {
      if (row.kind === "operation") body.coverage.recentOperations++;
      if (row.kind === "transaction") body.coverage.recentTransactions++;
      if (row.kind === "log") body.coverage.recentLogs++;
      let attributes: Array<{ key: string; value: string }> = [];
      try {
        const parsed: unknown = JSON.parse(row.attributes);
        if (Array.isArray(parsed)) attributes = parsed.filter((a) => a && typeof a.key === "string" && typeof a.value === "string" && a.key !== "$payload" && a.valueType !== 7);
      } catch { /* A metadata row over the byte budget is deliberately omitted. */ }
      const fields = [row.hash, row.entity, ...row.fields, ...attributes.flatMap((a) => [a.key, a.value])]
        .filter((f): f is string => typeof f === "string");
      const needle = fields.join(" ").toLowerCase();
      const matchingAttribute = input.attribute && attributes.some((a) => a.key === input.attribute!.key &&
        (input.attribute!.prefix ? a.value.startsWith(input.attribute!.value) : a.value === input.attribute!.value));
      if (input.attribute ? matchingAttribute : words.every((word) => needle.includes(word))) {
        const detail = input.attribute ? `${input.attribute.key}=${input.attribute.value}` :
          fields.find((f) => words.some((word) => f.toLowerCase().includes(word))) ?? row.kind;
        add({ kind: row.kind, label: row.entity ?? row.hash, detail: `Block ${row.block} · ${detail.slice(0, 256)}`,
          href: `/tx/${row.hash}`, scope: "recent" });
      }
      for (const attribute of attributes) {
        if (!input.attribute && attribute.key.toLowerCase().startsWith(input.query.toLowerCase())) {
          body.suggestions.push({ label: `${attribute.key}=`, query: `${attribute.key}=`, detail: "Attribute key · recently observed", href: null });
        }
        if (!input.attribute && attribute.value.toLowerCase().startsWith(input.query.toLowerCase())) {
          const query = `${attribute.key}=${JSON.stringify(attribute.value)}`;
          if (query.length <= SEARCH_MAX_QUERY_LENGTH) body.suggestions.push({ label: `${attribute.key}=${attribute.value}`, query, detail: "Attribute value · recently observed", href: null });
        }
        if (input.attribute && attribute.key === input.attribute.key && attribute.value.startsWith(input.attribute.value)) {
          const query = `${attribute.key}=${JSON.stringify(attribute.value)}`;
          if (query.length <= SEARCH_MAX_QUERY_LENGTH) body.suggestions.push({ label: `${attribute.key}=${attribute.value}`, query, detail: "Attribute value · recently observed", href: null });
        }
      }
    }
  }
}
