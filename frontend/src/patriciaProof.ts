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
