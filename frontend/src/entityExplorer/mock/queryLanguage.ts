/**
 * A small interpreter for the Arkiv query language, so the mock node can
 * answer `arkiv_query` the way a real one would.
 *
 * It follows the documented semantics rather than any node implementation:
 * comparisons also check the type (`score = i32(4)` misses a `dec` score),
 * `!=` only matches attributes that are set with the literal's type, `NOT`
 * matches everything its operand does not, and only indexed attributes can
 * match at all. Failures carry the `arkiv_query` error codes, so the SDK turns
 * them into the same `QueryError` kinds a live node produces.
 */

import type { TypeTag } from "@arkiv-network/sdk";

export const QUERY_ERROR = {
  parse: -32001,
  type: -32002,
  literal: -32003,
  limits: -32004,
  cursor: -32005,
  block: -32006,
} as const;

export class MockQueryError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** A value as the mock store holds it: comparable, and close to the RPC encoding. */
export type MockValue =
  | { type: "bool"; value: boolean }
  | { type: "i32" | "u64" | "u256"; value: bigint }
  | { type: "dec"; value: string }
  | { type: "str"; value: string }
  | { type: "addr" | "key" | "bytes32" | "bytes"; value: `0x${string}` };

export type MockAttribute = MockValue & { name: string; indexed: boolean };

/** What a query can see of an entity: its indexed attributes and filterable fields. */
export type QueryTarget = {
  key: `0x${string}`;
  owner: `0x${string}`;
  creator: `0x${string}`;
  expiresAt: bigint;
  attributes: readonly MockAttribute[];
};

type ComparisonOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

type Node =
  | { kind: "and" | "or"; left: Node; right: Node }
  | { kind: "not"; operand: Node }
  | { kind: "cmp"; name: string; op: ComparisonOp; literal: MockValue }
  | { kind: "startsWith"; name: string; prefix: string }
  | { kind: "exists"; name: string }
  | { kind: "typeof"; name: string; tag: TypeTag };

const TYPE_TAGS = new Set<string>(["bool", "i32", "u64", "u256", "dec", "str", "addr", "key", "bytes32", "bytes"]);

const RANGE_TYPES = new Set<string>(["i32", "u64", "u256", "dec"]);

/** The four entity fields the language can filter on, each with its fixed type. */
const ENTITY_FIELDS: Record<string, TypeTag> = {
  $key: "key",
  $owner: "addr",
  $creator: "addr",
  $expiresAt: "u64",
};

const MAX_QUERY_LENGTH = 4096;
const MAX_DEPTH = 32;

type Token =
  | { t: "word"; v: string; pos: number }
  | { t: "num"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "str"; v: string; pos: number }
  | { t: "(" | ")"; pos: number }
  | { t: "eof"; pos: number };

function parseError(pos: number, expected: string, got: string): never {
  throw new MockQueryError(QUERY_ERROR.parse, `parse error at ${pos}: expected ${expected}, got ${got}`, {
    position: pos,
    expected,
    got,
  });
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (input.startsWith("--", i)) {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ t: c, pos: i });
      i++;
      continue;
    }
    if (c === "'") {
      const start = i;
      let value = "";
      i++;
      for (;;) {
        if (i >= input.length) parseError(start, "closing quote", "end of query");
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += input[i++];
      }
      tokens.push({ t: "str", v: value, pos: start });
      continue;
    }
    const op = /^(!=|<=|>=|=|<|>)/.exec(input.slice(i));
    if (op) {
      tokens.push({ t: "op", v: op[0], pos: i });
      i += op[0].length;
      continue;
    }
    const num = /^-?(0x[0-9a-fA-F]*|\d+(\.\d+)?)/.exec(input.slice(i));
    if (num) {
      tokens.push({ t: "num", v: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    // Attribute names may contain `.` and `-`, but never `--`, which starts a comment.
    const word = /^\$?[A-Za-z_](?:[\w.]|-(?!-))*/.exec(input.slice(i));
    if (word) {
      tokens.push({ t: "word", v: word[0], pos: i });
      i += word[0].length;
      continue;
    }
    parseError(i, "a token", JSON.stringify(c));
  }
  tokens.push({ t: "eof", pos: input.length });
  return tokens;
}

function describe(token: Token): string {
  switch (token.t) {
    case "eof":
      return "end of query";
    case "(":
    case ")":
      return `'${token.t}'`;
    default:
      return JSON.stringify(token.v);
  }
}

function literalError(message: string): never {
  throw new MockQueryError(QUERY_ERROR.literal, message);
}

function parseUnsigned(tag: "u64" | "u256", raw: string): bigint {
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(raw)) literalError(`${tag}(${raw}) is not an unsigned integer`);
  const value = BigInt(raw);
  const max = tag === "u64" ? 2n ** 64n - 1n : 2n ** 256n - 1n;
  if (value > max) literalError(`${tag}(${raw}) is out of range`);
  return value;
}

