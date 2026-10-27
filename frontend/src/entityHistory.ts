// Replays an entity's stored operation history (`/entity/<key>`) into the
// versions it went through, the way the engine applied them: what each create
// or patch did to the attribute set, what each extend did to the expiry
// ("extended to permanent" is its own event), who each transfer handed it to,
// and which operations a failed transaction left unapplied. The transaction
// page uses the same fold to show a patch as old → new. Framework-free so
// `bun test` can cover it.

import type { EntityGenesisRecord, StoredEntityOperation } from "./api";
import {
  applyAttributeMutations,
  attributeState,
  fromEntityAttribute,
  fromOperationAttribute,
  isPermanentExpiry,
  type AttributeChange,
  type AttributeState,
  type AttributeView,
} from "./attributes";

export type EntityEventKind =
  | "genesis"
  | "created"
  | "patched"
  | "extended"
  | "extended-to-permanent"
  /** An extend of an entity that already never expires: an owner-only no-op. */
  | "extend-noop"
  | "transferred"
  | "deleted"
  /** The transaction reverted, so the operation changed nothing. */
  | "failed"
  /** An operation this build does not know, or one the engine could not have applied. */
  | "ignored";

export interface EntityHistoryEvent {
  /** Null for the genesis state. */
  operation: StoredEntityOperation | null;
  kind: EntityEventKind;
  /** The kind the operation would have had, for a failed one. */
  attemptedKind: EntityEventKind | null;
  /** Version after the operation (0 for the create or the genesis state); null when unknown or not applied. */
  version: number | null;
  /** creates and patches: what the triples did (against the state before, when known). */
  changes: AttributeChange[];
  /** The attribute set after the operation; null when the prior set is unknown. */
  attributes: AttributeView[] | null;
  expiresBefore: string | null;
  expiresAfter: string | null;
  ownerBefore: string | null;
  ownerAfter: string | null;
  /** The rent the operation's transaction burned and how many operations share it. */
  rent: { transactionRentFeeWei: string; operationCount: number } | null;
}

export interface EntityHistoryInput {
  genesis?: EntityGenesisRecord | null;
  /** Stored operations in chain order. */
  operations: readonly StoredEntityOperation[];
  /** True when older operations were cut off: the fold cannot know the state before the slice. */
  truncated?: boolean;
  /** The index's current version number, to number a truncated history backwards. */
  currentVersion?: number | null;
}

interface FoldState {
  attributes: AttributeState | null;
  expiresAt: string | null;
  owner: string | null;
  exists: boolean;
  deleted: boolean;
  version: number | null;
}

