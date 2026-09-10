/**
 * Reading a genesis-seeded chain's `state.jsonl` dump — the file
 * `arkiv-cli seed-genesis` writes and `arkiv-reth init-state` imports — for
 * the offline genesis importer (`scripts/importGenesisState.ts`).
 *
 * The dump is one JSON account per line after a `{"root": …}` first line. An
 * entity is an account whose `code` is `0xFE || version || RLP(record)`
 * (`arkiv-reth-mpt-committed-store/src/entities/record.rs`): v1 fields are
 * payload, creator, created_at_block, owner, expires_at, content_type, key,
 * attributes ([name, type id, value] each), last_modified_at_block,
 * creation_flags; v0 lacks the last one. `Vec<u8>` fields are RLP *lists* of
 * single-byte items (alloy-rlp does not special-case byte vectors), fixed
 * arrays and integers are RLP strings; the decoder accepts both forms for the
 * byte vectors. Attribute value bytes are the node's canonical storage bytes
 * (`arkiv-interfaces/src/entity.rs`: bool 1 byte, i32 4 bytes, u64 8 bytes,
 * u256/dec/bytes32/key 32 bytes, addr 20 bytes, str UTF-8).
 *
 * Entity ids — what the node orders results and cursors by — never appear in
 * a record. The seeder allocates them in the order it writes the records, and
 * the system account (`0x44…46`) stores, in insertion order,
 * `keccak256("arkiv.key2id" || key) → id + 1` and
 * `keccak256("arkiv.id2key" || id_be64) → key` for every id, then
 * `keccak256("arkiv.entity_count")`. The reader therefore assigns each record
 * its ordinal as the id and proves the assignment with two hash chains: one
 * over the record keys in file order, one over the `id2key` values in id
 * order. They match only when the records really are in id order.
 *
 * The system account's line grows with the seed (about 300 bytes per entity:
 * 30 GB at 100 million), so that line is never materialised — its storage
 * pairs are tokenised out of the byte stream as it arrives.
 */

