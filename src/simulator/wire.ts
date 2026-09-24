/** Whitelisted metadata wire; canonical transaction bodies/field values never enter this module. */
import { keccak256 } from "viem";
import { feedDigest } from "./feedDigest";
import {
  array,
  choice,
  decimal,
  fail,
  hex,
  integer,
  nullable,
  object,
  signed,
  text,
} from "./common";
import { parseIdentity, type SimulatorIdentity } from "./config";
export const FEED_CAP = 4 * 1024 * 1024;
export const TYPES = ["bool", "i64", "u64", "str"] as const;
export type AttributeType = (typeof TYPES)[number];
export interface Attribute {
  name: string;
  type: AttributeType;
  value: string | boolean;
}
export interface Field {
  name: string;
  type: AttributeType | "bytes";
  byteLength: string;
  digest: string;
  reference: null;
}
export interface Header {
  height: string;
  hash: string;
  parentHash: string;
  stateRoot: string;
  timestampMs: string;
  inputsDigest: string;
  outcomesDigest: string;
  headerBytes: string;
}
export interface Receipt {
  modelVersion: number;
  scheduleId: number;
  spentUnits: string;
}
export interface Transaction {
  position: number;
  digest: string;
  actor: string;
  requestId: string;
  budgetUnits: string;
  status: "committed" | "failed";
  spentUnits: string;
}
export const OUTCOMES = [
  "applied",
  "rolledBack",
  "rejected",
  "admissionRejected",
  "hostRejected",
  "notExecuted",
] as const;
export interface Operation {
  phase: "admin" | "expiry" | "user";
  groupPosition: number;
  operationPosition: number;
  kind: string;
  namespaceId: string | null;
  recordId: string | null;
  recordKey: string | null;
  outcome: (typeof OUTCOMES)[number];
  receipt: Receipt | null;
  reason: string | null;
}
export type Change =
  | {
      kind: "namespaceUpsert";
      namespaceId: string;
      name: string;
      owner: string;
      revision: string;
    }
  | {
      kind: "recordUpsert";
      namespaceId: string;
      recordId: string;
      recordKey: string;
      expiresAtHeight: string;
      attributes: Attribute[];
      fields: Field[];
    }
  | {
      kind: "recordDelete";
      namespaceId: string;
      recordId: string;
      recordKey: string;
    }
  | {
      kind: "rawUpsert";
      namespaceId: string;
      key: string;
      byteLength: string;
      digest: string;
    }
  | { kind: "rawDelete"; namespaceId: string; key: string };
