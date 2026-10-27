// The framework-free half of how the explorer shows UDC attributes: one model
// for the three places attributes come from (a decoded operation, the entity
// index's state, an arkiv_query answer), the canonical text of each type,
// which attributes a query can match, the arkiv.schema tag, permanence, and
// what a patch did to an entity's attribute set. No React here so `bun test`
// can cover it.

import type { ArkivOperationAttribute, EntityAttribute } from "./api";
import { hexToBytes, keccak256Hex } from "./keccak";

/** `expiresAt` of an entity that never expires: 2^64 − 1, as the API spells it. */
export const PERMANENT_EXPIRES_AT = "18446744073709551615";
const U64_MAX = (1n << 64n) - 1n;

/**
 * Whether an expiry is the permanent one, exactly: a decimal string (the
 * REST API), a `0x` quantity (arkiv_query) or a bigint. A JS number can never
 * hold 2^64 − 1, so a number is never permanent — there is no lifetime
 * heuristic, a century-long finite expiry is finite.
 */
export function isPermanentExpiry(value: string | bigint | number | null | undefined): boolean {
  if (typeof value === "bigint") return value === U64_MAX;
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (text === PERMANENT_EXPIRES_AT) return true;
  if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(text)) return false;
  return BigInt(text) === U64_MAX;
}

/** The ten value types of a UDC attribute, by the low seven bits of its typeId. */
export const ATTRIBUTE_TYPE_TAGS = ["bool", "i32", "u64", "u256", "dec", "bytes32", "bytes", "str", "addr", "key"] as const;
export type AttributeTypeTag = (typeof ATTRIBUTE_TYPE_TAGS)[number];

export function isAttributeTypeTag(value: string): value is AttributeTypeTag {
  return (ATTRIBUTE_TYPE_TAGS as readonly string[]).includes(value);
}

/**
 * One attribute as the explorer shows it, whichever source it came from.
 * `value` stays in the node's arkiv_query encoding (u64/u256 `0x`
 * quantities, i32 a number, bool a boolean, dec a decimal string, str text,
 * bytes32/key/addr lowercase hex); {@link attributeText} renders it.
 */
export interface AttributeView {
  name: string;
  /** A type tag, `tombstone` (a patch unsetting the name), `invalid(0x..)` or `unknown`. */
  type: string;
  /** Queryable; null when the source does not say (an arkiv_query answer without attributeSchema). */
  indexed: boolean | null;
  /** Wire value; null for a tombstone, an invalid triple, and bytes whose content the source withheld. */
  value: unknown;
  /** bytes: the content's length in bytes. */
  size?: number;
  /** bytes: keccak256 of the content. */
  keccak256?: string;
  /** bytes: the content as `0x` hex, when the source carried it (a node does; the index never does). */
  content?: string;
  /** Why a decoded triple is not a valid attribute. */
  error?: string;
}

/** A triple decoded from calldata (create attributes, patch mutations). */
export function fromOperationAttribute(attribute: ArkivOperationAttribute): AttributeView {
  return {
    name: attribute.name,
    type: attribute.type,
    indexed: attribute.indexed,
    value: attribute.value,
    ...(attribute.type === "bytes" ? { size: attribute.size, ...(attribute.keccak256 ? { keccak256: attribute.keccak256 } : {}) } : {}),
    ...(attribute.error ? { error: attribute.error } : {}),
  };
}

/** An attribute of the entity index's state (`/entity/<key>` `state` and `genesis`). */
export function fromEntityAttribute(attribute: EntityAttribute): AttributeView {
  return {
    name: attribute.name,
    type: attribute.type,
    indexed: attribute.indexed,
    value: attribute.value ?? null,
    ...(attribute.size !== undefined ? { size: attribute.size } : {}),
    ...(attribute.keccak256 ? { keccak256: attribute.keccak256 } : {}),
  };
}

export interface RpcAttributeLike {
  name?: unknown;
  type?: unknown;
  value?: unknown;
}

