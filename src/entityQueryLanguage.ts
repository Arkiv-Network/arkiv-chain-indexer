/**
 * The Arkiv 0.8 entity query language: string → AST.
 *
 * A port of the node's `arkiv-query` crate (`~/arkiv-network/arkiv`, lexer.rs +
 * parse.rs + literal.rs), kept deliberately close to the original — same
 * grammar, same limits, same error kinds and, wherever a caller could see them,
 * the same messages and byte positions — so a query the node rejects is rejected
 * here for the same reason, and one it accepts means the same thing.
 *
 * ```text
 * top        → '*' | expr
 * expr       → andExpr { OR andExpr }
 * andExpr    → unary { AND unary }
 * unary      → NOT unary | primary
 * primary    → '(' expr ')' | predicate
 * predicate  → attrRef compOp value | attrRef STARTSWITH strValue
 * ```
 *
 * Every value carries a type tag and a predicate matches only an attribute of
 * that same type. A bare number means `i32`; a bare string is only legal for
 * the system attributes that have one obvious type (`$owner`, `$creator`,
 * `$key`, `$contentType`). Ordering (`< <= > >=`) exists for i32/u64/u256/dec
 * alone. `exists(…)`, `typeof(…)` and `!=` are reserved but unsupported, and
 * `* AND …` is an error — exactly as on the node.
 *
 * Positions are byte offsets into the UTF-8 text, as the node reports them.
 */
import { keccak256 } from "viem";
import {
  DECIMAL_SCALE,
  I256_MAX,
  I256_MIN,
  I32_MAX,
  I32_MIN,
  U256_MAX,
  U64_MAX,
  isOrderedType,
  type AttributeTypeTag,
} from "./entityValues";

// ---------------------------------------------------------------------------
// Limits (the node's `limits.rs`)

export const MAX_QUERY_BYTES = 8 * 1024;
export const MAX_PREDICATES = 64;
export const MAX_NESTING_DEPTH = 32;
export const MAX_ATTRIBUTE_NAME_BYTES = 32;
export const MAX_STR_BYTES = 128;

// ---------------------------------------------------------------------------
// Errors

export type QueryParseErrorKind = "malformed" | "type" | "literal" | "limit";

/** The JSON-RPC codes the node freezes for each failure kind. */
export const QUERY_ERROR_CODES: Record<QueryParseErrorKind, number> = {
  malformed: -32001,
  type: -32002,
  literal: -32003,
  limit: -32004,
};

export class QueryParseError extends Error {
  constructor(
    readonly kind: QueryParseErrorKind,
    message: string,
    /** Byte offset of the cause, when there is one. */
    readonly position: number | undefined,
  ) {
    super(message);
    this.name = "QueryParseError";
  }

  get rpcCode(): number {
    return QUERY_ERROR_CODES[this.kind];
  }
}

const syntaxError = (position: number, message: string) => new QueryParseError("malformed", message, position);
const typeError = (position: number, message: string) => new QueryParseError("type", message, position);
const literalError = (position: number, message: string) => new QueryParseError("literal", message, position);

// ---------------------------------------------------------------------------
// AST

export type QueryValue =
  | { type: "bool"; value: boolean }
  | { type: "i32"; value: number }
  | { type: "u64"; value: bigint }
  | { type: "u256"; value: bigint }
  /** Scaled by 10^18, signed. */
  | { type: "dec"; units: bigint }
  | { type: "str"; value: string }
  /** Lowercase `0x` + 40 hex. */
  | { type: "addr"; value: string }
  /** Lowercase `0x` + 64 hex. */
  | { type: "key"; value: string }
  | { type: "bytes32"; value: string };

export type BuiltInField = "owner" | "creator" | "key" | "expiresAt" | "createdAt" | "contentType";

export type AttributeRef = { kind: "user"; name: string } | { kind: "builtin"; field: BuiltInField };

export type ComparisonOperator = "eq" | "lt" | "lte" | "gt" | "gte";

export type QueryAst =
  | { kind: "all" }
  | { kind: "compare"; op: ComparisonOperator; key: AttributeRef; value: QueryValue }
  | { kind: "startsWith"; key: AttributeRef; value: { type: "str"; value: string } }
  | { kind: "and"; left: QueryAst; right: QueryAst }
  | { kind: "or"; left: QueryAst; right: QueryAst }
  | { kind: "not"; inner: QueryAst };

