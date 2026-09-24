import {
  boundedJson, sameIdentity, validateVerifiedPage,
  type EqSelection, type NativeIdentity, type NativeSourceStatus, type VerifiedPage,
} from "./simulatorApi";
import type { ProofInspection } from "./patriciaProof";

export type NodeUiMode = "fullnode" | "lightnode";
export interface ArkivEntity { key: string; owner: string; creator: string; createdAt: string; updatedAt: string; expiresAt: string; contentType: string; payload: string; creationFlags: { raw: number; readonly: boolean; permissionlessExtension: boolean } }
export interface InspectedPage extends VerifiedPage {
  profile?: "arkiv-entity-v2";
  entities?: ArkivEntity[];
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
  if (data.capabilities) {
    const c = data.capabilities;
    const version = c.profile === "arkiv-entity-v2" ? 2 : c.profile === "generic-v1" ? 1 : 0;
    const types = version === 2 ? ARKIV_TYPES : ["bool", "i64", "u64", "str"];
    if (!version || c.layoutVersion !== version || c.codecVersion !== version || !Array.isArray(c.scalarTypes) || c.scalarTypes.length !== types.length || new Set(c.scalarTypes).size !== types.length || c.scalarTypes.some(t => !types.includes(t))) throw new Error("UnsupportedNodeProfile");
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
  const v2 = isArkivProfile(identity as NativeSourceStatus);
  if (result.inspection.version !== (v2 ? 2 : 1) || result.profile !== (v2 ? "arkiv-entity-v2" : undefined)) throw new Error("ProofProfileMismatch");
  validateInspectionStructure(result.inspection, result);
  if (v2) validateEntities(result);
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
  requireInspection((i.version === 1 || i.version === 2) && i.proofProfile === `eq-page-v${i.version}` && hash(i.queryDigest));
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
  } else if (["u64", "i64", "i32", "u256"].includes(request.valueType)) {
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("InvalidInteger");
    const n = BigInt(value);
    const bits = request.valueType === "u256" ? 256n : request.valueType === "i32" ? 32n : 64n;
    const signed = request.valueType.startsWith("i");
    if (n < (signed ? -(1n << (bits - 1n)) : 0n) || n >= (1n << (signed ? bits - 1n : bits))) throw new Error("IntegerOutOfRange");
    value = n.toString();
  } else if (request.valueType === "dec") {
    if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,18})?$/.test(value)) throw new Error("InvalidDecimal");
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    const units = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    const signed = negative ? -units : units;
    if (signed < -(1n << 255n) || signed >= (1n << 255n)) throw new Error("DecimalOutOfRange");
    const trimmed = fraction.replace(/0+$/, "");
    value = `${negative && units !== 0n ? "-" : ""}${BigInt(whole)}${trimmed ? "." + trimmed : ""}`;
  } else if (["addr", "key", "bytes32"].includes(request.valueType)) {
    const bytes = request.valueType === "addr" ? 20 : 32;
    if (typeof value !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw new Error("InvalidFixedBytes");
    value = value.toLowerCase();
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


export const ARKIV_TYPES: EqSelection["valueType"][] = ["bool", "i32", "u64", "u256", "dec", "bytes32", "str", "addr", "key"];
export function isArkivProfile(status: NativeSourceStatus | null | undefined) { return status?.capabilities?.profile === "arkiv-entity-v2"; }
const v2base: EqSelection = { ...base, height: "3" };
const sample = (id: string, label: string, title: string, explanation: string, changes: Partial<EqSelection>): QueryExample => ({id, label, title, explanation, request: {...v2base, ...changes}});
export const ARKIV_EXAMPLES: QueryExample[] = [
  sample("membership", "01 / Membership", "Five entities, one proof", "Block 3 contains five group = u64(1) entities. Fetch three, then verify the remaining two against the same root.", {}),
  sample("absence", "02 / Absence", "Prove an empty answer", "The missing typed value produces a verified absence path.", {value:"999999"}),
  sample("before-expiry", "03 / Before expiry", "Before the expiry boundary", "At block 13 four entities remain; one expires at block 14.", {height:"13"}),
  sample("after-expiry", "04 / After expiry", "After the expiry boundary", "At block 14 only three entities remain in the verified live set.", {height:"14"}),
  sample("owner", "05 / Ownership", "Find the transferred entity", "Alice creates the entity, transfers it to Bob at block 4, and Bob updates it at block 5. Creator stays Alice.", {height:"5",attribute:"$owner",valueType:"addr",value:"0x"+"b0".repeat(20)}),
  sample("creator", "06 / Creator", "Original creator survives transfer", "All five entities still have Alice as creator after the ownership transfer.", {height:"5",attribute:"$creator",valueType:"addr",value:"0x"+"a1".repeat(20)}),
  sample("decimal", "07 / Decimal", "Exact fixed-point values", "Signed decimals use 18 fractional digits and no floating-point conversion.", {attribute:"price",valueType:"dec",value:"-12.34567890123456789"}),
  sample("u256", "08 / Wide integer", "The largest unsigned integer", "Query the exact 256-bit maximum without rounding through JavaScript numbers.", {attribute:"quantity",valueType:"u256",value:((1n<<256n)-1n).toString()}),
  sample("content-type", "09 / Content type", "System string equality", "Query the committed content type. This is supported by this profile; current SDK query-builder support differs.", {attribute:"$contentType",valueType:"str",value:"application/json"}),
  sample("updated", "10 / Updated block", "Host-maintained modification time", "Only the entity patched by Bob at block 5 has this update height. Querying this field is an extension to the current Arkiv node.", {height:"5",attribute:"$updatedAt",valueType:"u64",value:"5"}),
  sample("reference", "11 / Entity reference", "Typed entity keys", "Entity references have a distinct key type; they are not interchangeable with bytes32.", {attribute:"reference",valueType:"key",value:"0x"+"77".repeat(32)}),
  sample("signed", "12 / Signed integer", "The smallest i32", "The signed 32-bit boundary is indexed with exact numeric ordering.", {attribute:"counter",valueType:"i32",value:"-2147483648"}),
];
export function queryExamples(status: NativeSourceStatus | null) { return isArkivProfile(status) ? ARKIV_EXAMPLES : QUERY_EXAMPLES; }
function validateEntities(page: InspectedPage) {
  requireInspection(Array.isArray(page.entities) && page.entities.length === page.rows.length);
  page.entities.forEach((e, index) => {
    requireInspection(record(e) && hash(e.key) && e.key === page.rows[index].recordKey &&
      typeof e.owner === "string" && /^0x[0-9a-f]{40}$/.test(e.owner) && typeof e.creator === "string" && /^0x[0-9a-f]{40}$/.test(e.creator) &&
      uint(e.createdAt) && uint(e.updatedAt) && uint(e.expiresAt) && e.expiresAt === page.rows[index].expiresAtHeight &&
      BigInt(e.createdAt) <= BigInt(e.updatedAt) && BigInt(e.updatedAt) <= BigInt(page.snapshot.height) && BigInt(e.expiresAt) > BigInt(page.snapshot.height) &&
      typeof e.contentType === "string" && new TextEncoder().encode(e.contentType).length <= 128 && hex(e.payload) && e.payload.length <= 2 + 131072*2 &&
      record(e.creationFlags) && natural(e.creationFlags.raw, 3) && e.creationFlags.readonly === ((e.creationFlags.raw & 1) !== 0) && e.creationFlags.permissionlessExtension === ((e.creationFlags.raw & 2) !== 0));
    const attrs = page.rows[index].attributes as Array<{name:string;value:unknown}>;
    for (const [name, value] of Object.entries({$key:e.key,$owner:e.owner,$creator:e.creator,$createdAt:e.createdAt,$updatedAt:e.updatedAt,$expiresAt:e.expiresAt,$contentType:e.contentType}))
      requireInspection(attrs.some(a => a.name === name && a.value === value));
  });
}