export interface RpcAttributeSchemaLike {
  name?: unknown;
  type?: unknown;
  indexed?: unknown;
}

/**
 * An arkiv_query answer's `attributes`, with the `indexed` flags of its
 * `attributeSchema` when that was selected. A node sends a bytes value as `0x`
 * hex, which is measured and hashed here (and kept for display); the index
 * sends null and nothing else, which stays withheld.
 */
export function fromRpcAttributes(attributes: unknown, schema?: unknown): AttributeView[] {
  const indexedByName = new Map<string, boolean>();
  if (Array.isArray(schema)) {
    for (const entry of schema as RpcAttributeSchemaLike[]) {
      if (entry && typeof entry.name === "string" && typeof entry.indexed === "boolean") indexedByName.set(entry.name, entry.indexed);
    }
  }
  if (!Array.isArray(attributes)) return [];
  const out: AttributeView[] = [];
  for (const item of attributes as RpcAttributeLike[]) {
    if (!item || typeof item.name !== "string" || typeof item.type !== "string") continue;
    const view: AttributeView = {
      name: item.name,
      type: item.type,
      indexed: indexedByName.get(item.name) ?? null,
      value: item.value ?? null,
    };
    if (item.type === "bytes" && typeof item.value === "string") {
      try {
        const bytes = hexToBytes(item.value);
        view.content = item.value.toLowerCase();
        view.size = bytes.length;
        view.keccak256 = keccak256Hex(bytes);
      } catch {
        view.error = "bytes value is not hex";
      }
      view.value = null;
    }
    out.push(view);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Values

/** A `0x` quantity (or a decimal string) as exact decimal; anything else unchanged. */
export function quantityToDecimal(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value).toString();
    if (/^-?\d+$/.test(value)) return value;
    return value;
  }
  return JSON.stringify(value) ?? "";
}