// ---------------------------------------------------------------------------
// Lexer

type TypeTag = Exclude<AttributeTypeTag, "bytes">;

const TYPE_TAGS: readonly TypeTag[] = ["i32", "u64", "u256", "dec", "str", "addr", "key", "bytes32", "bool"];

function typeTagFromName(name: string): TypeTag | undefined {
  const lower = name.toLowerCase();
  return TYPE_TAGS.find((tag) => tag === lower);
}

type Token =
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "and" }
  | { t: "or" }
  | { t: "not" }
  | { t: "startswith" }
  | { t: "exists" }
  | { t: "typeof" }
  | { t: "eq" }
  | { t: "neq" }
  | { t: "lt" }
  | { t: "lte" }
  | { t: "gt" }
  | { t: "gte" }
  | { t: "star" }
  | { t: "true" }
  | { t: "false" }
  | { t: "name"; text: string }
  | { t: "sysname"; text: string }
  | { t: "tagged"; tag: TypeTag; body: string; bodyStart: number }
  | { t: "int"; text: string }
  | { t: "str"; text: string };

interface SpannedToken {
  token: Token;
  start: number;
}

const KEYWORDS: Record<string, Token> = {
  and: { t: "and" },
  or: { t: "or" },
  not: { t: "not" },
  true: { t: "true" },
  false: { t: "false" },
  startswith: { t: "startswith" },
  exists: { t: "exists" },
  typeof: { t: "typeof" },
};

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const isAlpha = (byte: number) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
const isNameChar = (byte: number) => isAlpha(byte) || isDigit(byte) || byte === 0x5f || byte === 0x2e || byte === 0x2d;

/**
 * Scan a `'…'` literal starting at the opening quote, resolving `''` to one
 * quote. Returns the contents and the offset just past the closing quote.
 */
function scanSingleQuoted(src: Buffer, open: number): { content: string; end: number } {
  const parts: number[] = [];
  let index = open + 1;
  for (;;) {
    if (index >= src.length) {
      throw syntaxError(open, "unterminated string literal — expected a closing '");
    }
    const byte = src[index]!;
    if (byte === 0x27) {
      if (src[index + 1] === 0x27) {
        parts.push(0x27);
        index += 2;
        continue;
      }
      return { content: Buffer.from(parts).toString("utf8"), end: index + 1 };
    }
    parts.push(byte);
    index += 1;
  }
}

/** Decode the UTF-8 character starting at `index`, for the few non-ASCII checks. */
function charAt(src: Buffer, index: number): string {
  const lead = src[index]!;
  const width = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return src.subarray(index, index + width).toString("utf8");
}

class Lexer {
  private pos = 0;

  constructor(private readonly src: Buffer) {}

  tokenize(): SpannedToken[] {
    const tokens: SpannedToken[] = [];
    for (;;) {
      const token = this.nextToken();
      if (!token) return tokens;
      tokens.push(token);
    }
  }

  private peek(): number | undefined {
    return this.src[this.pos];
  }

  private startsWith(text: string): boolean {
    return this.src.subarray(this.pos, this.pos + text.length).toString("latin1") === text;
  }

