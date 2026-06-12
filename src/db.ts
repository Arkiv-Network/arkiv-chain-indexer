import { SQL } from "bun";

/**
 * Thin adapter over Bun's built-in Postgres client exposing the
 * `(text, $n-params) -> { rows, rowCount }` shape the storage layer uses.
 *
 * Decoding notes (verified against Bun 1.3.x / Postgres 17):
 * - BIGINT/NUMERIC/COUNT(*) columns arrive as strings, matching the previous
 *   pg driver with its OID-20 type parser.
 * - JSONB columns arrive as raw JSON strings (pg parsed them); callers must
 *   JSON.parse.
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

export interface Db extends DbQueryable {
  transaction<T>(fn: (tx: DbQueryable) => Promise<T>): Promise<T>;
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
