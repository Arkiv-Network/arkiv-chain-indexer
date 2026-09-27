import { validateInspectionPaths } from "./nodeDebugApi";
import { validateRangeResponse, rangeExamples, type RangeResponse, type RangeSelection } from "./rangeProofApi";
import { boundedJson, type NativeIdentity } from "./simulatorApi";
import type { RangeProofInspection } from "./patriciaProof";

export interface InspectedRange extends RangeResponse {
  canonicalRequest: string;
  canonicalProof: string;
  inspection: RangeProofInspection;
}
export function initialRangeInspection(head: string, search: string): RangeSelection {
  const params = new URLSearchParams(search);
  const examples = rangeExamples(head);
  const preset = examples.find(example => example.id === params.get("range")) ?? examples[0];
  if (!params.has("attribute")) return { ...preset.request, height: "latest" };
  const lower = params.get("lower"); const upper = params.get("upper");
  return {
    height: params.get("height") ?? "latest", namespace: params.get("namespace") ?? "1",
    attribute: params.get("attribute") ?? "", valueType: (params.get("valueType") ?? "u64") as RangeSelection["valueType"],
    lower: lower ? { value: lower, inclusive: params.get("lowerInclusive") !== "false" } : undefined,
    upper: upper ? { value: upper, inclusive: params.get("upperInclusive") !== "false" } : undefined,
  };
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const hex = (v: unknown): v is string => typeof v === "string" && /^0x(?:[0-9a-f]{2})*$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const uint = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v);
const natural = (v: unknown, max = 8192): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const nibbles = (v: unknown): v is string => typeof v === "string" && v.length <= 4096 && /^[0-9a-f]*$/.test(v);
const slot = (v: unknown) => v === null || typeof v === "string" && /^[0-9a-f]$/.test(v);
const map = (v: unknown) => object(v) && hash(v.root) && uint(v.entries);
function requireTrace(ok: unknown): asserts ok { if (!ok) throw new Error("InvalidRangeInspection"); }

