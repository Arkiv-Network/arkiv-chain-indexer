/** Versioned trace returned only after the node's strict equality verifier succeeds. */
export interface ProofInspection {
  version: 1 | 2;
  proofProfile: "eq-page-v1" | "eq-page-v2";
  queryDigest: string;
  stateComposition: {
    stateRoot: string;
    domain: "arkiv/state/v1";
    headerBytes: string;
    catalog: MapCommitment;
    host: MapCommitment;
    nextNamespace: string;
    pricingBytes: string;
    namespace: null | {
      id: string;
      nextRecord: string;
      records: MapCommitment;
      keys: MapCommitment;
      rows: MapCommitment;
      terms: MapCommitment;
    };
  };
  pointPaths: PatriciaPointPath[];
  postingSet: null | {
    method: "complete-set-reconstruction";
    authenticatedRoot: string | null;
    reconstructedRoot: string;
    count: number;
    recordIds: string[];
    selectedRecordIds: string[];
    termPresent: boolean;
  };
}

export interface MapCommitment {
  root: string;
  entries: string;
}

export type PatriciaMap = "catalog" | "terms" | "rows" | "keys";
export type PatriciaTerminal = "leaf-match" | "empty-root" | "divergent-leaf" | "divergent-extension" | "empty-branch-slot";

export interface PatriciaPointPath {
  id: string;
  map: PatriciaMap;
  namespaceId: string | null;
  recordId: string | null;
  root: string;
  key: string;
  keyNibbles: string;
  suppliedNodeCount: number;
  terminal: { kind: "inclusion" | "absence"; reason: PatriciaTerminal };
  nodes: PatriciaPathNode[];
}

export interface PatriciaChild {
  slot: string | null;
  kind: "empty" | "hash" | "inline";
  hash?: string;
  rlp?: string;
}

export interface PatriciaPathNode {
  index: number;
  proofIndex: number;
  depth: number;
  source: "root" | "hash" | "inline";
  hash: string;
  rlp: string;
  kind: "branch" | "extension" | "leaf";
  compressedPath: string;
  selectedNibble: string | null;
  children: PatriciaChild[];
  valueBytes: string;
}

export const PATRICIA_NODE_PAGE_SIZE = 24;
export const PATRICIA_PATH_PAGE_SIZE = 48;
export const PATRICIA_POSTING_PAGE_SIZE = 64;

export function shortProofHex(value: string, width = 10): string {
  return value.length <= width * 2 + 1 ? value : `${value.slice(0, width)}…${value.slice(-width)}`;
}

export function proofHexBytes(value: string): number {
  return Math.floor(value.replace(/^0x/, "").length / 2);
}

/** A selected empty slot is evidence of absence, never an omitted hash child. */
export function describeTerminal(path: PatriciaPointPath): string {
  switch (path.terminal.reason) {
    case "leaf-match": return "The leaf's remaining nibbles match the lookup key. Its value is included under this map root.";
    case "empty-root": return "This is the canonical empty map root. No witness nodes are required to establish absence.";
    case "divergent-leaf": return "The leaf's remaining nibbles differ from the lookup key. This authenticated divergence proves absence.";
    case "divergent-extension": return "The compressed extension differs from the lookup key. This authenticated divergence proves absence.";
    case "empty-branch-slot": return "The branch slot selected by the next key nibble is empty. This authenticated empty slot proves absence.";
  }
}

export function nodeNibbleSpan(node: PatriciaPathNode): number {
  return node.kind === "branch" ? (node.selectedNibble === null ? 0 : 1) : node.compressedPath.length;
}

/** Return actual slot references only; this must never fill out a synthetic tree. */
export function siblingCommitments(node: PatriciaPathNode): PatriciaChild[] {
  if (node.kind !== "branch") return [];
  return node.children.filter((child) => child.kind !== "empty" && child.slot !== node.selectedNibble);
}