  /** Skip whitespace and `--` comments until real input or end of file. */
  private skipTrivia(): void {
    for (;;) {
      while (this.pos < this.src.length) {
        const byte = this.src[this.pos]!;
        if (byte < 0x80) {
          if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) {
            this.pos += 1;
            continue;
          }
          break;
        }
        const char = charAt(this.src, this.pos);
        if (/^\s$/u.test(char) && char !== "﻿") {
          this.pos += Buffer.byteLength(char);
          continue;
        }
        break;
      }
      if (!this.startsWith("--")) return;
      while (this.pos < this.src.length) {
        const byte = this.src[this.pos]!;
        this.pos += 1;
        if (byte === 0x0a) break;
      }
    }
  }

  private nextToken(): SpannedToken | undefined {
    this.skipTrivia();
    const start = this.pos;
    const byte = this.peek();
    if (byte === undefined) return undefined;

    let token: Token;
    switch (byte) {
      case 0x28: // (
        this.pos += 1;
        token = { t: "lparen" };
        break;
      case 0x29: // )
        this.pos += 1;
        token = { t: "rparen" };
        break;
      case 0x2a: // *
        this.pos += 1;
        token = { t: "star" };
        break;
      case 0x3d: // =
        this.pos += 1;
        token = { t: "eq" };
        break;
      case 0x21: // !
        this.pos += 1;
        if (this.peek() === 0x3d) {
          this.pos += 1;
          token = { t: "neq" };
        } else {
          throw syntaxError(start, "unexpected '!' — negation is written NOT");
        }
        break;
      case 0x3c: // <
        this.pos += 1;
        token = this.takeIfEquals({ t: "lte" }, { t: "lt" });
        break;
      case 0x3e: // >
        this.pos += 1;
        token = this.takeIfEquals({ t: "gte" }, { t: "gt" });
        break;
      case 0x27: {
        // '
        const { content, end } = scanSingleQuoted(this.src, this.pos);
        this.pos = end;
        token = { t: "str", text: content };
        break;
      }
      case 0x24: {
        // $
        this.pos += 1;
        const name = this.takeNameChars();
        if (name.length === 0) {
          throw syntaxError(start, "expected a system attribute name after '$'");
        }
        token = { t: "sysname", text: name };
        break;
      }
      case 0x26: // &
      case 0x7c: // |
      case 0x7e: // ~
        throw syntaxError(start, "symbol operators (&& || ~) were removed — use AND, OR, STARTSWITH");
      case 0x2d: // -
      case 0x2b: {
        // +
        const signed = this.takeIntChars();
        if (signed.length <= 1) {
          throw syntaxError(start, "expected digits after the sign");
        }
        token = { t: "int", text: signed };
        break;
      }
      default:
        if (isDigit(byte)) {
          if (this.startsWith("0x") || this.startsWith("0X")) {
            throw syntaxError(
              start,
              "a hex literal must carry its type — write addr(0x…), key(0x…), bytes32(0x…) or u256(0x…)",
            );
          }
          token = { t: "int", text: this.takeIntChars() };
        } else if (isAlpha(byte)) {
          token = this.lexWord(start);
        } else {
          throw syntaxError(start, "unexpected character");
        }
    }
    return { token, start };
  }

  private takeIfEquals(withEquals: Token, bare: Token): Token {
    if (this.peek() === 0x3d) {
      this.pos += 1;
      return withEquals;
    }
    return bare;
  }

  /** A keyword, a typed literal, or a plain attribute name. */
  private lexWord(start: number): Token {
    const word = this.takeNameChars();
    const keyword = KEYWORDS[word.toLowerCase()];
    if (keyword) return keyword;

    const tag = typeTagFromName(word);
    if (tag) {
      const afterWord = this.pos;
      this.skipTrivia();
      if (this.peek() === 0x28) {
        this.pos += 1;
        return this.takeTaggedBody(start, tag);
      }
      this.pos = afterWord;
    }
    return { t: "name", text: word };
  }

  /** The raw text between a typed literal's parentheses, quotes scanned as units. */
  private takeTaggedBody(literalStart: number, tag: TypeTag): Token {
    const bodyStart = this.pos;
    let depth = 1;
    for (;;) {
      const byte = this.peek();
      if (byte === undefined) {
        throw syntaxError(literalStart, "unterminated typed literal — expected a closing ')'");
      }
      if (byte === 0x27) {
        const { end } = scanSingleQuoted(this.src, this.pos);
        this.pos = end;
      } else if (byte === 0x28) {
        depth += 1;
        this.pos += 1;
      } else if (byte === 0x29) {
        depth -= 1;
        if (depth === 0) {
          const body = this.src.subarray(bodyStart, this.pos).toString("utf8");
          this.pos += 1;
          return { t: "tagged", tag, body, bodyStart };
        }
        this.pos += 1;
      } else {
        this.pos += 1;
      }
    }
  }

  private takeNameChars(): string {
    const start = this.pos;
    while (this.pos < this.src.length && isNameChar(this.src[this.pos]!)) this.pos += 1;
    return this.src.subarray(start, this.pos).toString("latin1");
  }

  private takeIntChars(): string {
    const start = this.pos;
    const first = this.peek();
    if (first === 0x2d || first === 0x2b) this.pos += 1;
    while (this.pos < this.src.length && isDigit(this.src[this.pos]!)) this.pos += 1;
    return this.src.subarray(start, this.pos).toString("latin1");
  }
}

// ---------------------------------------------------------------------------
// Literals (the node's `literal.rs`)