/** Transport structure and cross-bindings only: cryptographic verification remains in Rust. */
export function validateRangeInspection(data: unknown, identity: NativeIdentity, request: RangeSelection): InspectedRange {
  const response = validateRangeResponse(data, identity, request);
  requireTrace(object(data) && hex(data.canonicalRequest) && data.canonicalRequest.length > 2 && data.canonicalRequest.length <= 8194 &&
    hex(data.canonicalProof) && data.canonicalProof.length > 2 && data.canonicalProof.length <= 2 * 1024 * 1024 + 2 && object(data.inspection));
  const i = data.inspection;
  requireTrace(i.version === 2 && i.proofProfile === "range-complete-v1" && hash(i.queryDigest) && i.postingSet === null);
  const state = i.stateComposition;
  requireTrace(object(state) && state.stateRoot === response.snapshot.stateRoot && state.domain === "arkiv/state/v1" &&
    hex(state.headerBytes) && hex(state.pricingBytes) && uint(state.nextNamespace) && map(state.catalog) && map(state.host));
  const ns = state.namespace;
  requireTrace(object(ns) && ns.id === request.namespace && uint(ns.nextRecord) && [ns.records, ns.rows, ns.keys, ns.terms].every(map));
  validateInspectionPaths(i.pointPaths, state, request.namespace, 1 + response.rows.length * 2);
  requireTrace(i.pointPaths.length === 1 + response.rows.length * 2 && i.pointPaths.filter((p: any) => p.map === "catalog").length === 1);
  for (const row of response.rows) for (const name of ["rows", "keys"]) {
    requireTrace(i.pointPaths.filter((p: any) => p.map === name && p.recordId === row.recordId).length === 1);
  }
  const interval = i.interval;
  requireTrace(object(interval) && interval.id === "terms:range" && interval.map === "terms" && interval.namespaceId === request.namespace &&
    interval.root === ns.terms.root && hex(interval.lowerKey) && hex(interval.upperKey) &&
    interval.lowerKeyNibbles === interval.lowerKey.slice(2) && interval.upperKeyNibbles === interval.upperKey.slice(2) &&
    natural(interval.suppliedNodeCount) && [null, "reversed-bounds", "empty-root"].includes(interval.emptyReason) &&
    Array.isArray(interval.nodes) && interval.nodes.length <= 16384);
  const nodes = interval.nodes;
  requireTrace(interval.emptyReason === null ? nodes.length > 0 : nodes.length === 0 && interval.suppliedNodeCount === 0 && response.rows.length === 0);
  let supplied = 0;
  const parents = new Map<number, number>();
  nodes.forEach((node: any, index: number) => {
    requireTrace(object(node) && node.index === index && natural(node.proofIndex) && natural(node.depth, 4096) &&
      ["root", "hash", "inline"].includes(node.source) && hash(node.hash) && hex(node.rlp) && node.rlp.length > 2 &&
      ["branch", "extension", "leaf"].includes(node.kind) && nibbles(node.prefix) && nibbles(node.compressedPath) &&
      node.selectedNibble === null && uint(node.valueBytes) && slot(node.parentSlot) &&
      (index === 0 ? node.parentIndex === null && node.source === "root" && node.hash === interval.root : natural(node.parentIndex, index - 1) && node.source !== "root") &&
      Array.isArray(node.children) && node.children.length === (node.kind === "branch" ? 16 : node.kind === "extension" ? 1 : 0));
    if (node.source !== "inline") requireTrace(node.proofIndex === supplied++);
    else requireTrace(node.proofIndex < supplied && node.proofIndex === nodes[node.parentIndex].proofIndex);
    node.children.forEach((child: any, childSlot: number) => {
      requireTrace(object(child) && slot(child.slot) && child.slot === (node.kind === "branch" ? childSlot.toString(16) : null) &&
        ["empty", "hash", "inline"].includes(child.kind) && ["open", "outside", "empty"].includes(child.decision) &&
        (child.hash === undefined || hash(child.hash)) && (child.rlp === undefined || hex(child.rlp)) &&
        (child.kind !== "hash" || hash(child.hash)) && (child.kind !== "inline" || hex(child.rlp)));
      requireTrace(child.decision === "empty" ? child.kind === "empty" && child.childIndex === null :
        child.decision === "outside" ? child.childIndex === null : child.kind !== "empty" && natural(child.childIndex, nodes.length - 1) && child.childIndex > index);
      if (child.childIndex !== null) {
        const target = nodes[child.childIndex];
        requireTrace(object(target) && target.parentIndex === index && target.parentSlot === child.slot && !parents.has(child.childIndex));
        requireTrace(child.kind === "hash" ? target.hash === child.hash && target.source === "hash" : target.rlp === child.rlp && target.source === "inline");
        parents.set(child.childIndex, index);
      }
    });
    if (node.kind === "leaf" && node.leaf !== null) {
      const leaf = node.leaf;
      requireTrace(object(leaf) && hex(leaf.key) && typeof leaf.attribute === "string" && leaf.attribute.length <= 32 &&
        typeof leaf.valueType === "string" && (leaf.value === null || ["string", "boolean"].includes(typeof leaf.value)) && typeof leaf.included === "boolean" &&
        hash(leaf.postingRoot) && natural(leaf.postingCount, Number.MAX_SAFE_INTEGER));
      if (leaf.included) requireTrace(leaf.attribute === request.attribute && leaf.valueType === request.valueType);
    } else requireTrace(node.leaf === null);
  });
  requireTrace(supplied === interval.suppliedNodeCount && parents.size === Math.max(0, nodes.length - 1));
  requireTrace(Array.isArray(i.postingSets) && i.postingSets.length === response.termCount);
  const allIds = new Set<string>();
  const termNodes = new Set<number>();
  for (const posting of i.postingSets) {
    requireTrace(object(posting) && natural(posting.termNodeIndex, nodes.length - 1) && !termNodes.has(posting.termNodeIndex) &&
      hex(posting.termKey) && typeof posting.termValue === "string" && posting.termType === request.valueType &&
      posting.method === "complete-set-reconstruction" && posting.termPresent === true && hash(posting.authenticatedRoot) &&
      posting.reconstructedRoot === posting.authenticatedRoot && natural(posting.count, response.rows.length) && posting.count > 0 &&
      Array.isArray(posting.recordIds) && posting.recordIds.length === posting.count && posting.recordIds.every(uint) &&
      Array.isArray(posting.selectedRecordIds) && JSON.stringify(posting.recordIds) === JSON.stringify(posting.selectedRecordIds));
    const leaf = nodes[posting.termNodeIndex].leaf;
    requireTrace(leaf && leaf.included && leaf.key === posting.termKey && leaf.value === posting.termValue && leaf.valueType === posting.termType &&
      leaf.postingRoot === posting.authenticatedRoot && leaf.postingCount === posting.count);
    termNodes.add(posting.termNodeIndex);
    let previous = -1n;
    for (const id of posting.recordIds) {
      requireTrace(!allIds.has(id) && BigInt(id) > previous);
      previous = BigInt(id); allIds.add(id);
      const row = response.rows.find(row => row.recordId === id);
      requireTrace(row && (row.attributes as any[]).some(a => a.name === request.attribute && a.type === request.valueType && a.value === posting.termValue));
    }
  }
  requireTrace(nodes.filter((node: any) => node.leaf?.included).length === termNodes.size && allIds.size === response.rows.length && response.rows.every(row => allIds.has(String(row.recordId))));
  return data as unknown as InspectedRange;
}

export async function inspectRange(identity: NativeIdentity, request: RangeSelection, signal: AbortSignal) {
  const response = await fetch("/node-sim/v1/query/range/inspect", {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", cache: "no-store",
    body: JSON.stringify(request), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  return validateRangeInspection(await boundedJson(response, 8 * 1024 * 1024), identity, request);
}