export interface FeedBlock extends SimulatorIdentity {
  feedVersion: 1;
  feedDigest: string;
  header: Header;
  transactions: Transaction[];
  operations: Operation[];
  changes: Change[];
  spentUnits: string;
}
export interface SourceStatus extends SimulatorIdentity {
  apiVersion: 1;
  feedVersion: 1;
  sourceKind: "arkiv-native-simulator";
  authentication: "unsigned-simulator-v1";
  durability: "durable" | "volatile";
  head: { height: string; hash: string; stateRoot: string };
  paused: boolean;
  health: string;
  role: "producer" | "full" | "light";
  configRevision: string;
  projectionVersion: 1;
  blockFormatVersion: 1;
  protocolVersion: 2;
  coverage: { from: string; through: string; complete: boolean };
  proofProfiles: string[];
  limits: { feedPageBytes: string; pageItems: number };
  workload: {
    version: number;
    seed: string;
    blockPeriodMs: string;
    payloadBytes: number;
    extraRowsPerBlock: number;
  };
  memory: {
    engineCacheBytes: string;
    engineCacheEntries: number;
    residentManifests: number;
  };
  observedPeerHeight: string;
}
const identityKeys = ["sourceId", "runId", "genesisHash", "chainId"] as const;
function identity(v: Record<string, unknown>): SimulatorIdentity {
  return parseIdentity({
    sourceId: text(v.sourceId),
    runId: text(v.runId),
    genesisHash: text(v.genesisHash),
    chainId: decimal(v.chainId),
  });
}
export function digest(domain: string, bytes: Uint8Array): string {
  const prefix = Buffer.from(domain);
  return keccak256(
    Buffer.concat([Buffer.from([prefix.length]), prefix, bytes]),
  );
}
export function headerBytes(
  chainId: string,
  h: Omit<Header, "hash" | "headerBytes">,
): Buffer {
  const b = Buffer.alloc(156);
  b.writeUInt32BE(2);
  b.writeBigUInt64BE(BigInt(chainId), 4);
  b.writeBigUInt64BE(BigInt(h.height), 12);
  Buffer.from(h.parentHash.slice(2), "hex").copy(b, 20);
  b.writeBigUInt64BE(BigInt(h.timestampMs), 52);
  Buffer.from(h.inputsDigest.slice(2), "hex").copy(b, 60);
  Buffer.from(h.outcomesDigest.slice(2), "hex").copy(b, 92);
  Buffer.from(h.stateRoot.slice(2), "hex").copy(b, 124);
  return b;
}
export function parseHeader(value: unknown, chainId: string): Header {
  const v = object(value, [
    "height",
    "hash",
    "parentHash",
    "stateRoot",
    "timestampMs",
    "inputsDigest",
    "outcomesDigest",
    "headerBytes",
  ]);
  const h = {
    height: decimal(v.height),
    hash: hex(v.hash, 32),
    parentHash: hex(v.parentHash, 32),
    stateRoot: hex(v.stateRoot, 32),
    timestampMs: decimal(v.timestampMs),
    inputsDigest: hex(v.inputsDigest, 32),
    outcomesDigest: hex(v.outcomesDigest, 32),
    headerBytes: hex(v.headerBytes, 156),
  };
  const bytes = headerBytes(chainId, h);
  if (
    h.headerBytes !== "0x" + bytes.toString("hex") ||
    h.hash !== digest("arkiv/header/v2", bytes)
  )
    return fail("InvalidHeader");
  return h;
}
export function parseAttribute(value: unknown): Attribute {
  const v = object(value, ["name", "type", "value"]);
  const type = choice(v.type, TYPES);
  let scalar: string | boolean;
  switch (type) {
    case "bool":
      if (typeof v.value !== "boolean") return fail();
      scalar = v.value;
      break;
    case "i64":
      scalar = signed(v.value);
      break;
    case "u64":
      scalar = decimal(v.value);
      break;
    case "str":
      scalar = text(v.value, 64);
      break;
  }
  return { name: text(v.name, 20, 1), type, value: scalar };
}
function parseField(value: unknown): Field {
  const v = object(value, [
    "name",
    "type",
    "byteLength",
    "digest",
    "reference",
  ]);
  if (v.reference !== null) return fail();
  return {
    name: text(v.name, 20, 1),
    type: choice(v.type, [...TYPES, "bytes"]),
    byteLength: decimal(v.byteLength),
    digest: hex(v.digest, 32),
    reference: null,
  };
}
export function parseChange(value: unknown): Change {
  if (!value || typeof value !== "object" || !("kind" in value)) return fail();
  const common = ["kind", "namespaceId"];
  switch (value.kind) {
    case "namespaceUpsert": {
      const v = object(value, [...common, "name", "owner", "revision"]);
      return {
        kind: value.kind,
        namespaceId: decimal(v.namespaceId, true),
        name: text(v.name, 20, 1),
        owner: hex(v.owner, 20),
        revision: decimal(v.revision),
      };
    }
    case "recordUpsert": {
      const v = object(value, [
        ...common,
        "recordId",
        "recordKey",
        "expiresAtHeight",
        "attributes",
        "fields",
      ]);
      const attributes = array(v.attributes, parseAttribute, 64),
        fields = array(v.fields, parseField, 64);
      if (
        attributes.length + fields.length > 64 ||
        new Set([...attributes, ...fields].map((c) => c.name)).size !==
          attributes.length + fields.length
      )
        return fail();
      return {
        kind: value.kind,
        namespaceId: decimal(v.namespaceId, true),
        recordId: decimal(v.recordId, true),
        recordKey: hex(v.recordKey, 32, 1),
        expiresAtHeight: decimal(v.expiresAtHeight),
        attributes,
        fields,
      };
    }
    case "recordDelete": {
      const v = object(value, [...common, "recordId", "recordKey"]);
      return {
        kind: value.kind,
        namespaceId: decimal(v.namespaceId, true),
        recordId: decimal(v.recordId, true),
        recordKey: hex(v.recordKey, 32, 1),
      };
    }
    case "rawUpsert": {
      const v = object(value, [...common, "key", "byteLength", "digest"]);
      return {
        kind: value.kind,
        namespaceId: decimal(v.namespaceId, true),
        key: hex(v.key, 20, 0),
        byteLength: decimal(v.byteLength),
        digest: hex(v.digest, 32),
      };
    }
    case "rawDelete": {
      const v = object(value, [...common, "key"]);
      return {
        kind: value.kind,
        namespaceId: decimal(v.namespaceId, true),
        key: hex(v.key, 20, 0),
      };
    }
    default:
      return fail("UnsupportedVersion");
  }
}
function parseReceipt(value: unknown): Receipt {
  const v = object(value, ["modelVersion", "scheduleId", "spentUnits"]);
  return {
    modelVersion: integer(v.modelVersion),
    scheduleId: integer(v.scheduleId),
    spentUnits: decimal(v.spentUnits),
  };
}
function parseTransaction(value: unknown): Transaction {
  const v = object(value, [
    "position",
    "digest",
    "actor",
    "requestId",
    "budgetUnits",
    "status",
    "spentUnits",
  ]);
  return {
    position: integer(v.position, 65535),
    digest: hex(v.digest, 32),
    actor: hex(v.actor, 20),
    requestId: hex(v.requestId, 32),
    budgetUnits: decimal(v.budgetUnits),
    status: choice(v.status, ["committed", "failed"]),
    spentUnits: decimal(v.spentUnits),
  };
}
function parseOperation(value: unknown): Operation {
  const v = object(value, [
    "phase",
    "groupPosition",
    "operationPosition",
    "kind",
    "namespaceId",
    "recordId",
    "recordKey",
    "outcome",
    "receipt",
    "reason",
  ]);
  const result: Operation = {
    phase: choice(v.phase, ["admin", "expiry", "user"]),
    groupPosition: integer(v.groupPosition, 65535),
    operationPosition: integer(v.operationPosition, 65535),
    kind: choice(v.kind, [
      "createNamespace",
      "transferNamespace",
      "put",
      "delete",
      "createRecord",
      "patchRecord",
      "deleteRecord",
      "expireRecord",
      "setPricing",
    ]),
    namespaceId: nullable(v.namespaceId, (n) => decimal(n, true)),
    recordId: nullable(v.recordId, (n) => decimal(n, true)),
    recordKey: nullable(v.recordKey, (k) => hex(k, 32, 0)),
    outcome: choice(v.outcome, OUTCOMES),
    receipt: nullable(v.receipt, parseReceipt),
    reason: nullable(v.reason, (r) =>
      choice(r, [
        "AdminRejected",
        "EngineRejected",
        "AdmissionRejected",
        "HostRejected",
      ]),
    ),
  };
  if (
    result.phase !== "admin" &&
    ["applied", "rolledBack", "rejected"].includes(result.outcome) !==
      (result.receipt !== null)
  )
    return fail("InvalidOutcome");
  return result;
}
export function parseFeedBlock(value: unknown): FeedBlock {
  const v = object(value, [
    "feedVersion",
    "feedDigest",
    ...identityKeys,
    "header",
    "transactions",
    "operations",
    "changes",
    "spentUnits",
  ]);
  if (v.feedVersion !== 1) return fail("UnsupportedVersion");
  const id = identity(v);
  const transactions = array(v.transactions, parseTransaction, 4096),
    operations = array(v.operations, parseOperation, 65536),
    changes = array(v.changes, parseChange, 65536);
  const result: FeedBlock = {
    feedVersion: 1,
    feedDigest: hex(v.feedDigest, 32),
    ...id,
    header: parseHeader(v.header, id.chainId),
    transactions,
    operations,
    changes,
    spentUnits: decimal(v.spentUnits),
  };
  if (transactions.some((t, i) => t.position !== i))
    return fail("InvalidOrder");
  const ranks = { admin: 0, expiry: 1, user: 2 };
  let prior = -1n;
  for (const op of operations) {
    const order =
      (BigInt(ranks[op.phase]) << 64n) +
      (BigInt(op.groupPosition) << 32n) +
      BigInt(op.operationPosition);
    if (order <= prior) return fail("InvalidOrder");
    prior = order;
    if (op.phase === "user" && !transactions[op.groupPosition])
      return fail("InvalidOutcome");
  }
  if (
    operations.reduce(
      (n, op) => n + BigInt(op.receipt?.spentUnits ?? "0"),
      0n,
    ) !== BigInt(result.spentUnits)
  )
    return fail("InvalidOutcome");
  const grouped = transactions.map(() => [] as Operation[]);
  for (const op of operations)
    if (op.phase === "user") grouped[op.groupPosition]!.push(op);
  for (const tx of transactions) {
    const ops = grouped[tx.position]!;
    if (ops.some((op, i) => op.operationPosition !== i))
      return fail("InvalidOrder");
    if (
      ops.reduce((n, op) => n + BigInt(op.receipt?.spentUnits ?? "0"), 0n) !==
        BigInt(tx.spentUnits) ||
      BigInt(tx.spentUnits) > BigInt(tx.budgetUnits)
    )
      return fail("InvalidOutcome");
    if (
      tx.status === "committed"
        ? ops.some((op) => op.outcome !== "applied")
        : ops.some((op) => op.outcome === "applied")
    )
      return fail("InvalidOutcome");
  }
  // Every terminal after-image must correspond to an applied mutation, including expiry.
  // Rolled-back candidate IDs never become a projection source.
  const touched = new Set<string>();
  for (const op of operations) {
    if (
      op.phase === "admin"
        ? op.kind !== "setPricing"
        : op.phase === "expiry"
          ? op.kind !== "expireRecord" || op.outcome !== "applied"
          : ["setPricing", "expireRecord"].includes(op.kind)
    )
      return fail("InvalidOutcome");
    if (op.outcome !== "applied" || op.phase === "admin") continue;
    if (op.namespaceId === null) return fail("InvalidProjection");
    let suffix: string;
    if (["createNamespace", "transferNamespace"].includes(op.kind))
      suffix = "namespace";
    else if (["put", "delete"].includes(op.kind))
      suffix = `raw/${hex(op.recordKey, 20, 0)}`;
    else {
      if (op.recordId === null) return fail("InvalidProjection");
      hex(op.recordKey, 32, 1);
      suffix = `record/${op.recordId}`;
    }
    touched.add(`${op.namespaceId}/${suffix}`);
  }
  const changesSeen = new Set<string>();
  for (const c of changes) {
    const key = `${c.namespaceId}/${c.kind === "namespaceUpsert" ? "namespace" : "recordId" in c ? `record/${c.recordId}` : `raw/${c.key}`}`;
    if (changesSeen.has(key)) return fail("DuplicateChange");
    if (!touched.has(key)) return fail("InvalidProjection");
    changesSeen.add(key);
  }
  if (changesSeen.size !== touched.size) return fail("InvalidProjection");
  if (
    result.header.height === "0" &&
    (result.header.hash !== id.genesisHash ||
      result.header.parentHash !== "0x" + "00".repeat(32) ||
      transactions.length ||
      operations.length ||
      changes.length ||
      result.spentUnits !== "0")
  )
    return fail("InvalidGenesis");
  const { feedDigest: expected, ...metadata } = result;
  if (feedDigest(metadata) !== expected) return fail("InvalidFeedDigest");
  return result;
}
export function parseStatus(value: unknown): SourceStatus {
  const v = object(value, [
    "apiVersion",
    "feedVersion",
    ...identityKeys,
    "sourceKind",
    "authentication",
    "durability",
    "head",
    "paused",
    "health",
    "role",
    "configRevision",
    "projectionVersion",
    "blockFormatVersion",
    "protocolVersion",
    "coverage",
    "proofProfiles",
    "limits",
    "workload",
    "memory",
    "observedPeerHeight",
  ]);
  if (
    v.apiVersion !== 1 ||
    v.feedVersion !== 1 ||
    v.projectionVersion !== 1 ||
    v.blockFormatVersion !== 1 ||
    v.protocolVersion !== 2
  )
    return fail("UnsupportedVersion");
  const head = object(v.head, ["height", "hash", "stateRoot"]);
  if (typeof v.paused !== "boolean") return fail();
  const coverage = object(v.coverage, ["from", "through", "complete"]);
  if (typeof coverage.complete !== "boolean") return fail();
  const limits = object(v.limits, ["feedPageBytes", "pageItems"]),
    workload = object(v.workload, [
      "version",
      "seed",
      "blockPeriodMs",
      "payloadBytes",
      "extraRowsPerBlock",
    ]),
    memory = object(v.memory, [
      "engineCacheBytes",
      "engineCacheEntries",
      "residentManifests",
    ]);
  if (
    workload.version !== 1 ||
    decimal(coverage.from) !== "0" ||
    decimal(coverage.through) !== decimal(head.height) ||
    coverage.complete !== true ||
    BigInt(decimal(limits.feedPageBytes)) > BigInt(FEED_CAP)
  )
    return fail("UnsupportedVersion");
  return {
    apiVersion: 1,
    feedVersion: 1,
    ...identity(v),
    sourceKind: choice(v.sourceKind, ["arkiv-native-simulator"]),
    authentication: choice(v.authentication, ["unsigned-simulator-v1"]),
    durability: choice(v.durability, ["durable", "volatile"]),
    head: {
      height: decimal(head.height),
      hash: hex(head.hash, 32),
      stateRoot: hex(head.stateRoot, 32),
    },
    paused: v.paused,
    health: choice(v.health, [
      "ready",
      "running",
      "paused",
      "storage-fenced",
      "following",
      "stalled",
      "chain-conflict",
    ]),
    role: choice(v.role, ["producer", "full", "light"]),
    configRevision: decimal(v.configRevision),
    projectionVersion: 1,
    blockFormatVersion: 1,
    protocolVersion: 2,
    coverage: { from: "0", through: decimal(coverage.through), complete: true },
    proofProfiles: array(v.proofProfiles, (p) => choice(p, ["eq-page-v1"]), 1),
    limits: {
      feedPageBytes: decimal(limits.feedPageBytes),
      pageItems: integer(limits.pageItems, 256),
    },
    workload: {
      version: 1,
      seed: decimal(workload.seed),
      blockPeriodMs: decimal(workload.blockPeriodMs, true),
      payloadBytes: integer(workload.payloadBytes, 1024),
      extraRowsPerBlock: integer(workload.extraRowsPerBlock, 4),
    },
    memory: {
      engineCacheBytes: decimal(memory.engineCacheBytes),
      engineCacheEntries: integer(memory.engineCacheEntries),
      residentManifests: integer(memory.residentManifests, 2),
    },
    observedPeerHeight: decimal(v.observedPeerHeight),
  };
}