function splitSign(text: string): { negative: boolean; rest: string } {
  if (text.startsWith("-")) return { negative: true, rest: text.slice(1) };
  if (text.startsWith("+")) return { negative: false, rest: text.slice(1) };
  return { negative: false, rest: text };
}

function stripHexPrefix(text: string): string | undefined {
  if (text.startsWith("0x") || text.startsWith("0X")) return text.slice(2);
  return undefined;
}

function tooLarge(position: number, tag: string): QueryParseError {
  return literalError(position, `value is out of range for ${tag}`);
}

/** Decimal digits into a bigint, with the node's per-tag messages; `max` bounds it. */
function decimalMagnitude(digits: string, position: number, tag: string, max: bigint): bigint {
  if (digits.length === 0) throw literalError(position, `${tag} expects a number`);
  let value = 0n;
  for (const char of digits) {
    if (char < "0" || char > "9") throw literalError(position, `${tag} expects decimal digits`);
    value = value * 10n + BigInt(char.charCodeAt(0) - 48);
    if (value > max) throw tooLarge(position, tag);
  }
  return value;
}

function checkHexDigits(hex: string, position: number, tag: string): void {
  if (hex.length === 0) throw literalError(position, `${tag} expects hex digits after 0x`);
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw literalError(position, `${tag} contains a non-hex digit`);
}

function parseI32(body: string, position: number): number {
  const { negative, rest } = splitSign(body.trim());
  const magnitude = decimalMagnitude(rest, position, "i32", U64_MAX);
  const limit = negative ? BigInt(I32_MAX) + 1n : BigInt(I32_MAX);
  if (magnitude > limit) {
    throw literalError(
      position,
      "value is out of range for i32 [-2147483648, 2147483647] — use u256(…) for larger numbers",
    );
  }
  return Number(negative ? -magnitude : magnitude);
}

function parseU64(body: string, position: number): bigint {
  const text = body.trim();
  if (text.startsWith("-") || text.startsWith("+")) {
    throw literalError(position, "u64 is unsigned — remove the sign, or use i32(…)");
  }
  const hex = stripHexPrefix(text);
  if (hex !== undefined) {
    if (hex.length === 0 || hex.length > 16) {
      throw literalError(position, "u64 hex must be 1 to 16 digits — use u256(…) for larger numbers");
    }
    checkHexDigits(hex, position, "u64");
    return BigInt(`0x${hex}`);
  }
  return decimalMagnitude(text, position, "u64", U64_MAX);
}

function parseU256(body: string, position: number): bigint {
  const text = body.trim();
  if (text.startsWith("-") || text.startsWith("+")) {
    throw literalError(position, "u256 is unsigned — remove the sign, or use i32(…)");
  }
  const hex = stripHexPrefix(text);
  if (hex !== undefined) {
    checkHexDigits(hex, position, "u256");
    if (hex.replace(/^0+/, "").length > 64) throw tooLarge(position, "u256");
    return BigInt(`0x${hex}`);
  }
  return decimalMagnitude(text, position, "u256", U256_MAX);
}

function parseDec(body: string, position: number): bigint {
  const { negative, rest } = splitSign(body.trim());
  const dot = rest.indexOf(".");
  const whole = dot === -1 ? rest : rest.slice(0, dot);
  const fraction = dot === -1 ? "" : rest.slice(dot + 1);
  if (whole.length === 0) {
    throw literalError(position, "dec needs at least one digit before the decimal point");
  }
  if (dot !== -1 && fraction.length === 0) {
    throw literalError(position, "dec needs at least one digit after the decimal point");
  }
  if (fraction.length > DECIMAL_SCALE) {
    throw literalError(
      position,
      "dec accepts at most 18 decimal places — excess precision is rejected, never rounded",
    );
  }
  let value = decimalMagnitude(whole, position, "dec", U256_MAX);
  for (let place = 0; place < DECIMAL_SCALE; place += 1) {
    const char = fraction[place];
    let digit = 0n;
    if (char !== undefined) {
      if (char < "0" || char > "9") throw literalError(position, "dec expects decimal digits");
      digit = BigInt(char.charCodeAt(0) - 48);
    }
    value = value * 10n + digit;
    if (value > U256_MAX) throw tooLarge(position, "dec");
  }
  // The scaled magnitude must fit a signed 256-bit word.
  if (value > I256_MAX && !(negative && value === -I256_MIN)) throw tooLarge(position, "dec");
  return negative ? -value : value;
}

