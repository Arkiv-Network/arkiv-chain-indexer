// The Data page's "Both" mode sends one query to the node's relay and the same
// query to the experimental entity index, then says where the two answers part
// company. This is the browser-side twin of `scripts/compareEntityQuery.ts`:
// same order of checks (error, block, key set, key order, then field by field)
// so a difference reported here reads like a difference reported there. Keep
// React out of this module so `bun test` can exercise it.

import type { EntityAttribute, EntityRecord, QueryPage } from "./dataQuery";

/** One endpoint's answer to the compared query, and what it cost. */
export interface ComparisonSide {
  /** Wall-clock time of the `arkiv_query` call, in ms. */
  durationMs: number;
  /** The decoded page, or null when the call failed. */
  page: QueryPage | null;
  error: unknown | null;
}

export interface EntityDifference {
  /** The entity key the difference is about, or a word for the part of the answer that differs. */
  scope: string;
  detail: string;
}

export interface ComparisonSideReport {
  durationMs: number;
  /** Entities on the page, or null when the call failed. */
  count: number | null;
  /** Whether the endpoint says a next page exists; null when the call failed. */
  hasMore: boolean | null;
  blockNumber: number | null;
  error: string | null;
}

export interface ComparisonReport {
  node: ComparisonSideReport;
  index: ComparisonSideReport;
  differences: EntityDifference[];
  /** How many entities were compared field by field. */
  comparedEntities: number;
  /** No difference anywhere, and both sides answered. */
  identical: boolean;
}

/** Enough to see the shape of a divergence without flooding the panel. */
const MAX_DIFFERENCES = 25;
const MAX_ORDER_DIFFERENCES = 3;
const MAX_KEYS_LISTED = 3;

function errorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  return error instanceof Error ? error.message : String(error);
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "none";
  return String(value);
}

function listKeys(keys: string[]): string {
  const head = keys.slice(0, MAX_KEYS_LISTED).join(", ");
  return keys.length > MAX_KEYS_LISTED ? `${head} (+${keys.length - MAX_KEYS_LISTED})` : head;
}

function attributeMap(attributes: EntityAttribute[]): Map<string, EntityAttribute> {
  return new Map(attributes.map((attribute) => [attribute.name, attribute]));
}

/**
 * Every field of one entity that the two sides render differently. Attributes
 * are matched by name rather than by position, so a reordering is not reported
 * as a difference — only a missing, extra or changed attribute is.
 */
export function entityDifferences(node: EntityRecord, index: EntityRecord): string[] {
  const out: string[] = [];
  const scalar = (name: string, a: unknown, b: unknown) => {
    if (a !== b) out.push(`${name}: node ${show(a)} vs index ${show(b)}`);
  };

  scalar("owner", node.owner, index.owner);
  scalar("creator", node.creator, index.creator);
  scalar("createdAt", node.createdAt, index.createdAt);
  scalar("updatedAt", node.updatedAt, index.updatedAt);
  scalar("expiresAt", node.expiresAt, index.expiresAt);
  scalar("contentType", node.contentType, index.contentType);

  if ((node.creationFlags === null) !== (index.creationFlags === null)) {
    scalar("creationFlags", node.creationFlags?.raw ?? null, index.creationFlags?.raw ?? null);
  } else if (node.creationFlags && index.creationFlags) {
    scalar("creationFlags.raw", node.creationFlags.raw, index.creationFlags.raw);
  }

  const nodeAttributes = attributeMap(node.attributes);
  const indexAttributes = attributeMap(index.attributes);
  for (const [name, attribute] of nodeAttributes) {
    const other = indexAttributes.get(name);
    if (!other) {
      out.push(`attribute ${name}: only on the node`);
      continue;
    }
    if (attribute.type !== other.type || attribute.value !== other.value) {
      out.push(`attribute ${name}: node ${attribute.type}(${attribute.value}) vs index ${other.type}(${other.value})`);
    }
  }
  for (const name of indexAttributes.keys()) {
    if (!nodeAttributes.has(name)) out.push(`attribute ${name}: only on the index`);
  }
  return out;
}

function sideReport(side: ComparisonSide): ComparisonSideReport {
  return {
    durationMs: side.durationMs,
    count: side.page ? side.page.entities.length : null,
    hasMore: side.page ? side.page.cursor !== null : null,
    blockNumber: side.page ? side.page.blockNumber : null,
    error: side.error === null || side.error === undefined ? null : errorText(side.error),
  };
}