import { bytesToHex, concat, hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { GenesisEntityError, genesisEntityToVersion } from "./entityGenesis";
import type { EntityVersion } from "./entityIndex";
import { formatDecimalUnits, hexQuantity, TYPE_TAGS_BY_ID, type AttributeTypeTag } from "./entityValues";

/** The shared bookkeeping account (`SYSTEM_ACCOUNT_ADDRESS` in the node). */
export const SYSTEM_ACCOUNT_ADDRESS = "0x4400000000000000000000000000000000000046";
/** The EVM `INVALID` opcode: what every entity account's code starts with. */
export const ENTITY_CODE_MARKER = 0xfe;

const RECORD_VERSION_V0 = 0x00;
const RECORD_VERSION_V1 = 0x01;
const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

// ---------------------------------------------------------------------------
// Storage slots

export const ENTITY_COUNT_SLOT: Hex = keccak256(stringToBytes("arkiv.entity_count"));

export function keyToIdSlot(key: Uint8Array): Hex {
  return keccak256(concat([stringToBytes("arkiv.key2id"), key]));
}

export function idToKeySlot(id: number | bigint): Hex {
  const be = new Uint8Array(8);
  new DataView(be.buffer).setBigUint64(0, BigInt(id));
  return keccak256(concat([stringToBytes("arkiv.id2key"), be]));
}

// ---------------------------------------------------------------------------
// RLP

interface RlpItem {
  list: boolean;
  /** Payload bounds within the buffer. */
  start: number;
  end: number;
  /** Offset of the next item. */
  next: number;
}

function readItem(bytes: Uint8Array, offset: number, refuse: (message: string) => Error): RlpItem {
  if (offset >= bytes.length) throw refuse("truncated RLP");
  const first = bytes[offset]!;
  const bounded = (list: boolean, start: number, length: number): RlpItem => {
    if (start + length > bytes.length) throw refuse("truncated RLP");
    return { list, start, end: start + length, next: start + length };
  };
  if (first < 0x80) return { list: false, start: offset, end: offset + 1, next: offset + 1 };
  if (first <= 0xb7) return bounded(false, offset + 1, first - 0x80);
  if (first <= 0xbf) {
    const lengthBytes = first - 0xb7;
    return bounded(false, offset + 1 + lengthBytes, readLength(bytes, offset + 1, lengthBytes, refuse));
  }
  if (first <= 0xf7) return bounded(true, offset + 1, first - 0xc0);
  const lengthBytes = first - 0xf7;
  return bounded(true, offset + 1 + lengthBytes, readLength(bytes, offset + 1, lengthBytes, refuse));
}

function readLength(bytes: Uint8Array, offset: number, count: number, refuse: (message: string) => Error): number {
  if (count > 6 || offset + count > bytes.length) throw refuse("RLP length is out of range");
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + bytes[offset + i]!;
  return length;
}

function listItems(bytes: Uint8Array, item: RlpItem, refuse: (message: string) => Error): RlpItem[] {
  if (!item.list) throw refuse("expected an RLP list");
  const items: RlpItem[] = [];
  let offset = item.start;
  while (offset < item.end) {
    const next = readItem(bytes, offset, refuse);
    if (next.next > item.end) throw refuse("RLP list item overruns its list");
    items.push(next);
    offset = next.next;
  }
  return items;
}

/** A `Vec<u8>`: an RLP string, or (alloy's encoding) a list of single-byte integers. */
function byteVector(bytes: Uint8Array, item: RlpItem, refuse: (message: string) => Error): Uint8Array {
  if (!item.list) return bytes.subarray(item.start, item.end);
  const out = new Uint8Array(byteVectorLength(bytes, item, refuse));
  let offset = item.start;
  let i = 0;
  while (offset < item.end) {
    const first = bytes[offset]!;
    if (first < 0x80) {
      out[i++] = first;
      offset += 1;
    } else if (first === 0x80) {
      out[i++] = 0; // the integer 0 is the empty string
      offset += 1;
    } else if (first === 0x81 && offset + 1 < item.end) {
      out[i++] = bytes[offset + 1]!;
      offset += 2;
    } else {
      throw refuse("byte vector item is not a single byte");
    }
  }
  return out;
}

/** The length of a byte vector without materialising it (the payload is only ever measured). */
function byteVectorLength(bytes: Uint8Array, item: RlpItem, refuse: (message: string) => Error): number {
  if (!item.list) return item.end - item.start;
  let count = 0;
  let offset = item.start;
  while (offset < item.end) {
    const first = bytes[offset]!;
    if (first <= 0x80) offset += 1;
    else if (first === 0x81) offset += 2;
    else throw refuse("byte vector item is not a single byte");
    count += 1;
  }
  if (offset !== item.end) throw refuse("byte vector item overruns its list");
  return count;
}

function fixedBytes(bytes: Uint8Array, item: RlpItem, length: number, what: string, refuse: (message: string) => Error): Uint8Array {
  if (item.list || item.end - item.start !== length) throw refuse(`${what} is not ${length} bytes`);
  return bytes.subarray(item.start, item.end);
}

function unsignedField(bytes: Uint8Array, item: RlpItem, maxBytes: number, what: string, refuse: (message: string) => Error): bigint {
  if (item.list || item.end - item.start > maxBytes) throw refuse(`${what} is not a ${maxBytes * 8}-bit integer`);
  if (item.end - item.start > 0 && bytes[item.start] === 0) throw refuse(`${what} has a leading zero`);
  let value = 0n;
  for (let i = item.start; i < item.end; i++) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

function bigintFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function utf8Field(bytes: Uint8Array, what: string, refuse: (message: string) => Error): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw refuse(`${what} is not valid UTF-8`);
  }
}