function parseStr(body: string, position: number): string {
  const text = body.trim();
  if (!text.startsWith("'")) {
    throw literalError(position, "str takes a single-quoted string, e.g. str('Bob')");
  }
  const buffer = Buffer.from(text, "utf8");
  const { content, end } = scanSingleQuoted(buffer, 0);
  if (end !== buffer.length) {
    throw literalError(position, "unexpected text after the closing quote in str(…)");
  }
  validateStrLength(content, position);
  return content;
}

function validateStrLength(content: string, position: number): void {
  if (Buffer.byteLength(content, "utf8") > MAX_STR_BYTES) {
    throw literalError(position, "str values are limited to 128 bytes of UTF-8");
  }
}

/** Reject a mixed-case address whose EIP-55 checksum does not hold. */
function checkEip55(hex: string, position: number): void {
  const hasUpper = /[A-F]/.test(hex);
  const hasLower = /[a-f]/.test(hex);
  if (!(hasUpper && hasLower)) return;
  const digest = keccak256(Buffer.from(hex.toLowerCase(), "ascii")).slice(2);
  for (let index = 0; index < hex.length; index += 1) {
    const char = hex[index]!;
    if (char >= "0" && char <= "9") continue;
    const nibble = parseInt(digest[index]!, 16);
    const upper = char >= "A" && char <= "F";
    if (upper !== nibble >= 8) {
      throw literalError(
        position,
        "address fails its EIP-55 checksum — fix the capitalization, or write it all-lowercase",
      );
    }
  }
}

function parseAddr(body: string, position: number): string {
  const text = body.trim();
  const hex = stripHexPrefix(text);
  if (hex === undefined) {
    throw literalError(position, "addr takes a 0x-prefixed address, e.g. addr(0xAbC…)");
  }
  if (hex.length !== 40) {
    throw literalError(position, "an address is 0x followed by exactly 40 hex digits");
  }
  checkHexDigits(hex, position, "addr");
  checkEip55(hex, position);
  return `0x${hex.toLowerCase()}`;
}

function parseWordHex(body: string, position: number, tag: string): string {
  const text = body.trim();
  const hex = stripHexPrefix(text);
  if (hex === undefined) {
    throw literalError(position, "expected a 0x-prefixed 32-byte value");
  }
  if (hex.length !== 64) {
    throw literalError(position, "expected 0x followed by exactly 64 hex digits");
  }
  checkHexDigits(hex, position, tag);
  return `0x${hex.toLowerCase()}`;
}

function parseTagged(tag: TypeTag, body: string, position: number): QueryValue {
  switch (tag) {
    case "i32":
      return { type: "i32", value: parseI32(body, position) };
    case "u64":
      return { type: "u64", value: parseU64(body, position) };
    case "u256":
      return { type: "u256", value: parseU256(body, position) };
    case "dec":
      return { type: "dec", units: parseDec(body, position) };
    case "str":
      return { type: "str", value: parseStr(body, position) };
    case "addr":
      return { type: "addr", value: parseAddr(body, position) };
    case "key":
      return { type: "key", value: parseWordHex(body, position, "key") };
    case "bytes32":
      return { type: "bytes32", value: parseWordHex(body, position, "bytes32") };
    case "bool":
      throw literalError(position, "bool takes no wrapper — write the literal true or false");
  }
}

// ---------------------------------------------------------------------------
// Parser (the node's `parse.rs`)

function builtinType(field: BuiltInField): AttributeTypeTag {
  switch (field) {
    case "owner":
    case "creator":
      return "addr";
    case "key":
      return "key";
    case "expiresAt":
    case "createdAt":
      return "u64";
    case "contentType":
      return "str";
  }
}

function builtinFromName(name: string, position: number): BuiltInField {
  switch (name) {
    case "owner":
    case "creator":
    case "key":
    case "expiresAt":
    case "createdAt":
    case "contentType":
      return name;
    case "updatedAt":
      throw typeError(position, "$updatedAt is not queryable — it is returned by projections only");
    case "creationFlags":
      throw typeError(position, "$creationFlags is not queryable — it is returned by projections only");
    case "payload":
      throw typeError(position, "$payload is not queryable — bytes values carry no index");
    case "expiration":
      throw typeError(position, "unknown system attribute $expiration — it is now $expiresAt");
    case "createdAtBlock":
      throw typeError(position, "unknown system attribute $createdAtBlock — it is now $createdAt");
    default:
      throw typeError(
        position,
        `unknown system attribute $${name} — expected $key, $owner, $creator, $expiresAt, $createdAt or $contentType`,
      );
  }
}

