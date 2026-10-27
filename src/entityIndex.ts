/**
 * Folding decoded Arkiv operations into entity state — the pure half of the
 * experimental entity index behind `POST /shadow-rpc/experimental`.
 *
 * The scanner stores what each registry transaction *asked for* (one
 * `transaction_operations` row per operation: attribute triples, the expiry
 * pair, the new owner) and what the engine *announced* (the `EntityCreated`,
 * `ExpiryExtended`, … receipt logs). A node keeps the resulting entity state;
 * the index does not, so this module replays an entity's operations, in chain
 * order, into the sequence of states it went through — one
 * {@link EntityVersion} per applied operation, each valid from its own block
 * until the next one's.
 *
 * The rules are the UDC engine's (arkiv-state-db-experiment, entity rules
 * `arkiv-entity-v3`):
 *
 * - **create** sets creator = owner = sender, `createdAt` = `updatedAt` =
 *   block, the expiry, the creation flags and the attributes (kept sorted by
 *   name bytes);
 * - **patch** applies its mutations in calldata order: an entry with a type
 *   sets that attribute — adding it, or replacing its value, its type *and*
 *   its indexed flag with the new triple's (a patch can index or unindex) —
 *   and a tombstone (`typeId` 0) unsets it; attributes it does not name stay;
 * - **extend** replaces the expiry (the engine has already refused shortening);
 * - **transfer** replaces the owner;
 * - **delete** ends the entity;
 * - every mutation sets `updatedAt` to its block, an equal-expiry extend
 *   included.
 *
 * Every attribute is kept, indexed or not — the node returns both — and the
 * flag rides along, because only indexed attributes match a query. A `bytes`
 * attribute is kept as its keccak256 and size: its content is never stored.
 *
 * Only *applied* operations are replayed — the caller filters out reverted
 * transactions — so this never re-checks authorization, liveness or flags: the
 * chain already did, and an operation that made it into a successful
 * transaction took effect.
 *
 * Expiry: the event's value where the receipt log was stored, otherwise the
 * engine's `max(expiresAt, block + minLifetime)` on the exact calldata pair
 * (capped at 2^64 − 1, the permanent expiry) — see {@link resolveRequestedExpiry}.
 */
import { SCHEMA_ATTRIBUTE_NAME, type ArkivOperationAttribute } from "./arkivOperations";
import {
  INDEXED_FLAG,
  TOMBSTONE_TYPE_ID,
  TYPE_IDS,
  U64_MAX,
  compareUtf8,
  fromWireAttributeValue,
  storedBytesValue,
  typeTagOfRawId,
  type StoredAttributeValue,
} from "./entityValues";

export const OPERATION_CREATE = 1;
export const OPERATION_PATCH = 2;
export const OPERATION_EXTEND = 3;
export const OPERATION_TRANSFER = 4;
export const OPERATION_DELETE = 5;

/** What the engine announced for an operation, read from the receipt logs. */
export interface EntityOpEvent {
  /** `EntityCreated.expiresAt` / `ExpiryExtended.expiresAt`: the resolved absolute expiry block. */
  expiresAt?: bigint;
  /** `EntityCreated.creationFlags`. */
  creationFlags?: number;
  /** `OwnershipTransferred.newOwner`, lowercase. */
  newOwner?: string;
}

/** One applied operation on one entity, joined with its transaction. */
export interface EntityOpRecord {
  blockNumber: number;
  position: number;
  opIndex: number;
  operationType: number;
  /** Lowercase `0x` + 64 hex. */
  entityKey: string;
  /** The transaction sender, lowercase. */
  sender: string;
  /** create: the raw flag byte from calldata, used when no `EntityCreated` log was stored. */
  creationFlags: number | null;
  attributes: ArkivOperationAttribute[];
  /** create/extend: the requested absolute deadline; null for other operations. */
  expiresAt: bigint | null;
  /** create/extend: the requested lifetime floor in blocks from the landing block. */
  minLifetime: bigint | null;
  newOwner: string | null;
  /** Set when the transaction's receipt logs were stored and matched this operation. */
  event?: EntityOpEvent;
}