function parseHex(tag: "addr" | "key" | "bytes32", raw: string): `0x${string}` {
  const bytes = tag === "addr" ? 20 : 32;
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(raw)) {
    literalError(`${tag}(${raw}) must be ${bytes} bytes of hex`);
  }
  return raw.toLowerCase() as `0x${string}`;
}

/** Builds a typed literal from the text inside its constructor call. */
function makeLiteral(tag: string, raw: Token): MockValue {
  if (tag === "str") {
    if (raw.t !== "str") parseError(raw.pos, "a quoted string", describe(raw));
    if (new TextEncoder().encode(raw.v).length > 128) literalError("str is longer than 128 bytes");
    return { type: "str", value: raw.v };
  }
  if (raw.t !== "num") parseError(raw.pos, `a ${tag} value`, describe(raw));
  const text = raw.v;
  switch (tag) {
    case "i32": {
      if (!/^-?\d+$/.test(text)) literalError(`i32(${text}) is not an integer`);
      const value = BigInt(text);
      if (value < -(2n ** 31n) || value > 2n ** 31n - 1n) literalError(`i32(${text}) is out of range`);
      return { type: "i32", value };
    }
    case "u64":
    case "u256":
      return { type: tag, value: parseUnsigned(tag, text) };
    case "dec": {
      if (!/^-?\d+(\.\d+)?$/.test(text)) literalError(`dec(${text}) is not a decimal`);
      if ((text.split(".")[1]?.length ?? 0) > 18) literalError(`dec(${text}) has more than 18 decimal places`);
      return { type: "dec", value: text };
    }
    case "addr":
    case "key":
    case "bytes32":
      return { type: tag, value: parseHex(tag, text) };
    case "bool":
      // Booleans are written bare; the node rejects bool(...).
      return literalError("write booleans bare, as true or false");
    default:
      throw new MockQueryError(QUERY_ERROR.type, `${tag} values can't be compared`);
  }
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    if (this.peek().t === "eof") parseError(0, "a condition", "end of query");
    const node = this.or();
    const rest = this.peek();
    if (rest.t !== "eof") parseError(rest.pos, "AND, OR or end of query", describe(rest));
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private keyword(word: string): boolean {
    const token = this.peek();
    if (token.t === "word" && token.v.toUpperCase() === word) {
      this.index++;
      return true;
    }
    return false;
  }

  private expect<T extends Token["t"]>(t: T, expected: string): Extract<Token, { t: T }> {
    const token = this.next();
    if (token.t !== t) parseError(token.pos, expected, describe(token));
    return token as Extract<Token, { t: T }>;
  }

  private or(): Node {
    let node = this.and();
    while (this.keyword("OR")) node = { kind: "or", left: node, right: this.and() };
    return node;
  }

  private and(): Node {
    let node = this.not();
    while (this.keyword("AND")) node = { kind: "and", left: node, right: this.not() };
    return node;
  }

  private not(): Node {
    if (this.keyword("NOT")) return { kind: "not", operand: this.not() };
    return this.primary();
  }

  private primary(): Node {
    const token = this.peek();
    if (token.t === "(") {
      if (++this.depth > MAX_DEPTH) {
        throw new MockQueryError(QUERY_ERROR.limits, "query nests too deeply");
      }
      this.index++;
      const node = this.or();
      this.expect(")", "')'");
      this.depth--;
      return node;
    }
    if (this.keyword("EXISTS")) {
      this.expect("(", "'('");
      const name = this.name();
      this.expect(")", "')'");
      return { kind: "exists", name };
    }
    if (this.keyword("TYPEOF")) {
      this.expect("(", "'('");
      const name = this.name();
      this.expect(")", "')'");
      const op = this.expect("op", "'='");
      if (op.v !== "=") parseError(op.pos, "'='", describe(op));
      const tag = this.expect("word", "a type name");
      if (!TYPE_TAGS.has(tag.v)) {
        throw new MockQueryError(QUERY_ERROR.type, `unknown type ${tag.v}`);
      }
      return { kind: "typeof", name, tag: tag.v as TypeTag };
    }
    const name = this.name();
    if (this.keyword("STARTSWITH")) {
      const literal = this.literal();
      if (literal.type !== "str") {
        throw new MockQueryError(QUERY_ERROR.type, `STARTSWITH takes a str, got ${literal.type}`);
      }
      return { kind: "startsWith", name, prefix: literal.value };
    }
    const op = this.expect("op", "a comparison operator");
    const literal = this.literal();
    if (op.v !== "=" && op.v !== "!=" && !RANGE_TYPES.has(literal.type)) {
      throw new MockQueryError(QUERY_ERROR.type, `${op.v} is not defined for ${literal.type}`);
    }
    return { kind: "cmp", name, op: op.v as ComparisonOp, literal };
  }

  private name(): string {
    const token = this.expect("word", "an attribute name");
    const upper = token.v.toUpperCase();
    if (["AND", "OR", "NOT", "EXISTS", "TYPEOF", "STARTSWITH"].includes(upper)) {
      parseError(token.pos, "an attribute name", describe(token));
    }
    return token.v;
  }

  private literal(): MockValue {
    const token = this.next();
    if (token.t === "num") {
      // A bare number is an i32.
      return makeLiteral("i32", token);
    }
    if (token.t !== "word") parseError(token.pos, "a value", describe(token));
    const word = token.v;
    if (word === "true" || word === "false") return { type: "bool", value: word === "true" };
    if (!TYPE_TAGS.has(word)) parseError(token.pos, "a typed value such as str('x')", describe(token));
    this.expect("(", "'('");
    const literal = makeLiteral(word, this.next());
    this.expect(")", "')'");
    return literal;
  }
}

