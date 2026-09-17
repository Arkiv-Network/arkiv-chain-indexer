/**
 * Test helpers for the offline genesis importer: build entity records the
 * way `arkiv-reth` encodes them (`0xFE || version || RLP(...)`, byte vectors
 * as lists of single-byte integers, alloy style) and whole `state.jsonl`
 * dumps with the system account's id slots.
 */

import { hexToBytes, keccak256, toHex, toRlp, type Hex } from "viem";
import { ENTITY_COUNT_SLOT, SYSTEM_ACCOUNT_ADDRESS, idToKeySlot, keyToIdSlot, type DumpSource } from "./entityGenesisDump";
import { TYPE_IDS, type AttributeTypeTag } from "./entityValues";

export interface DumpAttribute {
  name: string;
  type: AttributeTypeTag;
  /** The canonical storage bytes. */
  value: Uint8Array;
}

export interface DumpEntity {
  key: Hex;
  owner?: Hex;
  creator?: Hex;
  expiresAt?: bigint;
  contentType?: string;
  payload?: Uint8Array;
  attributes?: DumpAttribute[];
  creationFlags?: number;
  /** Record version: 1 (default) carries creation flags, 0 does not. */
  version?: 0 | 1;
  createdAtBlock?: bigint;
  lastModifiedAtBlock?: bigint;
  /** Encode byte vectors as RLP strings instead of alloy's lists. */
  byteStrings?: boolean;
}

export const DUMP_OWNER: Hex = "0x4691f23a5da293d31e93f129287402063e95ad21";
const NEVER = (1n << 64n) - 1n;

const utf8 = new TextEncoder();

/** Alloy encodes `Vec<u8>` as a list of `u8` integers: 0 is the empty string, the rest single bytes. */
function byteList(bytes: Uint8Array): Hex[] {
  return Array.from(bytes, (byte) => (byte === 0 ? "0x" : toHex(byte)));
}

function uint(value: bigint): Hex {
  return value === 0n ? "0x" : toHex(value);
}

export function encodeAttributeValue(tag: AttributeTypeTag, value: boolean | number | bigint | string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  switch (tag) {
    case "bool":
      return new Uint8Array([value ? 1 : 0]);
    case "i32": {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, Number(value));
      return out;
    }
    case "u64": {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigUint64(0, BigInt(value));
      return out;
    }
    case "u256":
    case "dec": {
      const signed = BigInt(value);
      return hexToBytes(toHex(signed < 0n ? (1n << 256n) + signed : signed, { size: 32 }));
    }
    case "str":
      return utf8.encode(String(value));
    case "addr":
    case "key":
    case "bytes32":
    case "bytes":
      return hexToBytes(value as Hex);
  }
}

export function buildEntityRecord(entity: DumpEntity): Uint8Array {
  const version = entity.version ?? 1;
  const vector = (bytes: Uint8Array): Hex | Hex[] => (entity.byteStrings ? toHex(bytes) : byteList(bytes));
  const fields: Array<Hex | Hex[] | Array<Array<Hex | Hex[]>>> = [
    vector(entity.payload ?? new Uint8Array(0)),
    entity.creator ?? entity.owner ?? DUMP_OWNER,
    uint(entity.createdAtBlock ?? 0n),
    entity.owner ?? DUMP_OWNER,
    uint(entity.expiresAt ?? NEVER),
    vector(utf8.encode(entity.contentType ?? "application/json")),
    entity.key,
    (entity.attributes ?? []).map((attribute) => [vector(utf8.encode(attribute.name)), uint(BigInt(TYPE_IDS[attribute.type])), vector(attribute.value)]),
    uint(entity.lastModifiedAtBlock ?? 0n),
  ];
  if (version === 1) fields.push(uint(BigInt(entity.creationFlags ?? 0)));
  const body = toRlp(fields as never, "bytes");
  const code = new Uint8Array(2 + body.length);
  code[0] = 0xfe;
  code[1] = version;
  code.set(body, 2);
  return code;
}

export interface DumpOptions {
  /** Storage pairs of the system account, in file order; defaults to the seeder's layout. */
  systemStorage?: Array<[Hex, Hex]>;
  /** Where the system account's line goes: after the records (default) or before them. */
  systemFirst?: boolean;
  /** The `arkiv.entity_count` value; defaults to the entity count. */
  entityCount?: number;
  omitSystem?: boolean;
  trailingNewline?: boolean;
  root?: Hex;
}

export const DUMP_ROOT: Hex = "0x1d97c1c7db8b54a02eece8de8ec381ae1276faa57972bb61260e6130c13dc01b";

/** The system account's storage the way the seeder writes it: per entity `key2id → id + 1`, `id2key → key`; then the count. */
export function seederSystemStorage(keys: readonly Hex[], entityCount = keys.length): Array<[Hex, Hex]> {
  const pairs: Array<[Hex, Hex]> = [];
  keys.forEach((key, id) => {
    pairs.push([keyToIdSlot(hexToBytes(key)), toHex(BigInt(id + 1), { size: 32 })]);
    pairs.push([idToKeySlot(id), key]);
  });
  pairs.push([ENTITY_COUNT_SLOT, toHex(BigInt(entityCount), { size: 32 })]);
  return pairs;
}

/** A dump text: the root line, a `$key` bucket before every record (as the seeder interleaves them), the system account, funded accounts. */
export function buildDump(entities: readonly DumpEntity[], options: DumpOptions = {}): string {
  const lines: string[] = [JSON.stringify({ root: options.root ?? DUMP_ROOT })];
  const systemLine = JSON.stringify({
    address: SYSTEM_ACCOUNT_ADDRESS,
    nonce: "0x1",
    balance: "0x0",
    storage: Object.fromEntries(options.systemStorage ?? seederSystemStorage(entities.map((entity) => entity.key), options.entityCount)),
  });
  if (options.systemFirst && !options.omitSystem) lines.push(systemLine);
  entities.forEach((entity, index) => {
    const bucket = keccak256(toHex(index)).slice(0, 42);
    lines.push(JSON.stringify({ address: bucket, nonce: "0x1", balance: "0x0", code: "0x0100000000000000000000003a30000001", storage: { [toHex(1n, { size: 32 })]: toHex(BigInt(index + 1), { size: 32 }) } }));
    lines.push(JSON.stringify({ address: entity.key.slice(0, 42), nonce: "0x1", balance: "0x0", code: toHex(buildEntityRecord(entity)) }));
  });
  if (!options.systemFirst && !options.omitSystem) lines.push(systemLine);
  lines.push(JSON.stringify({ address: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", balance: "0x21e19e0c9bab2400000" }));
  return lines.join("\n") + (options.trailingNewline === false ? "" : "\n");
}

/** A dump served from memory in chunks of `chunkSize` bytes, to exercise line and pair splitting. */
export function memoryDumpSource(text: string, chunkSize = 7): DumpSource {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.length,
    stream(offset) {
      let position = offset;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position >= bytes.length) {
            controller.close();
            return;
          }
          const next = Math.min(bytes.length, position + chunkSize);
          controller.enqueue(bytes.subarray(position, next));
          position = next;
        },
      });
    },
  };
}

/** A key from a small number, zero-padded to 32 bytes. */
export function dumpKey(n: number): Hex {
  return toHex(BigInt(n), { size: 32 });
}