/** An attribute's storage bytes rendered the way the node puts the value on the wire. */
function wireValue(tag: AttributeTypeTag, value: Uint8Array, name: string, refuse: (message: string) => Error): unknown {
  const fixed = (length: number): Uint8Array => {
    if (value.length !== length) throw refuse(`attribute ${name}: a ${tag} value is ${length} bytes, got ${value.length}`);
    return value;
  };
  switch (tag) {
    case "bool": {
      const byte = fixed(1)[0];
      if (byte !== 0 && byte !== 1) throw refuse(`attribute ${name}: bool byte ${byte}`);
      return byte === 1;
    }
    case "i32":
      return new DataView(fixed(4).buffer, value.byteOffset, 4).getInt32(0);
    case "u64":
      return hexQuantity(bigintFromBytes(fixed(8)));
    case "u256":
      return hexQuantity(bigintFromBytes(fixed(32)));
    case "dec": {
      const unsigned = bigintFromBytes(fixed(32));
      return formatDecimalUnits(unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned);
    }
    case "bytes32":
    case "key":
      return bytesToHex(fixed(32));
    case "addr":
      return bytesToHex(fixed(20));
    case "str":
      return utf8Field(value, `attribute ${name}`, refuse);
    case "bytes":
      throw refuse(`attribute ${name}: bytes attributes are system-only`);
  }
}

/** Whether `code` (hex or bytes) starts with the entity marker and a known record version. */
export function isEntityRecordCode(code: string | Uint8Array): boolean {
  if (typeof code === "string") return /^0xfe0[01]/i.test(code);
  return code.length >= 2 && code[0] === ENTITY_CODE_MARKER && (code[1] === RECORD_VERSION_V0 || code[1] === RECORD_VERSION_V1);
}

/**
 * Decode one entity account's code into the index's genesis version at
 * `position` (the entity id). The payload is measured and dropped; the record
 * is refused — never guessed at — when it is not a block-0 entity or any
 * field is malformed.
 */
export function decodeEntityRecord(code: Uint8Array, position: number): EntityVersion {
  let key: string | undefined;
  const refuse = (message: string): Error => new GenesisEntityError(key, message);
  if (code.length < 3 || code[0] !== ENTITY_CODE_MARKER) throw refuse("code does not start with the 0xFE entity marker");
  const version = code[1]!;
  if (version !== RECORD_VERSION_V0 && version !== RECORD_VERSION_V1) throw refuse(`unknown entity record version ${version}`);
  const body = readItem(code, 2, refuse);
  if (!body.list) throw refuse("record body is not an RLP list");
  if (body.next !== code.length) throw refuse("trailing bytes after the record body");
  const fields = listItems(code, body, refuse);
  const expectedFields = version === RECORD_VERSION_V0 ? 9 : 10;
  if (fields.length !== expectedFields) throw refuse(`record v${version} has ${fields.length} fields, expected ${expectedFields}`);
  key = bytesToHex(fixedBytes(code, fields[6]!, 32, "key", refuse));
  const payloadSize = byteVectorLength(code, fields[0]!, refuse);
  const creator = bytesToHex(fixedBytes(code, fields[1]!, 20, "creator", refuse));
  const createdAtBlock = unsignedField(code, fields[2]!, 8, "created_at_block", refuse);
  const owner = bytesToHex(fixedBytes(code, fields[3]!, 20, "owner", refuse));
  const expiresAt = unsignedField(code, fields[4]!, 8, "expires_at", refuse);
  const contentType = utf8Field(byteVector(code, fields[5]!, refuse), "content_type", refuse);
  const lastModifiedAtBlock = unsignedField(code, fields[8]!, 8, "last_modified_at_block", refuse);
  const creationFlags = version === RECORD_VERSION_V1 ? Number(unsignedField(code, fields[9]!, 1, "creation_flags", refuse)) : 0;
  if (createdAtBlock !== 0n) throw refuse(`created_at_block is ${createdAtBlock}; not a genesis record`);
  if (lastModifiedAtBlock !== 0n) throw refuse(`last_modified_at_block is ${lastModifiedAtBlock}; not a genesis record`);
  const attributes = listItems(code, fields[7]!, refuse).map((cell) => {
    const parts = listItems(code, cell, refuse);
    if (parts.length !== 3) throw refuse(`attribute has ${parts.length} parts, expected 3`);
    const name = utf8Field(byteVector(code, parts[0]!, refuse), "attribute name", refuse);
    const typeId = Number(unsignedField(code, parts[1]!, 1, `attribute ${name} type id`, refuse));
    const tag = TYPE_TAGS_BY_ID.get(typeId);
    if (!tag) throw refuse(`attribute ${name}: unknown type id ${typeId}`);
    return { name, type: tag, value: wireValue(tag, byteVector(code, parts[2]!, refuse), name, refuse) };
  });
  const wire = {
    key,
    owner,
    creator,
    createdAt: "0x0",
    updatedAt: "0x0",
    expiresAt: hexQuantity(expiresAt),
    creationFlags: { raw: creationFlags },
    contentType,
    attributes,
  };
  return { ...genesisEntityToVersion(wire, position), payloadSize };
}