function sortedAttributes(state: AttributeState | null): AttributeView[] | null {
  if (!state) return null;
  return [...state.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function rentOf(operation: StoredEntityOperation): EntityHistoryEvent["rent"] {
  if (operation.transactionRentFeeWei === null) return null;
  return { transactionRentFeeWei: operation.transactionRentFeeWei, operationCount: Math.max(1, operation.transactionOperationCount) };
}

function isApplied(operation: StoredEntityOperation): boolean {
  // A row without a transaction cannot be told apart; the engine stored it, so it counts.
  return operation.transactionStatus !== "0";
}

/** Every operation, oldest first, as the event it was for the entity. */
export function foldEntityHistory(input: EntityHistoryInput): EntityHistoryEvent[] {
  const events: EntityHistoryEvent[] = [];
  const genesis = input.genesis ?? null;
  const operations = input.operations;
  // The fold knows the starting state when it sees the entity's beginning:
  // the genesis state, or a create at the head of an untruncated slice.
  const firstApplied = operations.find(isApplied);
  const startKnown = !input.truncated && (genesis !== null || firstApplied?.operation === "create");

  const state: FoldState = {
    attributes: startKnown ? new Map() : null,
    expiresAt: null,
    owner: null,
    exists: !startKnown,
    deleted: false,
    version: startKnown ? -1 : null,
  };

  if (genesis) {
    const attributes = genesis.attributes.map(fromEntityAttribute);
    if (startKnown) state.attributes = attributeState(attributes);
    state.expiresAt = genesis.expiresAt;
    state.owner = genesis.owner;
    state.exists = true;
    if (state.version !== null) state.version = 0;
    events.push({
      operation: null,
      kind: "genesis",
      attemptedKind: null,
      version: state.version,
      changes: applyAttributeMutations(new Map(), attributes).changes,
      attributes: sortedAttributes(attributeState(attributes)),
      expiresBefore: null,
      expiresAfter: genesis.expiresAt,
      ownerBefore: null,
      ownerAfter: genesis.owner,
      rent: null,
    });
  }

  for (const operation of operations) {
    const applied = isApplied(operation);
    const event: EntityHistoryEvent = {
      operation,
      kind: "ignored",
      attemptedKind: null,
      version: null,
      changes: [],
      attributes: null,
      expiresBefore: state.expiresAt,
      expiresAfter: state.expiresAt,
      ownerBefore: state.owner,
      ownerAfter: state.owner,
      rent: rentOf(operation),
    };
    const mutations = operation.attributes.map(fromOperationAttribute);
    let kind: EntityEventKind = "ignored";
    let nextAttributes: AttributeState | null = state.attributes;
    let nextExpiry = state.expiresAt;
    let nextOwner = state.owner;

    switch (operation.operation) {
      case "create": {
        if (state.exists && state.attributes !== null) break; // a create on an existing key changes nothing
        const result = applyAttributeMutations(new Map(), mutations);
        event.changes = result.changes;
        nextAttributes = result.next;
        nextExpiry = operation.resolvedExpiresAt;
        kind = "created";
        break;
      }
      case "patch": {
        const result = applyAttributeMutations(state.attributes, mutations);
        event.changes = result.changes;
        nextAttributes = result.next;
        kind = "patched";
        break;
      }
      case "extend": {
        nextExpiry = operation.resolvedExpiresAt ?? state.expiresAt;
        const wasPermanent = isPermanentExpiry(state.expiresAt);
        const nowPermanent = operation.permanent === true || isPermanentExpiry(nextExpiry);
        kind = wasPermanent && nowPermanent ? "extend-noop" : nowPermanent ? "extended-to-permanent" : "extended";
        break;
      }
      case "transfer":
        nextOwner = operation.newOwner ?? state.owner;
        kind = "transferred";
        break;
      case "delete":
        kind = "deleted";
        break;
      default:
        kind = "ignored";
    }
    if (state.deleted && kind !== "ignored") kind = "ignored";

    if (!applied && kind !== "ignored") {
      event.kind = "failed";
      event.attemptedKind = kind;
      event.attributes = sortedAttributes(state.attributes);
      if (kind === "extended" || kind === "extended-to-permanent" || kind === "extend-noop") event.expiresAfter = nextExpiry;
      if (kind === "transferred") event.ownerAfter = nextOwner;
      events.push(event);
      continue;
    }
    event.kind = kind;
    if (kind === "ignored") {
      event.attributes = sortedAttributes(state.attributes);
      events.push(event);
      continue;
    }

    state.attributes = nextAttributes;
    state.expiresAt = nextExpiry;
    state.owner = kind === "created" ? state.owner : nextOwner;
    state.exists = true;
    if (kind === "deleted") state.deleted = true;
    if (state.version !== null) state.version += 1;
    event.version = state.version;
    event.attributes = sortedAttributes(state.attributes);
    event.expiresAfter = state.expiresAt;
    event.ownerAfter = state.owner;
    events.push(event);
  }

  // A truncated slice is numbered backwards from the index's current version.
  if (state.version === null && typeof input.currentVersion === "number") {
    let version = input.currentVersion;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind === "failed" || event.kind === "ignored") continue;
      event.version = version;
      version -= 1;
    }
  }
  return events;
}

/** The event an operation of a transaction was, found by hash and op index. */
export function findOperationEvent(
  events: readonly EntityHistoryEvent[],
  hash: string,
  opIndex: number,
): EntityHistoryEvent | null {
  const wanted = hash.toLowerCase();
  return events.find((event) => event.operation?.hash.toLowerCase() === wanted && event.operation.opIndex === opIndex) ?? null;
}

const ATTEMPT_NOUNS: Record<EntityEventKind, string> = {
  genesis: "operation",
  created: "create",
  patched: "patch",
  extended: "extend",
  "extended-to-permanent": "extend to permanent",
  "extend-noop": "extend",
  transferred: "transfer",
  deleted: "delete",
  failed: "operation",
  ignored: "operation",
};

/** A short label for an event kind. */
export function eventLabel(event: Pick<EntityHistoryEvent, "kind" | "attemptedKind">): string {
  switch (event.kind) {
    case "genesis":
      return "Genesis state";
    case "created":
      return "Created";
    case "patched":
      return "Patched";
    case "extended":
      return "Extended";
    case "extended-to-permanent":
      return "Extended to permanent";
    case "extend-noop":
      return "Extend (already permanent)";
    case "transferred":
      return "Transferred";
    case "deleted":
      return "Deleted";
    case "failed":
      return `Failed ${event.attemptedKind ? ATTEMPT_NOUNS[event.attemptedKind] : "operation"} (not applied)`;
    case "ignored":
      return "Not applied";
  }
}

/**
 * The rent an operation's transaction burned, attributed per operation for
 * display: the whole amount when the transaction had one operation, else the
 * transaction total with the number of operations sharing it (the receipt
 * does not split rent by operation).
 */
export function operationRentShare(rent: EntityHistoryEvent["rent"]): { wei: string; sharedBy: number } | null {
  if (!rent) return null;
  return { wei: rent.transactionRentFeeWei, sharedBy: rent.operationCount };
}
