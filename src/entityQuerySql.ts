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
 * that type can match it. Ordered types compare `value_num` (an exact NUMERIC
 * of the integer or scaled decimal); the rest compare `value_text` in its
 * canonical form. `STARTSWITH` is a `LIKE` on the escaped prefix, which is a
 * byte-prefix match for valid UTF-8 the same way the node's index scan is.
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

const SQL_OPERATORS: Record<ComparisonOperator, string> = {
  eq: "=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

/** Escape the LIKE metacharacters so a prefix matches literally. */
export function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
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
    case "contentType":
      return { column: "v.content_type", cast: "" };
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
      const operator = isPrefix ? "LIKE" : SQL_OPERATORS[node.op];
      const operand = isPrefix ? likePrefixPattern(node.value.value) : queryValueOperand(node.value);
      const escape = isPrefix ? " ESCAPE '\\'" : "";
      if (node.key.kind === "builtin") {
        const { column, cast } = builtinColumn(node.key.field);
        return `(${column} ${operator} ${params.add(operand)}${cast}${escape})`;
      }
      const ordered = !isPrefix && isOrderedType(node.value.type);
      const valueColumn = ordered ? "a.value_num" : "a.value_text";
      const cast = ordered ? "::numeric" : "";
      return (
        `(EXISTS (SELECT 1 FROM ${attributesTable} a` +
        ` WHERE a.entity_key = v.entity_key AND a.version = v.version` +
        ` AND a.name = ${params.add(node.key.name)}` +
        ` AND a.type_id = ${params.add(TYPE_IDS[node.value.type])}::smallint` +
        ` AND ${valueColumn} ${operator} ${params.add(operand)}${cast}${escape}))`
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