// ---------------------------------------------------------------------------
// The id ledger

export interface GenesisLedgerState {
  /** Entity records seen, in file order. */
  records: number;
  /** keccak chain over the record keys. */
  recordChain: Hex;
  /** Whether the system account's line has been consumed. */
  systemSeen: boolean;
  /** `id2key` slots matched in id order. */
  ids: number;
  /** keccak chain over the `id2key` values. */
  idChain: Hex;
  /** The `arkiv.entity_count` slot's value (decimal), once seen. */
  entityCount: string | null;
}

/**
 * Proves that the records' file order is the node's id order, without holding
 * any key in memory: the chain over the keys as the records come must equal
 * the chain over the `id2key` values as the system account lists them for ids
 * 0, 1, 2, … The expected next `id2key` slot is one keccak per id.
 */
export class GenesisIdLedger {
  private records: number;
  private recordChain: Hex;
  private systemSeen: boolean;
  private ids: number;
  private idChain: Hex;
  private entityCount: string | null;
  private expectedSlot: Hex | null = null;

  constructor(state?: GenesisLedgerState) {
    this.records = state?.records ?? 0;
    this.recordChain = state?.recordChain ?? ZERO_HASH;
    this.systemSeen = state?.systemSeen ?? false;
    this.ids = state?.ids ?? 0;
    this.idChain = state?.idChain ?? ZERO_HASH;
    this.entityCount = state?.entityCount ?? null;
  }

  /** Book a record's key; returns the ordinal (entity id) it was given. */
  addRecord(key: string): number {
    this.recordChain = keccak256(concat([hexToBytes(this.recordChain), hexToBytes(key as Hex)]));
    return this.records++;
  }

  /** Book one of the system account's storage pairs, in file order. */
  addSlot(slot: string, value: string): void {
    const lower = slot.toLowerCase() as Hex;
    if (lower === ENTITY_COUNT_SLOT) {
      this.entityCount = BigInt(value).toString();
      return;
    }
    if (this.expectedSlot === null) this.expectedSlot = idToKeySlot(this.ids);
    if (lower !== this.expectedSlot) return; // a key2id pair, a nonce, or an id out of order (caught by the chains)
    const word = hexToBytes(`0x${value.slice(2).padStart(64, "0")}` as Hex);
    this.idChain = keccak256(concat([hexToBytes(this.idChain), word]));
    this.ids += 1;
    this.expectedSlot = null;
  }

  markSystemSeen(): void {
    this.systemSeen = true;
  }

