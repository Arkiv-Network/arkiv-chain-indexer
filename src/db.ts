import { SQL } from "bun";

/**
 * Thin adapter over Bun's built-in Postgres client exposing the
 * `(text, $n-params) -> { rows, rowCount }` shape the storage layer uses.
 *
 * Decoding notes (verified against Bun 1.3.x / Postgres 17):
 * - BIGINT/NUMERIC/COUNT(*) columns arrive as strings, matching the previous
 *   pg driver with its OID-20 type parser.
 * - JSONB columns are parsed to JS values on read, like pg. Bind JS
 *   objects/arrays directly to jsonb params: binding a pre-stringified JSON
 *   string double-encodes it into a jsonb string scalar (pg treated such
 *   strings as raw JSON documents).
 * - JS array params are not serialized to Postgres array literals; use
 *   textArrayLiteral() for `= ANY($1::text[])` parameters.
 */

export interface DbResult<R> {
  rows: R[];
  rowCount: number;
}

export interface DbQueryable {
  query<R = unknown>(text: string, params?: unknown[]): Promise<DbResult<R>>;
}

export interface DbListenSubscription {
  unlisten(): Promise<void>;
}

export interface Db extends DbQueryable {
  transaction<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T>;
  /**
   * Subscribe to a Postgres NOTIFY channel. The handler receives each
   * notification's payload string. Bun manages the LISTEN connection
   * internally, outside the query pool.
   */
  listen(channel: string, handler: (payload: string) => void): Promise<DbListenSubscription>;
  close(): Promise<void>;
}

export interface OpenDbOptions {
  max?: number;
}

type UnsafeCapable = { unsafe(text: string, params?: unknown[]): Promise<unknown> };

function queryableFrom(sql: UnsafeCapable): DbQueryable {
  return {
    async query<R>(text: string, params: unknown[] = []): Promise<DbResult<R>> {
      const result = (await sql.unsafe(text, params)) as R[] & { count?: number };
      return { rows: [...result], rowCount: result.count ?? 0 };
    },
  };
}

export function openDb(connectionString: string, options: OpenDbOptions = {}): Db {
  const sql = new SQL({
    url: connectionString,
    ...(options.max !== undefined ? { max: options.max } : {}),
  });
  const base = queryableFrom(sql);
  return {
    query: base.query,
    transaction<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T> {
      return sql.begin((tx) => fn(queryableFrom(tx))) as Promise<T>;
    },
    async listen(
      channel: string,
      handler: (payload: string) => void,
    ): Promise<DbListenSubscription> {
      // Bun 1.4+ SQL exposes listen()/unlisten(); @types/bun lags behind.
      const listenCapable = sql as unknown as {
        listen(
          channel: string,
          handler: (payload: string) => void,
        ): Promise<{ unlisten(): Promise<void> }>;
      };
      const subscription = await listenCapable.listen(channel, handler);
      return { unlisten: () => subscription.unlisten() };
    },
    async close(): Promise<void> {
      await sql.end();
    },
  };
}

/**
 * Format strings as a Postgres array literal for `= ANY($1::text[])` params.
 * Elements are double-quoted with backslash escaping, so commas, spaces, and
 * quotes inside values are safe.
 */
export function textArrayLiteral(values: readonly string[]): string {
  const elements = values.map(
    (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${elements.join(",")}}`;
}