/**
 * One attribute of one version. `typeId` is the type alone (1–10, flag
 * stripped); `indexed` is the flag. A `bytes` attribute (typeId 7, never
 * indexed) stores its keccak256 as `valueText` and its length as `valueNum`.
 */
export interface StoredEntityAttribute extends StoredAttributeValue {
  name: string;
  typeId: number;
  indexed: boolean;
}

/** One state an entity was in, valid for blocks `[fromBlock, toBlock)`. */
export interface EntityVersion {
  entityKey: string;
  /** 0 for the create, then one more per applied operation. */
  version: number;
  fromBlock: number;
  fromPosition: number;
  fromOpIndex: number;
  /** Block of the next version's operation; null while this is the latest. */
  toBlock: number | null;
  /** True for the version a delete produces: the entity is gone from `fromBlock` on. */
  deleted: boolean;
  owner: string;
  creator: string;
  createdAt: number;
  createdPosition: number;
  createdOpIndex: number;
  updatedAt: number;
  expiresAt: bigint;
  /** Null when neither the receipt log nor the operation row carried the flags. */
  creationFlags: number | null;
  /** Bytes held by the version's `bytes` attributes together. */
  bytesSize: number;
  /** The value of the indexed str `arkiv.schema` (the SDK's named-schema tag), or null. */
  schemaName: string | null;
  /** Sorted by name bytes, the engine's canonical order; indexed and stored-only alike. */
  attributes: StoredEntityAttribute[];
}

/** `expiresAt` of an entity that never expires. */
export const PERMANENT_EXPIRY = U64_MAX;

/**
 * The engine's `max(expiresAt, block + minLifetime)`, exactly, capped at
 * 2^64 − 1 (the permanent expiry, which a huge lifetime reaches too).
 */
export function resolveRequestedExpiry(blockNumber: number, expiresAt: bigint, minLifetime: bigint): bigint {
  const floor = BigInt(blockNumber) + minLifetime;
  const resolved = expiresAt > floor ? expiresAt : floor;
  return resolved > U64_MAX ? U64_MAX : resolved;
}

/** The receipt event's expiry when it was stored, else the calldata pair resolved at the operation's block. */
function resolveExpiry(op: EntityOpRecord): bigint {
  return op.event?.expiresAt ?? resolveRequestedExpiry(op.blockNumber, op.expiresAt ?? 0n, op.minLifetime ?? 0n);
}

function compareOps(a: EntityOpRecord, b: EntityOpRecord): number {
  return a.blockNumber - b.blockNumber || a.position - b.position || a.opIndex - b.opIndex;
}

function sortedAttributes(byName: Map<string, StoredEntityAttribute>): StoredEntityAttribute[] {
  return [...byName.values()].sort((a, b) => compareUtf8(a.name, b.name));
}

/** The derived columns of an attribute set: bytes held and the schema tag. */
export function summarizeAttributes(attributes: readonly StoredEntityAttribute[]): { bytesSize: number; schemaName: string | null } {
  let bytesSize = 0;
  let schemaName: string | null = null;
  for (const attribute of attributes) {
    if (attribute.typeId === TYPE_IDS.bytes) bytesSize += Number(attribute.valueNum ?? 0n);
    if (attribute.name === SCHEMA_ATTRIBUTE_NAME && attribute.typeId === TYPE_IDS.str && attribute.indexed) {
      schemaName = attribute.valueText;
    }
  }
  return { bytesSize, schemaName };
}

/**
 * One decoded triple as a stored attribute, or undefined when it cannot be
 * one: a tombstone, a malformed triple (the node refuses those before a
 * transaction is mined, so a chain transaction never has one) or a value that
 * is not of its type.
 */
export function storedAttributeOf(cell: ArkivOperationAttribute): StoredEntityAttribute | undefined {
  if (cell.error !== undefined || cell.typeId === TOMBSTONE_TYPE_ID) return undefined;
  const tag = typeTagOfRawId(cell.typeId);
  if (!tag) return undefined;
  const indexed = (cell.typeId & INDEXED_FLAG) !== 0;
  if (tag === "bytes") {
    if (indexed || cell.keccak256 === undefined) return undefined;
    const stored = storedBytesValue(cell.keccak256, cell.size);
    return stored ? { name: cell.name, typeId: TYPE_IDS.bytes, indexed: false, ...stored } : undefined;
  }
  const stored = fromWireAttributeValue(tag, cell.value);
  return stored ? { name: cell.name, typeId: TYPE_IDS[tag], indexed, ...stored } : undefined;
}