/** EIP-55 mixed-case checksum of a 20-byte address; the input unchanged when it is not one. */
export function toChecksumAddress(address: string): string {
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return address;
  const lower = trimmed.slice(2).toLowerCase();
  const hash = keccak256Hex(lower).slice(2);
  let out = "0x";
  for (let index = 0; index < lower.length; index++) {
    const char = lower[index]!;
    out += parseInt(hash[index]!, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * The canonical text of an attribute's value: decimal for the integer types
 * (u256 exact, through BigInt), the trimmed decimal for dec, EIP-55 for an
 * address, lowercase hex for keys and bytes32, `true`/`false`, the text of a
 * str, and the size of a bytes value.
 */
export function attributeText(attribute: AttributeView): string {
  const { type, value } = attribute;
  switch (type) {
    case "bool":
      return value === true || value === "true" ? "true" : value === false || value === "false" ? "false" : String(value);
    case "i32":
    case "u64":
    case "u256":
      return quantityToDecimal(value);
    case "dec":
      return typeof value === "string" ? value : quantityToDecimal(value);
    case "addr":
      return typeof value === "string" ? toChecksumAddress(value) : String(value);
    case "key":
    case "bytes32":
      return typeof value === "string" ? value.toLowerCase() : String(value);
    case "str":
      return typeof value === "string" ? value : JSON.stringify(value) ?? "";
    case "bytes":
      return attribute.size === undefined ? "bytes" : `${attribute.size.toLocaleString("en-US")} bytes`;
    case "tombstone":
      return "unset";
    default:
      return value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value) ?? "";
  }
}

/**
 * Characters that can reorder, hide or disguise text on screen: C1 controls,
 * bidirectional embeddings, overrides, isolates and marks, and invisible
 * format characters (zero-width space and non-joiner, word joiner, BOM). The
 * zero-width joiner stays: emoji sequences need it.
 */
const SPOOFING_CHARACTERS = /[\u0080-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Text as it is safe to show: every spoofing character written out as a
 * visible `\u{XXXX}` escape. For display only — query conditions and copied
 * values keep the real text.
 */
export function visibleText(text: string): string {
  return text.replace(SPOOFING_CHARACTERS, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** Two values are the same when their type and canonical text are (bytes: size and keccak256). */
export function sameAttributeValue(a: AttributeView, b: AttributeView): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "bytes") return a.size === b.size && (a.keccak256 ?? null) === (b.keccak256 ?? null);
  return attributeText(a) === attributeText(b);
}

// ---------------------------------------------------------------------------
// Query conditions

/** Words the node's lexer reserves: a type name or keyword can never be an attribute name in a query. */
const RESERVED_NAMES = new Set([
  ...ATTRIBUTE_TYPE_TAGS.filter((tag) => tag !== "bytes"),
  "and", "or", "not", "startswith", "exists", "typeof", "true", "false",
]);

/** Whether the query grammar can name an attribute: `[A-Za-z][A-Za-z0-9_.-]*`, not a type name or keyword. */
export function isQueryableName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) && !RESERVED_NAMES.has(name.toLowerCase());
}

/** The typed literal the query grammar expects for a value in canonical text. */
export function queryLiteral(type: string, text: string): string {
  // Single quotes, doubled to escape: str('it''s') parses at the node.
  if (type === "str") return `str('${text.replace(/'/g, "''")}')`;
  // Booleans are written bare; the node rejects bool(true).
  if (type === "bool") return text === "true" ? "true" : "false";
  // The node compares addresses as bytes; lowercase keeps the literal plain.
  if (type === "addr") return `addr(${text.toLowerCase()})`;
  return `${type}(${text})`;
}

/**
 * The `name = literal` condition matching this attribute, or null when no
 * query can match it: an unindexed attribute (the node never matches one), a
 * bytes value (never indexed), a tombstone or invalid triple, or a name the
 * grammar cannot spell. An attribute whose flag is unknown is offered.
 */
export function attributeCondition(attribute: AttributeView): string | null {
  if (attribute.indexed === false) return null;
  if (!isAttributeTypeTag(attribute.type) || attribute.type === "bytes") return null;
  if (attribute.value === null || attribute.value === undefined) return null;
  if (!isQueryableName(attribute.name)) return null;
  return `${attribute.name} = ${queryLiteral(attribute.type, attributeText(attribute))}`;
}

/** Why {@link attributeCondition} offers nothing, for a tooltip; null when it does. */
export function conditionUnavailableReason(attribute: AttributeView): string | null {
  if (attributeCondition(attribute) !== null) return null;
  if (attribute.type === "bytes") return "bytes are stored, never indexed: not queryable";
  if (attribute.indexed === false) return "stored, not queryable";
  if (!isQueryableName(attribute.name)) return "the query language cannot name this attribute";
  return "not queryable";
}

// ---------------------------------------------------------------------------
// Schemas

/** The SDK's named-schema tag: an indexed str attribute, lifted out of the rows into a badge. */
export const SCHEMA_ATTRIBUTE_NAME = "arkiv.schema";

function isSchemaAttribute(attribute: AttributeView): boolean {
  return attribute.name === SCHEMA_ATTRIBUTE_NAME && attribute.type === "str" && attribute.indexed !== false &&
    typeof attribute.value === "string";
}

/** The schema an attribute set is tagged with (the indexed str `arkiv.schema`), else null. */
export function schemaNameOf(attributes: readonly AttributeView[]): string | null {
  const tag = attributes.find(isSchemaAttribute);
  return tag ? (tag.value as string) : null;
}

/** The attributes without the schema tag, which the header badge shows instead. */
export function withoutSchemaTag(attributes: readonly AttributeView[]): AttributeView[] {
  return attributes.filter((attribute) => !isSchemaAttribute(attribute));
}

export function schemaCondition(schemaName: string): string {
  return `${SCHEMA_ATTRIBUTE_NAME} = ${queryLiteral("str", schemaName)}`;
}

// ---------------------------------------------------------------------------
// Patches

export type AttributeChangeKind =
  /** The name was not set before (or the prior state is unknown). */
  | "set"
  /** Value, type or indexed flag differ from before. */
  | "changed"
  /** Written again exactly as it was. */
  | "unchanged"
  /** A tombstone removed it. */
  | "unset"
  /** A tombstone for a name that was not set. */
  | "unset-missing";

export interface AttributeChange {
  kind: AttributeChangeKind;
  name: string;
  /** The attribute before this mutation; null when it was absent or the prior state is unknown. */
  before: AttributeView | null;
  /** The attribute after it; null for an unset. */
  after: AttributeView | null;
  /** The type changed. */
  retyped: boolean;
  /** The indexed flag flipped: to `indexed` or to `stored`. */
  indexChange: "indexed" | "stored" | null;
  /** The prior state was not known (a truncated history): a `set` may really be a change. */
  priorUnknown: boolean;
}

export type AttributeState = Map<string, AttributeView>;

export function attributeState(attributes: readonly AttributeView[]): AttributeState {
  const state: AttributeState = new Map();
  for (const attribute of attributes) {
    if (attribute.type !== "tombstone" && !attribute.error) state.set(attribute.name, attribute);
  }
  return state;
}

/**
 * What a create's or patch's triples do, in calldata order, to an attribute
 * set (`prior` null when it is not known). A tombstone unsets; any other
 * triple sets the name, replacing its value, type and indexed flag together;
 * a malformed triple is shown but changes nothing. Returns the changes and the
 * set afterwards (null when the prior set was unknown).
 */
export function applyAttributeMutations(
  prior: AttributeState | null,
  mutations: readonly AttributeView[],
): { changes: AttributeChange[]; next: AttributeState | null } {
  const next: AttributeState | null = prior ? new Map(prior) : null;
  const changes: AttributeChange[] = [];
  for (const mutation of mutations) {
    const before = next?.get(mutation.name) ?? null;
    const priorUnknown = next === null;
    if (mutation.type === "tombstone") {
      changes.push({ kind: before || priorUnknown ? "unset" : "unset-missing", name: mutation.name, before, after: null, retyped: false, indexChange: null, priorUnknown });
      next?.delete(mutation.name);
      continue;
    }
    if (mutation.error) {
      changes.push({ kind: "unchanged", name: mutation.name, before, after: mutation, retyped: false, indexChange: null, priorUnknown });
      continue;
    }
    if (!before) {
      changes.push({ kind: "set", name: mutation.name, before: null, after: mutation, retyped: false, indexChange: null, priorUnknown });
    } else {
      const retyped = before.type !== mutation.type;
      const flagKnown = before.indexed !== null && mutation.indexed !== null;
      const indexChange = flagKnown && before.indexed !== mutation.indexed ? (mutation.indexed ? "indexed" : "stored") : null;
      const same = !retyped && indexChange === null && sameAttributeValue(before, mutation);
      changes.push({ kind: same ? "unchanged" : "changed", name: mutation.name, before, after: mutation, retyped, indexChange, priorUnknown });
    }
    next?.set(mutation.name, mutation);
  }
  return { changes, next };
}

/** A one-line count of what a patch did, e.g. "2 set, 1 changed (1 retyped), 1 unset". */
export function summarizeChanges(changes: readonly AttributeChange[]): string {
  const count = (kind: AttributeChangeKind) => changes.filter((change) => change.kind === kind).length;
  const retyped = changes.filter((change) => change.retyped).length;
  const flipped = changes.filter((change) => change.indexChange !== null).length;
  const parts: string[] = [];
  const set = count("set");
  const changed = count("changed");
  const unset = count("unset") + count("unset-missing");
  const unchanged = count("unchanged");
  if (set) parts.push(`${set} set`);
  if (changed) {
    const detail = [retyped ? `${retyped} retyped` : "", flipped ? `${flipped} re-indexed` : ""].filter(Boolean).join(", ");
    parts.push(`${changed} changed${detail ? ` (${detail})` : ""}`);
  }
  if (unset) parts.push(`${unset} unset`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  return parts.join(", ") || "no attribute changes";
}