/**
 * Compares the page the node answered with the page the index answered. Both
 * sides must have been asked for the same block: the caller pins `atBlock`,
 * because otherwise the index's lag alone reads as a wall of differences.
 */
export function compareEntityPages(node: ComparisonSide, index: ComparisonSide): ComparisonReport {
  const differences: EntityDifference[] = [];
  const add = (scope: string, detail: string) => {
    if (differences.length < MAX_DIFFERENCES) differences.push({ scope, detail });
  };

  const report: ComparisonReport = {
    node: sideReport(node),
    index: sideReport(index),
    differences,
    comparedEntities: 0,
    identical: false,
  };

  if (node.page === null || index.page === null) {
    if (node.page === null && index.page === null) {
      const a = errorText(node.error);
      const b = errorText(index.error);
      if (a !== b) add("request", `both endpoints failed, differently: node ${a}; index ${b}`);
    } else if (node.page === null) {
      add("request", `only the node failed: ${errorText(node.error)}`);
    } else {
      add("request", `only the index failed: ${errorText(index.error)}`);
    }
    return report;
  }

  if (node.page.blockNumber !== index.page.blockNumber) {
    add("block", `node answered at block ${node.page.blockNumber}, index at ${index.page.blockNumber}`);
  }

  const nodeKeys = node.page.entities.map((entity) => entity.key);
  const indexKeys = index.page.entities.map((entity) => entity.key);

  if (nodeKeys.length !== indexKeys.length) {
    const nodeSet = new Set(nodeKeys);
    const indexSet = new Set(indexKeys);
    const onlyNode = nodeKeys.filter((key) => !indexSet.has(key));
    const onlyIndex = indexKeys.filter((key) => !nodeSet.has(key));
    add(
      "entities",
      `${nodeKeys.length} on the node vs ${indexKeys.length} on the index` +
        (onlyNode.length ? `; only node: ${listKeys(onlyNode)}` : "") +
        (onlyIndex.length ? `; only index: ${listKeys(onlyIndex)}` : ""),
    );
  } else {
    let orderDifferences = 0;
    for (let i = 0; i < nodeKeys.length; i++) {
      if (nodeKeys[i] !== indexKeys[i]) {
        if (orderDifferences < MAX_ORDER_DIFFERENCES) {
          add("order", `position ${i}: node ${nodeKeys[i]} vs index ${indexKeys[i]}`);
        }
        orderDifferences += 1;
      }
    }
    if (orderDifferences > MAX_ORDER_DIFFERENCES) {
      add("order", `…and ${orderDifferences - MAX_ORDER_DIFFERENCES} more positions differ`);
    }
    if (orderDifferences === 0) {
      report.comparedEntities = nodeKeys.length;
      for (let i = 0; i < node.page.entities.length; i++) {
        for (const detail of entityDifferences(node.page.entities[i]!, index.page.entities[i]!)) {
          add(nodeKeys[i]!, detail);
        }
      }
    }
  }

  const nodeHasMore = node.page.cursor !== null;
  const indexHasMore = index.page.cursor !== null;
  if (nodeHasMore !== indexHasMore) {
    add("paging", `node ${nodeHasMore ? "has" : "has no"} next page, index ${indexHasMore ? "has" : "has no"} next page`);
  }

  report.identical = differences.length === 0;
  return report;
}

/** How much faster the index answered, as a `×` factor; null when the ratio says nothing. */
export function speedupFactor(report: ComparisonReport): number | null {
  const { durationMs: node } = report.node;
  const { durationMs: index } = report.index;
  if (report.node.error !== null || report.index.error !== null) return null;
  if (index <= 0 || node <= 0) return null;
  return node / index;
}

/**
 * How far the experimental index may trail the node before a comparison stops
 * following it. Within this, both sides are pinned to the index's head; beyond
 * it, the node's head is used and the index reports the lag as its own error.
 */
export const MAX_COMPARE_LAG_BLOCKS = 100;

/**
 * The block both sides of a comparison are pinned to: the index's head while
 * it is within {@link MAX_COMPARE_LAG_BLOCKS} of the node's, else the node's;
 * whichever side answered when only one did; nothing when neither did.
 */
export function pickComparisonBlock(nodeHead: number | undefined, indexHead: number | undefined): number | undefined {
  if (nodeHead === undefined) return indexHead;
  if (indexHead === undefined) return nodeHead;
  if (indexHead >= nodeHead) return nodeHead;
  return nodeHead - indexHead <= MAX_COMPARE_LAG_BLOCKS ? indexHead : nodeHead;
}