  state(): GenesisLedgerState {
    return {
      records: this.records,
      recordChain: this.recordChain,
      systemSeen: this.systemSeen,
      ids: this.ids,
      idChain: this.idChain,
      entityCount: this.entityCount,
    };
  }

  /** Throws a {@link GenesisEntityError} naming the first thing that does not add up. */
  verify(total: number): void {
    const refuse = (message: string): never => {
      throw new GenesisEntityError(undefined, message);
    };
    if (this.records !== total) refuse(`the dump holds ${this.records} entity records but the manifest counts ${total}`);
    if (!this.systemSeen) refuse(`the system account ${SYSTEM_ACCOUNT_ADDRESS} never appeared in the dump`);
    if (this.entityCount === null) refuse("the system account has no arkiv.entity_count slot");
    if (this.entityCount !== String(total)) refuse(`the system account counts ${this.entityCount} entities, the manifest ${total}`);
    if (this.ids !== this.records) {
      refuse(
        `matched ${this.ids} id2key slots in id order for ${this.records} records; ` +
          "the system account's storage is not in insertion order or ids are missing",
      );
    }
    if (this.recordChain !== this.idChain) refuse("the entity records are not in entity-id order (key chain differs from the id2key chain)");
  }
}

// ---------------------------------------------------------------------------
// Reading the dump

export interface DumpSource {
  /** Total size in bytes. */
  size: number;
  /** The bytes from `offset` to the end. */
  stream(offset: number): ReadableStream<Uint8Array>;
}

export function fileDumpSource(path: string): DumpSource {
  const file = Bun.file(path);
  return {
    size: file.size,
    stream: (offset) => (offset === 0 ? file : file.slice(offset)).stream(),
  };
}

/** The state root from the dump's first line, read before anything else happens. */
export async function readDumpRoot(source: DumpSource): Promise<string> {
  for await (const event of readGenesisDump(source, 0, 1)) {
    if (event.type === "root") return event.root;
    break;
  }
  throw new GenesisEntityError(undefined, "the dump does not start with a {\"root\": …} line");
}

export type DumpEvent =
  | { type: "root"; root: string; line: number; end: number }
  | { type: "record"; line: number; end: number; address: string; code: Uint8Array }
  | { type: "slot"; slot: string; value: string }
  | { type: "system"; line: number; end: number; slots: number }
  | { type: "other"; line: number; end: number };

const SYSTEM_LINE_PREFIX = new TextEncoder().encode(`{"address":"${SYSTEM_ACCOUNT_ADDRESS}"`);
const RECORD_MARKER = Buffer.from('"code":"0xfe');
const ROOT_PREFIX = Buffer.from('{"root"');
const NEWLINE = 0x0a;
const STORAGE_PAIR = /"(0x[0-9a-fA-F]{64})":"(0x[0-9a-fA-F]{1,64})"/g;
const TOKENIZER_TAIL = 256;

/** Pulls `"slot":"value"` pairs out of the system account's line as its bytes arrive. */
class SystemStorageTokenizer {
  private readonly decoder = new TextDecoder();
  private text = "";
  count = 0;

  feed(bytes: Uint8Array, last: boolean): Array<[string, string]> {
    this.text += this.decoder.decode(bytes, { stream: !last });
    const pairs: Array<[string, string]> = [];
    STORAGE_PAIR.lastIndex = 0;
    let consumed = 0;
    for (let match = STORAGE_PAIR.exec(this.text); match; match = STORAGE_PAIR.exec(this.text)) {
      pairs.push([match[1]!, match[2]!]);
      consumed = STORAGE_PAIR.lastIndex;
    }
    // Keep the unmatched tail — a pair may be split across chunks — but never
    // more than one pair's worth of unmatched text.
    this.text = this.text.slice(Math.max(consumed, this.text.length - TOKENIZER_TAIL));
    this.count += pairs.length;
    return pairs;
  }
}

