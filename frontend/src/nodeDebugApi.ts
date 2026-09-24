import {
  boundedJson, sameIdentity, validateVerifiedPage,
  type EqSelection, type NativeIdentity, type NativeSourceStatus, type VerifiedPage,
} from "./simulatorApi";
import type { ProofInspection } from "./patriciaProof";

export type NodeUiMode = "fullnode" | "lightnode";
export interface InspectedPage extends VerifiedPage {
  canonicalRequest: string;
  canonicalProof: string;
  inspection: ProofInspection;
}
export interface FeedBlock extends NativeIdentity {
  feedDigest: string;
  header: { height: string; hash: string; parentHash: string; stateRoot: string; timestampMs: string; inputsDigest: string; outcomesDigest: string };
  transactions: Array<{ position: number; digest: string; actor: string; status: string; budgetUnits: string; spentUnits: string }>;
  operations: Array<{ phase: string; groupPosition: number; operationPosition: number; kind: string; namespaceId: string | null; recordId: string | null; recordKey: string | null; outcome: string; reason: string | null }>;
  changes: Array<Record<string, unknown>>;
  spentUnits: string;
}

function deadline(signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
}

export async function fetchNodeStatus(mode: NodeUiMode, signal?: AbortSignal): Promise<NativeSourceStatus> {
  const data = await boundedJson(await fetch("/node-sim/v1/status", {
    credentials: "omit", cache: "no-store", signal: deadline(signal),
  }), 128 * 1024) as NativeSourceStatus;
  if (!data || data.role !== (mode === "fullnode" ? "full" : "light") ||
      typeof data.sourceId !== "string" || typeof data.runId !== "string" ||
      typeof data.genesisHash !== "string" || typeof data.chainId !== "string" ||
      typeof data.health !== "string" || typeof data.paused !== "boolean" ||
      !data.head || !uint(data.head.height) || !hash(data.head.hash) || !hash(data.head.stateRoot) ||
      (data.observedPeerHeight !== undefined && !uint(data.observedPeerHeight))) {
    throw new Error("NodeIdentityMismatch");
  }
  return data;
}

export function validateInspectedPage(data: unknown, identity: NativeIdentity, request: EqSelection): InspectedPage {
  const result = validateVerifiedPage(data, identity, request) as InspectedPage;
  if (!/^0x(?:[0-9a-f]{2})+$/.test(result.canonicalRequest ?? "") ||
      !/^0x(?:[0-9a-f]{2})+$/.test(result.canonicalProof ?? "") ||
      !result.inspection || typeof result.inspection !== "object") {
    throw new Error("InvalidProofInspection");
  }
  validateInspectionStructure(result.inspection, result);
  return result;
}

const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/.test(v);
const uint = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= 4096;
const natural = (v: unknown, max = 65536): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = (v: unknown, options: string[]) => typeof v === "string" && options.includes(v);
const map = (v: unknown) => record(v) && hash(v.root) && uint(v.entries);
function requireInspection(condition: unknown): asserts condition {
  if (!condition) throw new Error("InvalidProofInspection");
}