/** Decimal strings scaled to 18 places, so `dec` values compare as integers. */
function decUnits(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(whole || "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0").slice(0, 18) || "0");
  return negative ? -units : units;
}

function comparable(value: MockValue): bigint | string | boolean {
  switch (value.type) {
    case "dec":
      return decUnits(value.value);
    case "addr":
    case "key":
    case "bytes32":
    case "bytes":
      return value.value.toLowerCase();
    default:
      return value.value;
  }
}

/** What a name resolves to on one entity: an entity field, or an indexed attribute. */
function lookup(target: QueryTarget, name: string): MockValue | undefined {
  if (name.startsWith("$")) {
    switch (name) {
      case "$key":
        return { type: "key", value: target.key };
      case "$owner":
        return { type: "addr", value: target.owner };
      case "$creator":
        return { type: "addr", value: target.creator };
      case "$expiresAt":
        return { type: "u64", value: target.expiresAt };
    }
    return undefined;
  }
  // Only indexed attributes are visible to a filter; a stored-only one never matches.
  return target.attributes.find((attribute) => attribute.name === name && attribute.indexed);
}

function compare(op: ComparisonOp, a: bigint | string | boolean, b: bigint | string | boolean) {
  switch (op) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

function evaluate(node: Node, target: QueryTarget): boolean {
  switch (node.kind) {
    case "and":
      return evaluate(node.left, target) && evaluate(node.right, target);
    case "or":
      return evaluate(node.left, target) || evaluate(node.right, target);
    case "not":
      return !evaluate(node.operand, target);
    case "exists":
      return lookup(target, node.name) !== undefined;
    case "typeof":
      return lookup(target, node.name)?.type === node.tag;
    case "startsWith": {
      const value = lookup(target, node.name);
      return value?.type === "str" && value.value.startsWith(node.prefix);
    }
    case "cmp": {
      const value = lookup(target, node.name);
      if (!value || value.type !== node.literal.type) return false;
      return compare(node.op, comparable(value), comparable(node.literal));
    }
  }
}

/** Checks the static rules a node enforces before it reads any data. */
function validate(node: Node): void {
  switch (node.kind) {
    case "and":
    case "or":
      validate(node.left);
      validate(node.right);
      return;
    case "not":
      validate(node.operand);
      return;
    case "exists":
    case "typeof":
    case "startsWith":
    case "cmp": {
      if (!node.name.startsWith("$")) return;
      const fieldType = ENTITY_FIELDS[node.name];
      if (!fieldType) {
        throw new MockQueryError(
          QUERY_ERROR.type,
          `${node.name} can't be filtered on. Filterable entity fields are ${Object.keys(ENTITY_FIELDS).join(", ")}`,
        );
      }
      if (node.kind === "cmp" && node.literal.type !== fieldType) {
        throw new MockQueryError(
          QUERY_ERROR.type,
          `${node.name} is a ${fieldType}, compared to a ${node.literal.type}`,
        );
      }
      if (node.kind !== "cmp") {
        throw new MockQueryError(QUERY_ERROR.type, `${node.name} is always set`);
      }
    }
  }
}

/** Compiles a query string into a predicate, or throws a {@link MockQueryError}. */
export function compileQuery(query: string): (target: QueryTarget) => boolean {
  if (query.length > MAX_QUERY_LENGTH) {
    throw new MockQueryError(QUERY_ERROR.limits, `query is longer than ${MAX_QUERY_LENGTH} characters`);
  }
  const ast = new Parser(tokenize(query)).parse();
  validate(ast);
  return (target) => evaluate(ast, target);
}