/**
 * Walk the dump from `startOffset` (a line boundary; 0 for the whole file),
 * yielding one event per line — the root, an entity record, the system
 * account (after its `slot` events), or `other` — each with the offset the
 * next line starts at, so a consumer can resume there.
 */
export async function* readGenesisDump(source: DumpSource, startOffset = 0, startLine = 1): AsyncGenerator<DumpEvent> {
  const reader = source.stream(startOffset).getReader();
  let lineStart = startOffset;
  let line = startLine;
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let tokenizer: SystemStorageTokenizer | null = null;
  let checkedPrefix = false;

  const startsWithSystemPrefix = (): boolean => {
    let i = 0;
    for (const part of pending) {
      for (let j = 0; j < part.length && i < SYSTEM_LINE_PREFIX.length; j++, i++) {
        if (part[j] !== SYSTEM_LINE_PREFIX[i]) return false;
      }
      if (i >= SYSTEM_LINE_PREFIX.length) return true;
    }
    return false;
  };
  const takePending = (): Uint8Array => {
    const out = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
    pending.length = 0;
    pendingBytes = 0;
    return out;
  };
  const finishLine = function* (lineEnd: number): Generator<DumpEvent> {
    const end = lineEnd;
    if (tokenizer) {
      for (const [slot, value] of tokenizer.feed(new Uint8Array(0), true)) yield { type: "slot", slot, value };
      yield { type: "system", line, end, slots: tokenizer.count };
      tokenizer = null;
    } else {
      const bytes = takePending();
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (lineStart === 0) {
        if (!buffer.subarray(0, ROOT_PREFIX.length).equals(ROOT_PREFIX)) {
          throw new GenesisEntityError(undefined, "the dump does not start with a {\"root\": …} line");
        }
        const parsed = JSON.parse(buffer.toString("utf8")) as { root?: unknown };
        if (typeof parsed.root !== "string") throw new GenesisEntityError(undefined, "the dump's root line has no root");
        yield { type: "root", root: parsed.root, line, end };
      } else if (buffer.indexOf(RECORD_MARKER) !== -1) {
        const parsed = JSON.parse(buffer.toString("utf8")) as { address?: unknown; code?: unknown };
        // Only a known record version is an entity: plain bytecode may start
        // with 0xFE (INVALID) too, and must not abort the import.
        if (typeof parsed.code === "string" && typeof parsed.address === "string" && isEntityRecordCode(parsed.code)) {
          yield { type: "record", line, end, address: parsed.address, code: new Uint8Array(Buffer.from(parsed.code.slice(2), "hex")) };
        } else {
          yield { type: "other", line, end };
        }
      } else {
        yield { type: "other", line, end };
      }
    }
    lineStart = end;
    line += 1;
    checkedPrefix = false;
  };
  const consume = function* (segment: Uint8Array): Generator<DumpEvent> {
    if (segment.length === 0) return;
    if (tokenizer) {
      for (const [slot, value] of tokenizer.feed(segment, false)) yield { type: "slot", slot, value };
      return;
    }
    pending.push(segment);
    pendingBytes += segment.length;
    if (!checkedPrefix && pendingBytes >= SYSTEM_LINE_PREFIX.length) {
      checkedPrefix = true;
      if (startsWithSystemPrefix()) {
        tokenizer = new SystemStorageTokenizer();
        for (const [slot, value] of tokenizer.feed(takePending(), false)) yield { type: "slot", slot, value };
      }
    }
  };

  let offset = startOffset; // bytes consumed from the stream
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      let from = 0;
      while (from < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, from);
        if (newline === -1) {
          yield* consume(chunk.subarray(from));
          offset += chunk.length - from;
          break;
        }
        yield* consume(chunk.subarray(from, newline));
        offset += newline - from + 1;
        yield* finishLine(offset);
        from = newline + 1;
      }
    }
    if (tokenizer || pendingBytes > 0) yield* finishLine(offset); // a last line without a newline
  } finally {
    reader.releaseLock();
  }
}