/** Shape and response bindings only. Cryptographic verification stays in Rust. */
function validateInspectionStructure(unknownInspection: unknown, page: VerifiedPage) {
  requireInspection(record(unknownInspection));
  const i = unknownInspection;
  requireInspection(i.version === 1 && i.proofProfile === "eq-page-v1" && hash(i.queryDigest));
  const state = i.stateComposition;
  requireInspection(record(state) && state.stateRoot === page.snapshot.stateRoot && state.domain === "arkiv/state/v1" &&
    hex(state.headerBytes) && hex(state.pricingBytes) && uint(state.nextNamespace) && map(state.catalog) && map(state.host));
  const ns = state.namespace;
  requireInspection(record(ns) && ns.id === page.query.namespace && uint(ns.nextRecord) &&
    [ns.records, ns.rows, ns.keys, ns.terms].every(map));
  requireInspection(Array.isArray(i.pointPaths) && i.pointPaths.length >= 2 && i.pointPaths.length <= 130);
  const ids = new Set<string>();
  for (const path of i.pointPaths) {
    requireInspection(record(path) && text(path.id) && !ids.has(path.id) &&
      oneOf(path.map, ["catalog", "terms", "rows", "keys"]) && hash(path.root) && hex(path.key) &&
      text(path.keyNibbles) && /^[0-9a-f]*$/.test(path.keyNibbles) && path.keyNibbles === path.key.slice(2) &&
      (path.namespaceId === null || path.namespaceId === page.query.namespace) && (path.recordId === null || uint(path.recordId)) &&
      natural(path.suppliedNodeCount, 2048) && Array.isArray(path.nodes) && path.nodes.length <= 2048 && record(path.terminal) &&
      oneOf(path.terminal.kind, ["inclusion", "absence"]) &&
      oneOf(path.terminal.reason, ["leaf-match", "empty-root", "divergent-leaf", "divergent-extension", "empty-branch-slot"]));
    ids.add(path.id);
    const commitment = path.map === "catalog" ? state.catalog : ns[String(path.map)];
    requireInspection(record(commitment) && path.root === commitment.root);
    for (const node of path.nodes) {
      requireInspection(record(node) && natural(node.index) && natural(node.proofIndex) && natural(node.depth, 4096) &&
        oneOf(node.source, ["root", "hash", "inline"]) && hash(node.hash) && hex(node.rlp) &&
        oneOf(node.kind, ["branch", "extension", "leaf"]) && text(node.compressedPath) && /^[0-9a-f]*$/.test(node.compressedPath) &&
        (node.selectedNibble === null || (typeof node.selectedNibble === "string" && /^[0-9a-f]$/.test(node.selectedNibble))) &&
        uint(node.valueBytes) && Array.isArray(node.children) && node.children.length <= 16);
      requireInspection(node.kind === "branch" ? node.children.length === 16 : node.kind === "extension" ? node.children.length === 1 : node.children.length === 0);
      for (const child of node.children) {
        requireInspection(record(child) && (child.slot === null || (typeof child.slot === "string" && /^[0-9a-f]$/.test(child.slot))) &&
          oneOf(child.kind, ["empty", "hash", "inline"]) && (child.kind !== "hash" || hash(child.hash)) &&
          (child.kind !== "inline" || hex(child.rlp)) && (child.hash === undefined || hash(child.hash)) && (child.rlp === undefined || hex(child.rlp)));
      }
    }
  }
  const posting = i.postingSet;
  requireInspection(record(posting) && posting.method === "complete-set-reconstruction" && typeof posting.termPresent === "boolean" &&
    natural(posting.count, 4096) && posting.count === page.postingCount && hash(posting.reconstructedRoot) &&
    (posting.authenticatedRoot === null || hash(posting.authenticatedRoot)) &&
    Array.isArray(posting.recordIds) && posting.recordIds.length === posting.count && posting.recordIds.every(uint) &&
    Array.isArray(posting.selectedRecordIds) && posting.selectedRecordIds.length === page.rows.length && posting.selectedRecordIds.every(uint));
  requireInspection(posting.termPresent ? posting.authenticatedRoot === posting.reconstructedRoot : posting.authenticatedRoot === null && posting.count === 0);
  const postingIds = new Set(posting.recordIds);
  const selectedIds = posting.selectedRecordIds;
  requireInspection(postingIds.size === posting.recordIds.length);
  page.rows.forEach((row, index) => {
    requireInspection(record(row) && row.namespaceId === page.query.namespace && uint(row.recordId) && hex(row.recordKey) && uint(row.expiresAtHeight) &&
      selectedIds[index] === row.recordId && postingIds.has(row.recordId) && Array.isArray(row.attributes) && row.attributes.length <= 256 &&
      Array.isArray(row.fields) && row.fields.length <= 256);
    for (const attribute of row.attributes) requireInspection(record(attribute) && text(attribute.name) && text(attribute.type) && ["string", "boolean"].includes(typeof attribute.value));
    for (const field of row.fields) requireInspection(record(field) && text(field.name) && text(field.type) && uint(field.byteLength));
  });
  requireInspection(!page.diagnostics || (page.diagnostics.verifier === "light-follower" && uint(page.diagnostics.proofBytes) && uint(page.diagnostics.fetchMs) && uint(page.diagnostics.verifyMs)));
}

