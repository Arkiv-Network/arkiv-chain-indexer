import { createHash } from "node:crypto";
import {
  array,
  choice,
  decimal,
  fail,
  hex,
  integer,
  object,
  text,
} from "./common";
import { attributeName, hexAttribute, numericAttribute, parseAttribute, type Attribute } from "./wire";
export type Predicate =
  | { op: "eq" | "lt" | "lte" | "gt" | "gte" | "prefix"; attribute: Attribute }
  | { op: "exists"; name: string }
  | { op: "and" | "or"; args: Predicate[] }
  | { op: "not"; arg: Predicate };
export function parsePredicate(value: unknown): Predicate | null {
  let nodes = 0;
  function parse(v: unknown, depth: number): Predicate {
    if (
      ++nodes > 64 ||
      depth > 8 ||
      !v ||
      typeof v !== "object" ||
      !("op" in v)
    )
      return fail("LimitExceeded", 413);
    if (v.op === "and" || v.op === "or") {
      const p = object(v, ["op", "args"]);
      const args = array(p.args, (a) => parse(a, depth + 1), 8);
      if (!args.length) return fail();
      return { op: v.op, args };
    }
    if (v.op === "not") {
      const p = object(v, ["op", "arg"]);
      return { op: "not", arg: parse(p.arg, depth + 1) };
    }
    if (v.op === "exists") {
      const p = object(v, ["op", "name"]);
      return { op: "exists", name: attributeName(p.name) };
    }
    const p = object(v, ["op", "attribute"]);
    const op = choice(p.op, ["eq", "lt", "lte", "gt", "gte", "prefix"]);
    const attribute = parseAttribute(p.attribute);
    if (
      op === "prefix"
        ? attribute.type !== "str"
        : op !== "eq" && !numericAttribute(attribute.type)
    )
      return fail("UnsupportedQuery", 422);
    return { op, attribute };
  }
  return value === null || value === undefined ? null : parse(value, 0);
}
export class SqlArgs {
  values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
export function predicateSql(
  query: Predicate | null,
  schema: string,
  params: SqlArgs,
): string {
  if (!query) return "TRUE";
  if (query.op === "and" || query.op === "or")
    return `(${query.args.map((q) => predicateSql(q, schema, params)).join(query.op === "and" ? " AND " : " OR ")})`;
  if (query.op === "not")
    return `(NOT ${predicateSql(query.arg, schema, params)})`;
  if ("args" in query) return fail();
  const name = query.op === "exists" ? query.name : query.attribute.name;
  let clause = `a.run_pk=r.run_pk AND a.namespace_id=r.namespace_id AND a.record_id=r.record_id AND a.from_height=r.from_height AND a.name=${params.add(Buffer.from(name))}`;
  if (query.op !== "exists") {
    const attr = query.attribute;
    clause += ` AND a.type=${params.add(attr.type)}`;
    if (attr.type === "bool")
      clause += ` AND a.value_bool=${params.add(attr.value)}`;
    else if (attr.type === "str") {
      const bytes = Buffer.from(attr.value as string);
      clause +=
        query.op === "prefix"
          ? ` AND substring(a.value_bytes FROM 1 FOR ${params.add(bytes.length)})=${params.add(bytes)}`
          : ` AND a.value_bytes=${params.add(bytes)}`;
    } else if (hexAttribute(attr.type)) {
      clause += ` AND a.value_bytes=${params.add(Buffer.from((attr.value as string).slice(2), "hex"))}`;
    } else {
      const operator = {
        eq: "=",
        lt: "<",
        lte: "<=",
        gt: ">",
        gte: ">=",
        prefix: "=",
      }[query.op];
      clause += ` AND a.value_num${operator}${params.add(attr.value)}::numeric`;
    }
  }
  return `EXISTS (SELECT 1 FROM ${schema}.record_attributes a WHERE ${clause})`;
}
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface PageCursor {
  version: 1;
  run: string;
  height: string;
  hash: string;
  filter: string;
  last: string[];
}
export function cursorEncode(value: PageCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function cursorDecode(
  value: string,
  run: string,
  filter: unknown,
): PageCursor {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    return fail("CursorMismatch", 409);
  try {
    const v = object(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      ["version", "run", "height", "hash", "filter", "last"],
    );
    if (v.version !== 1 || v.run !== run || v.filter !== fingerprint(filter))
      return fail("CursorMismatch", 409);
    const kind = (filter as { kind: string }).kind;
    const last = array(v.last, (x) => text(x, 128), 4);
    const length =
      kind === "transactions"
        ? 2
        : ["operations", "record-history"].includes(kind)
          ? 4
          : 1;
    if (last.length !== length) return fail();
    if (kind === "raw") hex(last[0], 20, 0);
    else {
      decimal(last[0]);
      for (let i = 1; i < last.length; i++)
        integer(Number(decimal(last[i])), i === 1 && length === 4 ? 2 : 65535);
    }
    return {
      version: 1,
      run,
      height: decimal(v.height),
      hash: hex(v.hash, 32),
      filter: v.filter as string,
      last,
    };
  } catch {
    return fail("CursorMismatch", 409);
  }
}