function validateUserName(name: string, position: number): void {
  if (Buffer.byteLength(name, "utf8") > MAX_ATTRIBUTE_NAME_BYTES) {
    throw syntaxError(position, "attribute names are limited to 32 bytes");
  }
  const tag = typeTagFromName(name);
  if (tag) {
    throw syntaxError(position, `${tag} is a type name and cannot be an attribute name`);
  }
}

function bareIntValue(key: AttributeRef, text: string, position: number): QueryValue {
  if (key.kind === "builtin") {
    const expected = builtinType(key.field);
    throw typeError(
      position,
      expected === "u64"
        ? `this system attribute holds u64 — write u64(${text.trim()})`
        : `this system attribute holds ${expected}, but the value is an untagged number (which means i32)`,
    );
  }
  return { type: "i32", value: parseI32(text, position) };
}

function bareStrValue(key: AttributeRef, content: string, position: number): QueryValue {
  if (key.kind === "user") {
    throw typeError(position, "untagged strings are only valid for system attributes — write str('…')");
  }
  switch (key.field) {
    case "contentType":
      validateStrLength(content, position);
      return { type: "str", value: content };
    case "owner":
    case "creator":
      return { type: "addr", value: parseAddr(content, position) };
    case "key":
      return { type: "key", value: parseWordHex(content, position, "key") };
    default:
      throw typeError(position, "this system attribute is not a string");
  }
}

function checkValueType(key: AttributeRef, value: QueryValue, position: number): void {
  if (key.kind !== "builtin") return;
  const expected = builtinType(key.field);
  if (value.type === expected) return;
  throw typeError(position, `this system attribute holds ${expected}, but the value is ${value.type}`);
}

function checkOperator(operator: Token["t"], value: QueryValue, position: number): void {
  const isRange = operator === "lt" || operator === "lte" || operator === "gt" || operator === "gte";
  if (isRange && !isOrderedType(value.type)) {
    throw typeError(
      position,
      `${value.type} values have no ordering — only i32, u64, u256 and dec support < <= > >=`,
    );
  }
}

class Parser {
  private pos = 0;
  private depth = 0;
  private predicates = 0;

  constructor(
    private readonly tokens: SpannedToken[],
    private readonly end: number,
  ) {}

  private peek(): SpannedToken | undefined {
    return this.tokens[this.pos];
  }

  private advance(): SpannedToken | undefined {
    const spanned = this.tokens[this.pos];
    if (spanned) this.pos += 1;
    return spanned;
  }

  private nextPosition(): number {
    return this.peek()?.start ?? this.end;
  }

  parseTopLevel(): QueryAst {
    if (this.tokens.length === 0) {
      throw syntaxError(0, "empty query — write a predicate, or * to match every entity");
    }
    if (this.peek()?.token.t === "star") {
      this.advance();
      const next = this.peek();
      if (next) {
        throw syntaxError(next.start, "* matches every entity and cannot be combined with other predicates");
      }
      return { kind: "all" };
    }
    const query = this.parseExpr();
    const trailing = this.peek();
    if (trailing) {
      throw syntaxError(trailing.start, "unexpected trailing input — did you mean to join these with AND or OR?");
    }
    return query;
  }

  private parseExpr(): QueryAst {
    let query = this.parseAnd();
    while (this.peek()?.token.t === "or") {
      this.advance();
      const right = this.parseAnd();
      query = { kind: "or", left: query, right };
    }
    return query;
  }

  private parseAnd(): QueryAst {
    let query = this.parseUnary();
    while (this.peek()?.token.t === "and") {
      this.advance();
      const right = this.parseUnary();
      query = { kind: "and", left: query, right };
    }
    return query;
  }

  private parseUnary(): QueryAst {
    const spanned = this.peek();
    if (!spanned) throw syntaxError(this.end, "expected a predicate");
    if (spanned.token.t !== "not") return this.parsePrimary();
    this.advance();
    this.descend(spanned.start);
    // NOT binds tighter than AND: `NOT a = true AND b = true` is `(NOT a) AND b`.
    const inner = this.parseUnary();
    this.depth -= 1;
    return { kind: "not", inner };
  }

