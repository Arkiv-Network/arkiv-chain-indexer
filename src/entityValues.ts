/**
 * The Arkiv attribute type vocabulary and the value encodings this repo needs
 * to answer entity queries from its own index.
 *
 * Three encodings of one value meet here:
 *
 * - the **decoder's text** (`transaction_operations.attributes[].value`, written
 *   by arkiv-transaction-decoder: decimal digits for the integer types, a
 *   trimmed decimal string for `dec`, EIP-55 hex for `addr`, lowercase hex for
 *   the 32-byte types, `true`/`false` for `bool`, raw text for `str`);
 * - the **stored form** in `entity_version_attributes` (`value_text` for
 *   equality/prefix, `value_num` for ordering — see {@link toStoredAttributeValue});
 * - the **wire form** a node puts in `arkiv_query` responses (`u64`/`u256` as
 *   `0x` quantities, `i32` as a JSON number, `bool` as a JSON bool, `dec` as a
 *   trimmed decimal string, `addr`/`key`/`bytes32` as lowercase hex) — see
 *   {@link wireAttributeValue}.
 *
 * The typeIds are the protocol's (`arkiv-interfaces` `AttributeType`): they are
 * written into entity records by the node, so they are consensus-fixed.
 */

/** The nine tags a query can spell, plus the system-only `bytes`. */
export type AttributeTypeTag =
  | "bool"
  | "i32"
  | "u64"
  | "u256"
  | "dec"
  | "bytes32"
  | "bytes"
  | "str"
  | "addr"
  | "key";

export const TYPE_IDS: Record<AttributeTypeTag, number> = {
  bool: 1,
  i32: 2,
  u64: 3,
  u256: 4,
  dec: 5,
  bytes32: 6,
  bytes: 7,
  str: 8,
  addr: 9,
  key: 10,
};

/** `typeId` 0 marks an attribute being unset in a patch; it is not a type. */
export const TOMBSTONE_TYPE_ID = 0;

export const TYPE_TAGS_BY_ID: ReadonlyMap<number, AttributeTypeTag> = new Map(
  (Object.entries(TYPE_IDS) as Array<[AttributeTypeTag, number]>).map(([tag, id]) => [id, tag]),
);

/** Decimal places a `dec` value is scaled by, fixed by the protocol. */
export const DECIMAL_SCALE = 18;
const DECIMAL_UNIT = 10n ** BigInt(DECIMAL_SCALE);

export const U64_MAX = (1n << 64n) - 1n;
export const U256_MAX = (1n << 256n) - 1n;
export const I256_MAX = (1n << 255n) - 1n;
export const I256_MIN = -(1n << 255n);
export const I32_MAX = 2_147_483_647;
export const I32_MIN = -2_147_483_648;

/** The types whose values are ordered, and so accept `< <= > >=`. */
export function isOrderedType(tag: AttributeTypeTag): boolean {
  return tag === "i32" || tag === "u64" || tag === "u256" || tag === "dec";
}

/**
 * A `dec` as its scaled integer units, rendered the way the node renders it:
 * a plain decimal string, no trailing fraction zeros, no `+`, `-` for negatives.
 */
export function formatDecimalUnits(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / DECIMAL_UNIT;
  const fraction = (magnitude % DECIMAL_UNIT).toString().padStart(DECIMAL_SCALE, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * The inverse of {@link formatDecimalUnits} for the decoder's rendering (an
 * optional sign, digits, an optional fraction of at most 18 digits). Returns
 * null for anything else rather than guessing.
 */
export function parseDecimalUnits(text: string): bigint | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ""] = match;
  const units = BigInt(whole!) * DECIMAL_UNIT + BigInt(fraction.padEnd(DECIMAL_SCALE, "0"));
  return sign === "-" ? -units : units;
}

/** JSON-RPC quantity encoding: `0x` + minimal hex digits. */
export function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** Whether `text` is `0x` followed by exactly `digits` hex digits (any case). */
export function isHexOfLength(text: string, digits: number): boolean {
  return new RegExp(`^0x[0-9a-fA-F]{${digits}}$`).test(text);
}

/**
 * An attribute value as the index stores it: `valueText` is what equality and
 * `STARTSWITH` compare, `valueNum` (the ordered types only) what ranges compare.
 */
export interface StoredAttributeValue {
  valueText: string;
  valueNum: bigint | null;
}

/**
 * Convert the decoder's text rendering of a value into the stored form. Returns
 * null when the text is not a value of that type — a legacy row, a corrupt
 * cell — so the caller can skip the attribute instead of storing a lie.
 */
export function toStoredAttributeValue(tag: AttributeTypeTag, text: string): StoredAttributeValue | null {
  switch (tag) {
    case "bool":
      return text === "true" || text === "false" ? { valueText: text, valueNum: null } : null;
    case "i32": {
      if (!/^-?\d+$/.test(text)) return null;
      const value = BigInt(text);
      if (value < BigInt(I32_MIN) || value > BigInt(I32_MAX)) return null;
      return { valueText: value.toString(), valueNum: value };
    }
    case "u64":
    case "u256": {
      if (!/^\d+$/.test(text)) return null;
      const value = BigInt(text);
      if (value > (tag === "u64" ? U64_MAX : U256_MAX)) return null;
      return { valueText: value.toString(), valueNum: value };
    }
    case "dec": {
      const units = parseDecimalUnits(text);
      if (units === null || units < I256_MIN || units > I256_MAX) return null;
      return { valueText: formatDecimalUnits(units), valueNum: units };
    }
    case "str":
      // Postgres text cannot hold NUL; the engine's str values are valid UTF-8
      // without control characters, so this only ever trims corrupt input.
      return { valueText: text.replaceAll("\0", ""), valueNum: null };
    case "addr":
      return isHexOfLength(text, 40) ? { valueText: text.toLowerCase(), valueNum: null } : null;
    case "key":
    case "bytes32":
      return isHexOfLength(text, 64) ? { valueText: text.toLowerCase(), valueNum: null } : null;
    case "bytes":
      // System-only (`$payload`); never a user attribute and never indexed.
      return null;
  }
}

/** A stored value in the JSON encoding the node uses on the wire. */
export function wireAttributeValue(tag: AttributeTypeTag, stored: StoredAttributeValue): unknown {
  switch (tag) {
    case "bool":
      return stored.valueText === "true";
    case "i32":
      return Number(stored.valueText);
    case "u64":
    case "u256":
      return hexQuantity(stored.valueNum ?? BigInt(stored.valueText));
    case "dec":
      return stored.valueNum === null ? stored.valueText : formatDecimalUnits(stored.valueNum);
    case "str":
    case "addr":
    case "key":
    case "bytes32":
    case "bytes":
      return stored.valueText;
  }
}

/** Byte-wise UTF-8 comparison, the order the engine keeps attributes in. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