/**
 * Apply a create's or patch's triples, in order, to the working set: a
 * tombstone unsets; a typed triple sets, replacing value, type and indexed
 * flag; a triple that cannot be stored is skipped rather than stored as
 * something it is not.
 */
function applyAttributes(byName: Map<string, StoredEntityAttribute>, cells: ArkivOperationAttribute[]): void {
  for (const cell of cells) {
    if (cell.error !== undefined) continue;
    if (cell.typeId === TOMBSTONE_TYPE_ID) {
      byName.delete(cell.name);
      continue;
    }
    const stored = storedAttributeOf(cell);
    if (stored) byName.set(cell.name, stored);
  }
}

function withAttributes(version: Omit<EntityVersion, "attributes" | "bytesSize" | "schemaName">, attributes: StoredEntityAttribute[]): EntityVersion {
  return { ...version, ...summarizeAttributes(attributes), attributes };
}

/**
 * Replay one entity's applied operations into its versions. Operations may be
 * given in any order; anything before the create, or after a delete, cannot
 * have been applied by the engine and is ignored.
 *
 * An entity the chain was born with (a seeded genesis, see `entityGenesis.ts`)
 * has no create operation: its state at block 0 is given as `base`, becomes
 * version 0, and the operations replay on top of it. A create for a key that
 * already has a base is ignored like any create on an existing entity — the
 * engine would have refused it.
 */
export function foldEntityVersions(
  entityKey: string,
  records: readonly EntityOpRecord[],
  base?: EntityVersion,
): EntityVersion[] {
  const ops = [...records].sort(compareOps);
  const versions: EntityVersion[] = [];
  let current: EntityVersion | undefined;
  const attributes = new Map<string, StoredEntityAttribute>();

  const push = (next: EntityVersion) => {
    if (current) current.toBlock = next.fromBlock;
    versions.push(next);
    current = next;
  };

  if (base) {
    for (const attribute of base.attributes) attributes.set(attribute.name, { ...attribute });
    push(withAttributes({ ...base, toBlock: null, deleted: false }, sortedAttributes(attributes)));
  }

  for (const op of ops) {
    if (!current) {
      if (op.operationType !== OPERATION_CREATE) continue;
      attributes.clear();
      applyAttributes(attributes, op.attributes);
      push(
        withAttributes(
          {
            entityKey,
            version: 0,
            fromBlock: op.blockNumber,
            fromPosition: op.position,
            fromOpIndex: op.opIndex,
            toBlock: null,
            deleted: false,
            owner: op.sender,
            creator: op.sender,
            createdAt: op.blockNumber,
            createdPosition: op.position,
            createdOpIndex: op.opIndex,
            updatedAt: op.blockNumber,
            expiresAt: resolveExpiry(op),
            creationFlags: op.event?.creationFlags ?? op.creationFlags,
          },
          sortedAttributes(attributes),
        ),
      );
      continue;
    }
    if (current.deleted) continue;

    const base: EntityVersion = {
      ...current,
      version: current.version + 1,
      fromBlock: op.blockNumber,
      fromPosition: op.position,
      fromOpIndex: op.opIndex,
      toBlock: null,
      updatedAt: op.blockNumber,
    };
    switch (op.operationType) {
      case OPERATION_PATCH: {
        applyAttributes(attributes, op.attributes);
        push(withAttributes(base, sortedAttributes(attributes)));
        break;
      }
      case OPERATION_EXTEND:
        push({ ...base, expiresAt: resolveExpiry(op) });
        break;
      case OPERATION_TRANSFER: {
        const newOwner = op.event?.newOwner ?? op.newOwner?.toLowerCase();
        if (!newOwner) continue;
        push({ ...base, owner: newOwner });
        break;
      }
      case OPERATION_DELETE:
        push({ ...base, deleted: true });
        break;
      default:
        // A create on an existing key, or an operation type this build does
        // not know: nothing the engine would have applied.
        continue;
    }
  }
  return versions;
}