export async function inspectNodeQuery(identity: NativeIdentity, request: EqSelection, signal?: AbortSignal): Promise<InspectedPage> {
  const data = await boundedJson(await fetch("/node-sim/v1/query/inspect", {
    method: "POST", headers: { "content-type": "application/json" },
    credentials: "omit", body: JSON.stringify(request), signal: deadline(signal),
  }), 8 * 1024 * 1024);
  return validateInspectedPage(data, identity, request);
}

export async function fetchNodeBlock(identity: NativeIdentity, height: string, signal?: AbortSignal): Promise<FeedBlock> {
  if (!/^\d+$/.test(height)) throw new Error("InvalidBlockHeight");
  const data = await boundedJson(await fetch(`/node-sim/v1/feed/blocks/${height}`, {
    credentials: "omit", signal: deadline(signal),
  })) as FeedBlock;
  if (!sameIdentity(data, identity) || data.header?.height !== height ||
      !Array.isArray(data.transactions) || !Array.isArray(data.operations) || !Array.isArray(data.changes)) {
    throw new Error("BlockIdentityMismatch");
  }
  return data;
}

export interface QueryExample {
  id: string; label: string; title: string; explanation: string; request: EqSelection;
}
const base: EqSelection = { height: "20", namespace: "1", attribute: "group", valueType: "u64", value: "1", limit: 3, cursor: null };
export const QUERY_EXAMPLES: QueryExample[] = [
  { id: "membership", label: "01 / Membership", title: "Find records & turn the page", explanation: "At block 20, group = u64(1) has five matching records. Fetch three, then follow the verified continuation for two more.", request: { ...base } },
  { id: "absence", label: "02 / Absence", title: "Prove an empty answer", explanation: "The value u64(999999) has no matching posting list. Inspect the path that proves this term is absent.", request: { ...base, value: "999999" } },
  { id: "before-expiry", label: "03 / Before expiry", title: "Look back to block 13", explanation: "Two records match. One has an expiry height of 14: it is still present in this historical snapshot.", request: { ...base, height: "13" } },
  { id: "after-expiry", label: "04 / After expiry", title: "Move forward one block", explanation: "At block 14, the expiring record has been removed. The same query now returns one matching record.", request: { ...base, height: "14" } },
];

export function pinSelection(request: EqSelection, head: string): EqSelection {
  const height = request.height.trim() === "latest" ? head : request.height.trim();
  if (!/^\d+$/.test(height) || BigInt(height) > BigInt(head)) throw new Error("BlockNotSynced");
  if (!/^\d+$/.test(request.namespace) || BigInt(request.namespace) < 1n) throw new Error("InvalidNamespace");
  if (!request.attribute.trim() || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 64) throw new Error("InvalidQuery");
  let value = request.value;
  if (request.valueType === "bool") {
    if (value !== true && value !== false && value !== "true" && value !== "false") throw new Error("InvalidBoolean");
    value = value === true || value === "true";
  } else if (request.valueType === "u64" || request.valueType === "i64") {
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("InvalidInteger");
    const n = BigInt(value);
    if (request.valueType === "u64" ? n < 0n || n > 18446744073709551615n : n < -9223372036854775808n || n > 9223372036854775807n) throw new Error("IntegerOutOfRange");
    value = n.toString();
  }
  return { ...request, height: BigInt(height).toString(), namespace: BigInt(request.namespace).toString(), attribute: request.attribute.trim(), value };
}

export function readableKey(value: unknown): string {
  if (typeof value !== "string") return "Unknown key";
  if (!/^0x(?:[0-9a-f]{2})+$/.test(value)) return value;
  const bytes = value.slice(2).match(/../g)!.map((n) => parseInt(n, 16));
  return bytes.every((n) => n >= 32 && n <= 126) ? String.fromCharCode(...bytes) : value;
}

export function formatNodeBytes(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "Unavailable";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "Unavailable";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}
