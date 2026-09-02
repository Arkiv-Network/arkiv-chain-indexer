/**
 * Folding decoded Arkiv operations into entity state — the pure half of the
 * experimental entity index behind `POST /shadow-rpc/experimental`.
 *
 * The scanner stores what each registry transaction *asked for* (one
 * `transaction_operations` row per operation: attributes, expiry request, new
 * owner) and what the engine *announced* (the `EntityCreated`, `ExpiryExtended`,
 * … receipt logs). A node keeps the resulting entity state; the index does
 * not, so this module replays an entity's operations, in chain order, into the
 * sequence of states it went through — one {@link EntityVersion} per applied
 * operation, each valid from its own block until the next one's.
 *
 * The rules are the engine's (`arkiv-reth-executor`, `arkiv.rs`):
 *
 * - **create** sets creator = owner = sender, `createdAt` = `updatedAt` = block,
 *   the absolute expiry, the creation flags, the content type, the payload and
 *   the attributes (which the engine keeps sorted by name bytes);
 * - **patch** merges: a mutation with a real type sets (or retypes) that
 *   attribute, a tombstone (`typeId` 0) unsets it, and the `$payload` /
 *   `$contentType` cells route to the entity's own fields;
 * - **extend** replaces the expiry (the engine has already refused shortening);
 * - **transfer** replaces the owner;
 * - **delete** ends the entity;
 * - every mutation sets `updatedAt` to its block, an equal-expiry extend
 *   included.
 *
 * Only *applied* operations are replayed — the caller filters out reverted
 * transactions — so this never re-checks authorization, liveness or flags: the
 * chain already did, and an operation that made it into a successful
 * transaction took effect.
 *
 * Expiry is the one field the calldata does not carry outright: the engine
 * resolves `max(expiresAt, block + minLifetime)` and announces the result in
 * the receipt log. Where that log was stored it is authoritative; otherwise the
 * single block count the decoder kept is read as a lifetime when it could be
 * one (it does not reach past the current block) and as a deadline when it
 * could not — see {@link resolveRequestedExpiry}.
 */
import type { ArkivOperationAttribute } from "./arkivOperations";
import {
  TOMBSTONE_TYPE_ID,
  TYPE_IDS,
  TYPE_TAGS_BY_ID,
  compareUtf8,
  toStoredAttributeValue,
  type AttributeTypeTag,
  type StoredAttributeValue,
} from "./entityValues";

export const OPERATION_CREATE = 1;
export const OPERATION_UPDATE = 2;
export const OPERATION_EXTEND = 3;
export const OPERATION_TRANSFER = 4;
export const OPERATION_DELETE = 5;
/** The engine's prune of an already-expired entity; state-wise a delete. */
export const OPERATION_EXPIRE = 6;

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
  contentType: string | null;
  payloadSizeBytes: number;
  attributes: ArkivOperationAttribute[];
  /** The decoder's single block count: a lifetime, or a deadline when only that was given. */
  expiresAtBlocks: number;
  newOwner: string | null;
  /** Set when the transaction's receipt logs were stored and matched this operation. */
  event?: EntityOpEvent;
}

export interface StoredEntityAttribute extends StoredAttributeValue {
  name: string;
  typeId: number;
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
  contentType: string;
  payloadSize: number;
  /** Sorted by name bytes, the engine's canonical order. */
  attributes: StoredEntityAttribute[];
}

/**
 * The engine's `max(expiresAt, block + minLifetime)`, reconstructed from the
 * one number the decoder stored. A count that does not reach past the current
 * block cannot be a deadline (the entity would be dead on arrival), so it is
 * read as a lifetime; anything larger is read as the absolute deadline it most
 * likely was. Exact whenever an operation gave only one of the two, which is
 * what every SDK helper does.
 */
export function resolveRequestedExpiry(blockNumber: number, expiresAtBlocks: number): bigint {
  const count = BigInt(Math.max(0, Math.floor(expiresAtBlocks)));
  const block = BigInt(blockNumber);
  return count > block ? count : block + count;
}

function resolveExpiry(op: EntityOpRecord): bigint {
  return op.event?.expiresAt ?? resolveRequestedExpiry(op.blockNumber, op.expiresAtBlocks);
}

function typeTagOf(attribute: ArkivOperationAttribute): AttributeTypeTag | undefined {
  const byName = TYPE_IDS[attribute.valueTypeName as AttributeTypeTag];
  if (byName !== undefined && byName === attribute.valueType) return attribute.valueTypeName as AttributeTypeTag;
  return TYPE_TAGS_BY_ID.get(attribute.valueType);
}

function compareOps(a: EntityOpRecord, b: EntityOpRecord): number {
  return a.blockNumber - b.blockNumber || a.position - b.position || a.opIndex - b.opIndex;
}

function sortedAttributes(byName: Map<string, StoredEntityAttribute>): StoredEntityAttribute[] {
  return [...byName.values()].sort((a, b) => compareUtf8(a.name, b.name));
}

/**
 * Apply a create's or patch's attribute cells to the working set. A tombstone
 * unsets; a typed cell sets, replacing the value *and* its type; a cell of a
 * type the index cannot store (`bytes`, a legacy type name, corrupt text) is
 * skipped rather than stored as something it is not.
 */
function applyAttributes(byName: Map<string, StoredEntityAttribute>, cells: ArkivOperationAttribute[]): void {
  for (const cell of cells) {
    if (cell.valueType === TOMBSTONE_TYPE_ID) {
      byName.delete(cell.key);
      continue;
    }
    const tag = typeTagOf(cell);
    if (!tag) continue;
    const stored = toStoredAttributeValue(tag, cell.value);
    if (!stored) continue;
    byName.set(cell.key, { name: cell.key, typeId: TYPE_IDS[tag], ...stored });
  }
}

/**
 * Replay one entity's applied operations into its versions. Operations may be
 * given in any order; anything before the create, or after a delete, cannot
 * have been applied by the engine and is ignored.
 */
export function foldEntityVersions(entityKey: string, records: readonly EntityOpRecord[]): EntityVersion[] {
  const ops = [...records].sort(compareOps);
  const versions: EntityVersion[] = [];
  let current: EntityVersion | undefined;
  const attributes = new Map<string, StoredEntityAttribute>();

  const push = (next: EntityVersion) => {
    if (current) current.toBlock = next.fromBlock;
    versions.push(next);
    current = next;
  };

  for (const op of ops) {
    if (!current) {
      if (op.operationType !== OPERATION_CREATE) continue;
      attributes.clear();
      applyAttributes(attributes, op.attributes);
      push({
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
        creationFlags: op.event?.creationFlags ?? null,
        contentType: op.contentType ?? "",
        payloadSize: op.payloadSizeBytes,
        attributes: sortedAttributes(attributes),
      });
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
      case OPERATION_UPDATE: {
        applyAttributes(attributes, op.attributes);
        push({
          ...base,
          // The decoder only reports the cells a patch carried, so an absent
          // content type or an empty payload reads as "untouched".
          contentType: op.contentType ?? current.contentType,
          payloadSize: op.payloadSizeBytes > 0 ? op.payloadSizeBytes : current.payloadSize,
          attributes: sortedAttributes(attributes),
        });
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
      case OPERATION_EXPIRE:
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
  [OPERATION_UPDATE]: ENTITY_EVENT_TOPICS.patched,
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