// ---------------------------------------------------------------------------
// Receipt logs → per-operation events

/** topic0 of each engine event, keccak256 of the event signature. */
export const ENTITY_EVENT_TOPICS = {
  created: "0xb282d7c494b8899aa8015cd07be621530beb03409eb8c5e8fdc1411ba64356a5",
  patched: "0xe986ee220b2d7947a009d9389d8400b2ac82d3b430a9f72700a0975d3d5a34fe",
  expiryExtended: "0x10dc3526654c9ba4e2370b1bfcbc0de087d141a5694b3d3305d37df7e6705d4b",
  ownershipTransferred: "0x0b659dccc8eb950324170e8d9598af5ee04ee070883eb28651a96788721fbf83",
  deleted: "0x4059b76c47e1ecc40ba88e649b654f716515eb358c3ce83c803820e3b3130cc3",
} as const;

const EVENT_TOPIC_FOR_OPERATION: Record<number, string> = {
  [OPERATION_CREATE]: ENTITY_EVENT_TOPICS.created,
  [OPERATION_PATCH]: ENTITY_EVENT_TOPICS.patched,
  [OPERATION_EXTEND]: ENTITY_EVENT_TOPICS.expiryExtended,
  [OPERATION_TRANSFER]: ENTITY_EVENT_TOPICS.ownershipTransferred,
  [OPERATION_DELETE]: ENTITY_EVENT_TOPICS.deleted,
};

/** The columns of a stored receipt log this module reads. */
export interface EntityEventLog {
  logIndex: number;
  address: string;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string;
}

const REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";

function wordAt(data: string, index: number): bigint | undefined {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const word = hex.slice(index * 64, index * 64 + 64);
  if (word.length !== 64 || !/^[0-9a-fA-F]+$/.test(word)) return undefined;
  return BigInt(`0x${word}`);
}

function decodeEvent(topic0: string, log: EntityEventLog): EntityOpEvent | undefined {
  switch (topic0) {
    case ENTITY_EVENT_TOPICS.created: {
      const expiresAt = wordAt(log.data, 0);
      const flags = wordAt(log.data, 1);
      if (expiresAt === undefined) return undefined;
      return { expiresAt, ...(flags !== undefined ? { creationFlags: Number(flags & 0xffn) } : {}) };
    }
    case ENTITY_EVENT_TOPICS.expiryExtended: {
      const expiresAt = wordAt(log.data, 0);
      return expiresAt === undefined ? undefined : { expiresAt };
    }
    case ENTITY_EVENT_TOPICS.ownershipTransferred: {
      const topic = log.topic3?.toLowerCase();
      if (!topic || topic.length !== 66) return undefined;
      return { newOwner: `0x${topic.slice(-40)}` };
    }
    default:
      return {};
  }
}

/**
 * Pair one transaction's operations with the events its receipt carries. The
 * engine emits exactly one event per applied operation, in operation order, so
 * the n-th operation of a kind pairs with the n-th event of that kind; a pair
 * whose entity key disagrees is dropped rather than trusted, and the operation
 * falls back to what its calldata said.
 */
export function attachEventsToOps(ops: EntityOpRecord[], logs: readonly EntityEventLog[]): void {
  const queues = new Map<string, EntityEventLog[]>();
  for (const log of [...logs].sort((a, b) => a.logIndex - b.logIndex)) {
    if (log.address.toLowerCase() !== REGISTRY_ADDRESS || !log.topic0) continue;
    const topic0 = log.topic0.toLowerCase();
    const queue = queues.get(topic0);
    if (queue) queue.push(log);
    else queues.set(topic0, [log]);
  }
  for (const op of [...ops].sort(compareOps)) {
    const topic0 = EVENT_TOPIC_FOR_OPERATION[op.operationType];
    if (!topic0) continue;
    const log = queues.get(topic0)?.shift();
    if (!log) continue;
    if (log.topic1?.toLowerCase() !== op.entityKey.toLowerCase()) continue;
    const event = decodeEvent(topic0, log);
    if (event) op.event = event;
  }
}