  private parsePrimary(): QueryAst {
    const spanned = this.peek();
    if (!spanned) throw syntaxError(this.end, "expected a predicate");
    if (spanned.token.t !== "lparen") return this.parsePredicate();
    this.advance();
    this.descend(spanned.start);
    const inner = this.parseExpr();
    const closing = this.advance();
    if (closing?.token.t !== "rparen") {
      throw syntaxError(spanned.start, "unclosed group — expected ')'");
    }
    this.depth -= 1;
    return inner;
  }

  private descend(position: number): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING_DEPTH) {
      throw new QueryParseError("limit", "query is nested too deeply", position);
    }
  }

  private parsePredicate(): QueryAst {
    this.predicates += 1;
    if (this.predicates > MAX_PREDICATES) {
      throw new QueryParseError("limit", "query has too many predicates", this.nextPosition());
    }
    const key = this.parseAttrRef();
    const operator = this.advance();
    if (!operator) {
      throw syntaxError(
        this.end,
        "expected a comparison operator (= < <= > >= STARTSWITH) after the attribute",
      );
    }
    switch (operator.token.t) {
      case "eq":
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const { value, position } = this.parseValue(key);
        checkOperator(operator.token.t, value, position);
        return { kind: "compare", op: operator.token.t, key, value };
      }
      case "startswith": {
        const { value, position } = this.parseValue(key);
        if (value.type !== "str") {
          throw typeError(position, "STARTSWITH matches a string prefix — write str('…')");
        }
        return { kind: "startsWith", key, value };
      }
      case "neq":
        throw typeError(
          operator.start,
          "!= is not part of the query language — write NOT (attr = value) for the complement",
        );
      default:
        throw syntaxError(operator.start, "expected a comparison operator (= < <= > >= STARTSWITH)");
    }
  }

  private parseAttrRef(): AttributeRef {
    const spanned = this.advance();
    if (!spanned) throw syntaxError(this.end, "expected an attribute name");
    const { token } = spanned;
    switch (token.t) {
      case "name":
        validateUserName(token.text, spanned.start);
        return { kind: "user", name: token.text };
      case "sysname":
        return { kind: "builtin", field: builtinFromName(token.text, spanned.start) };
      case "exists":
        throw typeError(
          spanned.start,
          "exists(…) is not supported — the index has no per-attribute presence set in this version",
        );
      case "typeof":
        throw typeError(
          spanned.start,
          "typeof(…) is not supported — a value predicate already asserts the attribute's type",
        );
      case "and":
      case "or":
      case "not":
      case "true":
      case "false":
      case "startswith":
        throw syntaxError(spanned.start, "a reserved word cannot be used as an attribute name");
      default:
        throw syntaxError(spanned.start, "expected an attribute name");
    }
  }

  private parseValue(key: AttributeRef): { value: QueryValue; position: number } {
    const spanned = this.advance();
    if (!spanned) throw syntaxError(this.end, "expected a value, e.g. i32(10) or str('Bob')");
    const position = spanned.start;
    const { token } = spanned;
    let value: QueryValue;
    switch (token.t) {
      case "tagged":
        value = parseTagged(token.tag, token.body, token.bodyStart);
        break;
      case "true":
        value = { type: "bool", value: true };
        break;
      case "false":
        value = { type: "bool", value: false };
        break;
      case "int":
        value = bareIntValue(key, token.text, position);
        break;
      case "str":
        value = bareStrValue(key, token.text, position);
        break;
      default:
        throw syntaxError(position, "expected a value, e.g. i32(10) or str('Bob')");
    }
    checkValueType(key, value, position);
    return { value, position };
  }
}

// ---------------------------------------------------------------------------
// Entry point

/** Parse a query string into its AST, or throw a {@link QueryParseError}. */
export function parseEntityQuery(input: string): QueryAst {
  const src = Buffer.from(input, "utf8");
  if (src.length > MAX_QUERY_BYTES) {
    throw new QueryParseError("limit", "query is too long", undefined);
  }
  const tokens = new Lexer(src).tokenize();
  return new Parser(tokens, src.length).parseTopLevel();
}

/** The JSON-RPC `error` object the node answers a bad query with. */
export function queryErrorBody(error: QueryParseError): { code: number; message: string; data: Record<string, unknown> } {
  return {
    code: error.rpcCode,
    message: error.message,
    data:
      error.position === undefined
        ? { message: error.message }
        : { position: error.position, message: error.message },
  };
}
