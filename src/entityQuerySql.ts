/**
 * Compile an entity query AST into a SQL `WHERE` fragment over the projected
 * entity tables (`entity_versions v` + `entity_version_attributes a`).
 *
 * Each predicate becomes a correlated `EXISTS` on the attribute rows of the
 * *same version* the outer row is, so a query evaluated at a past block sees
 * the attributes that version had. The caller adds the liveness filter that
 * pins `v` to the versions valid at the evaluated block; `NOT` therefore
 * complements within the live set, exactly as the node's `$all \ match`.
 *
 * Typing follows the node: a predicate names a type, and only an attribute of
 * that type can match it — and only an *indexed* one: the node keeps
 * unindexed attributes out of its index, so `title = str('x')` never matches
 * an entity whose `title` is stored without the flag. Ordered types compare `value_num` (an exact NUMERIC
 * of the integer or scaled decimal); the rest compare `value_bytes`, the UTF-8
 * of the canonical form, so a str holding a NUL compares as the node compares
 * it. `STARTSWITH` is the byte range `[prefix, next prefix)`, the node's
 * index scan. (It never meets a built-in column: those are typed addr, key or
 * u64, and STARTSWITH takes a str.)
 */
import type { AttributeRef, ComparisonOperator, QueryAst, QueryValue } from "./entityQueryLanguage";
import { TYPE_IDS, isOrderedType } from "./entityValues";

export interface CompiledPredicate {
  /** A parenthesised boolean expression over the alias `v`. */
  text: string;
  /** Positional parameters, numbered from `paramOffset + 1`. */
  params: unknown[];
}

export interface CompileOptions {
  /** Fully qualified attributes table, e.g. `"public".entity_version_attributes`. */
  attributesTable: string;
  /** How many `$n` placeholders the surrounding statement already uses. */
  paramOffset?: number;
}

/** Largest value Postgres `bigint` holds; `$createdAt` is typed u64 by the language. */
const I64_MAX = (1n << 63n) - 1n;

const SQL_OPERATORS: Record<ComparisonOperator, string> = {
  eq: "=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

/**
 * The smallest byte string above every string that starts with `prefix`, or
 * null when there is none (the prefix is empty or all 0xff).
 */
export function nextBytePrefix(prefix: Uint8Array): Uint8Array | null {
  let end = prefix.length;
  while (end > 0 && prefix[end - 1] === 0xff) end--;
  if (end === 0) return null;
  // A copy: a Buffer's slice is a view of the prefix it came from.
  const next = Uint8Array.from(prefix.subarray(0, end));
  next[end - 1]! += 1;
  return next;
}

/** The comparable form of a query value: NUMERIC text for ordered types, canonical text otherwise. */
export function queryValueOperand(value: QueryValue): string {
  switch (value.type) {
    case "bool":
      return value.value ? "true" : "false";
    case "i32":
      return String(value.value);
    case "u64":
    case "u256":
      return value.value.toString();
    case "dec":
      return value.units.toString();
    case "str":
    case "addr":
    case "key":
    case "bytes32":
      return value.value;
  }
}

class Params {
  readonly values: unknown[] = [];
  constructor(private readonly offset: number) {}

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.offset + this.values.length}`;
  }
}

function builtinColumn(field: Exclude<AttributeRef, { kind: "user" }>["field"]): { column: string; cast: string } {
  switch (field) {
    case "owner":
      return { column: "v.owner", cast: "" };
    case "creator":
      return { column: "v.creator", cast: "" };
    case "key":
      return { column: "v.entity_key", cast: "" };
    case "expiresAt":
      return { column: "v.expires_at", cast: "::numeric" };
    case "createdAt":
      return { column: "v.created_at", cast: "::bigint" };
  }
}

function compileNode(node: QueryAst, params: Params, attributesTable: string): string {
  switch (node.kind) {
    case "all":
      return "TRUE";
    case "and":
      return `(${compileNode(node.left, params, attributesTable)} AND ${compileNode(node.right, params, attributesTable)})`;
    case "or":
      return `(${compileNode(node.left, params, attributesTable)} OR ${compileNode(node.right, params, attributesTable)})`;
    case "not":
      return `(NOT ${compileNode(node.inner, params, attributesTable)})`;
    case "compare":
    case "startsWith": {
      const isPrefix = node.kind === "startsWith";
      if (node.key.kind === "builtin") {
        if (node.kind === "startsWith") throw new Error("STARTSWITH on a system attribute: the parser refuses a str for one");
        const { column, cast } = builtinColumn(node.key.field);
        if (
          node.key.field === "createdAt" &&
          (node.value.type === "u64" || node.value.type === "u256") &&
          node.value.value > I64_MAX
        ) {
          // The column is a signed bigint and block numbers never reach 2^63,
          // so a larger literal sits above every stored value.
          return node.op === "lt" || node.op === "lte" ? "TRUE" : "FALSE";
        }
        return `(${column} ${SQL_OPERATORS[node.op]} ${params.add(queryValueOperand(node.value))}${cast})`;
      }
      const name = params.add(node.key.name);
      const typeId = params.add(TYPE_IDS[node.value.type]);
      let condition: string;
      if (isPrefix) {
        const prefix = Buffer.from(node.value.value, "utf8");
        const next = nextBytePrefix(prefix);
        condition = `a.value_bytes >= ${params.add(prefix)}::bytea`;
        if (next) condition += ` AND a.value_bytes < ${params.add(Buffer.from(next))}::bytea`;
      } else if (isOrderedType(node.value.type)) {
        condition = `a.value_num ${SQL_OPERATORS[node.op]} ${params.add(queryValueOperand(node.value))}::numeric`;
      } else {
        const operand = Buffer.from(queryValueOperand(node.value), "utf8");
        condition = `a.value_bytes ${SQL_OPERATORS[node.op]} ${params.add(operand)}::bytea`;
      }
      return (
        `(EXISTS (SELECT 1 FROM ${attributesTable} a` +
        ` WHERE a.entity_key = v.entity_key AND a.version = v.version AND a.indexed` +
        ` AND a.name = ${name}` +
        ` AND a.type_id = ${typeId}::smallint` +
        ` AND ${condition}))`
      );
    }
  }
}

/** Compile `ast` into a predicate over `v`; the result is parenthesised and safe to `AND` with more. */
export function compileEntityQuery(ast: QueryAst, options: CompileOptions): CompiledPredicate {
  const params = new Params(options.paramOffset ?? 0);
  const text = compileNode(ast, params, options.attributesTable);
  return { text, params: params.values };
}