export function pointPathLabel(path: PatriciaPointPath): string {
  const record = path.recordId === null ? "" : ` · record ${path.recordId}`;
  return `${path.map[0].toUpperCase()}${path.map.slice(1)}${record} · ${path.terminal.kind}`;
}

export function defaultPointPath(paths: PatriciaPointPath[]): PatriciaPointPath | undefined {
  return paths.find((path) => path.map === "terms") ?? paths[0];
}

/** Range traces are decoded only after strict complete-range verification. */
export interface RangeProofInspection extends Omit<ProofInspection, "proofProfile" | "postingSet"> {
  proofProfile: "range-complete-v1";
  postingSet: null;
  postingSets: Array<NonNullable<ProofInspection["postingSet"]> & {
    termNodeIndex: number;
    termKey: string;
    termValue: string;
    termType: string;
    termPresent: true;
    authenticatedRoot: string;
  }>;
  interval: {
    id: "terms:range";
    map: "terms";
    namespaceId: string;
    root: string;
    lowerKey: string;
    upperKey: string;
    lowerKeyNibbles: string;
    upperKeyNibbles: string;
    suppliedNodeCount: number;
    emptyReason: null | "reversed-bounds" | "empty-root";
    nodes: RangePathNode[];
  };
}
export interface RangeChild extends PatriciaChild {
  decision: "open" | "outside" | "empty";
  childIndex: number | null;
}
export interface RangePathNode extends Omit<PatriciaPathNode, "children"> {
  parentIndex: number | null;
  parentSlot: string | null;
  prefix: string;
  children: RangeChild[];
  leaf: null | {
    key: string;
    attribute: string;
    valueType: string;
    value: string | boolean | null;
    included: boolean;
    postingRoot: string;
    postingCount: number;
  };
}
export type AnyProofInspection = ProofInspection | RangeProofInspection;

/** Inline nodes belong to their supplied ancestor; they never mint a new W entry. */
export function rangeWitnessNodes(nodes: RangePathNode[]): RangePathNode[] {
  return nodes.filter(node => node.source !== "inline");
}
export function rangeNodeExplanation(node: RangePathNode): string {
  if (node.leaf) return node.leaf.included
    ? "This leaf's full indexed key is inside the requested interval. Its complete posting set contributes to the answer."
    : "This boundary leaf was opened because its parent prefix could intersect the interval. Its full key lies outside the bounds, so it contributes no result.";
  return node.kind === "extension"
    ? "This node compresses a shared key prefix. The verifier checks whether that prefix can still lead to an indexed key inside the interval."
    : "This branch authenticates all 16 next-nibble slots. Every populated child whose key prefix overlaps the interval is opened; outside prefixes stay committed and unopened.";
}
export function rangeChildExplanation(child: RangeChild): string {
  return child.decision === "empty"
    ? "The authenticated parent contains an empty slot. There is no subtree here; this is different from an unopened hash."
    : child.decision === "outside"
      ? "This child's key prefix cannot intersect the encoded query interval. Its reference remains authenticated by the parent, but its subtree need not be opened."
      : "This child's key prefix can intersect the interval. The verifier opens its node and checks its reference; a leaf may still fall outside the exact bounds.";
}

/** A bounded visible subtree. Remaining real child references become navigation links. */
export function rangeTreeWindow(nodes: RangePathNode[], rootIndex: number, maxDepth = 3, maxNodes = 32): Set<number> {
  const byIndex = new Map(nodes.map(node => [node.index, node]));
  const shown = new Set<number>();
  const queue: Array<[number, number]> = [[rootIndex, 0]];
  for (let cursor = 0; cursor < queue.length && shown.size < maxNodes; cursor++) {
    const [index, depth] = queue[cursor];
    const node = byIndex.get(index);
    if (!node || shown.has(index)) continue;
    shown.add(index);
    if (depth >= maxDepth) continue;
    for (const child of node.children) if (child.decision === "open" && child.childIndex !== null) queue.push([child.childIndex, depth + 1]);
  }
  return shown;
}
