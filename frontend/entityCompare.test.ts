import { describe, expect, test } from "bun:test";
import type { EntityRecord, QueryPage } from "./src/dataQuery";
import { compareEntityPages, entityDifferences, speedupFactor, type ComparisonSide } from "./src/entityCompare";

function entity(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    key: `0x${"cb".repeat(32)}`,
    owner: `0x${"8f".repeat(20)}`,
    creator: `0x${"8f".repeat(20)}`,
    createdAt: 100,
    updatedAt: 120,
    expiresAt: 900,
    creationFlags: { readonly: false, permissionlessExtension: false, raw: 0 },
    contentType: "application/json",
    attributes: [{ name: "status", type: "str", value: "active" }],
    ...overrides,
  };
}

function page(entities: EntityRecord[], overrides: Partial<QueryPage> = {}): QueryPage {
  return { entities, blockNumber: 5000, cursor: null, ...overrides };
}

function side(page: QueryPage | null, durationMs = 10, error: unknown = null): ComparisonSide {
  return { durationMs, page, error };
}

describe("compareEntityPages", () => {
  test("two identical pages carry no differences", () => {
    const report = compareEntityPages(side(page([entity()]), 120), side(page([entity()]), 8));
    expect(report.identical).toBe(true);
    expect(report.differences).toEqual([]);
    expect(report.comparedEntities).toBe(1);
    expect(report.node).toEqual({ durationMs: 120, count: 1, hasMore: false, blockNumber: 5000, error: null });
    expect(report.index.durationMs).toBe(8);
  });

  test("a different entity count names the keys only one side has", () => {
    const extra = entity({ key: `0x${"ab".repeat(32)}` });
    const report = compareEntityPages(side(page([entity(), extra])), side(page([entity()])));
    expect(report.identical).toBe(false);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]!.scope).toBe("entities");
    expect(report.differences[0]!.detail).toContain("2 on the node vs 1 on the index");
    expect(report.differences[0]!.detail).toContain(`only node: 0x${"ab".repeat(32)}`);
    // A count mismatch stops before the field-by-field pass.
    expect(report.comparedEntities).toBe(0);
  });

  test("the same keys in a different order are reported by position", () => {
    const a = entity({ key: `0x${"aa".repeat(32)}` });
    const b = entity({ key: `0x${"bb".repeat(32)}` });
    const report = compareEntityPages(side(page([a, b])), side(page([b, a])));
    expect(report.differences.map((difference) => difference.scope)).toEqual(["order", "order"]);
    expect(report.differences[0]!.detail).toContain("position 0");
    expect(report.comparedEntities).toBe(0);
  });

  test("matching keys are compared field by field, under the entity's key", () => {
    const node = entity();
    const index = entity({ owner: `0x${"11".repeat(20)}`, expiresAt: 901 });
    const report = compareEntityPages(side(page([node])), side(page([index])));
    expect(report.differences.map((difference) => difference.scope)).toEqual([node.key, node.key]);
    expect(report.differences[0]!.detail).toContain("owner: node");
    expect(report.differences[1]!.detail).toBe("expiresAt: node 900 vs index 901");
  });

  test("a block mismatch is its own difference", () => {
    const report = compareEntityPages(side(page([entity()])), side(page([entity()], { blockNumber: 4999 })));
    expect(report.differences[0]).toEqual({
      scope: "block",
      detail: "node answered at block 5000, index at 4999",
    });
  });

  test("disagreeing about a next page is a difference", () => {
    const report = compareEntityPages(side(page([entity()], { cursor: "b64:abc" })), side(page([entity()])));
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]!.scope).toBe("paging");
    expect(report.node.hasMore).toBe(true);
    expect(report.index.hasMore).toBe(false);
  });

  test("one side failing is a difference; both failing the same way is not", () => {
    const failure = new Error("arkiv_query was rejected (-32602): bad query");
    const onlyIndex = compareEntityPages(side(page([entity()])), side(null, 5, failure));
    expect(onlyIndex.differences[0]!.detail).toContain("only the index failed");
    expect(onlyIndex.index.error).toBe(failure.message);
    expect(onlyIndex.index.count).toBeNull();

    const both = compareEntityPages(side(null, 5, failure), side(null, 5, new Error(failure.message)));
    expect(both.differences).toEqual([]);
    // Both failing is not a match either: there is nothing to call identical.
    expect(both.identical).toBe(false);

    const differently = compareEntityPages(side(null, 5, failure), side(null, 5, new Error("boom")));
    expect(differently.differences[0]!.detail).toContain("both endpoints failed, differently");
  });
});

describe("entityDifferences", () => {
  test("attributes are matched by name, not by position", () => {
    const node = entity({
      attributes: [
        { name: "status", type: "str", value: "active" },
        { name: "size", type: "u64", value: "12" },
      ],
    });
    const index = entity({
      attributes: [
        { name: "size", type: "u64", value: "12" },
        { name: "status", type: "str", value: "active" },
      ],
    });
    expect(entityDifferences(node, index)).toEqual([]);
  });

  test("a missing, extra or changed attribute is named", () => {
    const node = entity({ attributes: [{ name: "status", type: "str", value: "active" }] });
    const index = entity({ attributes: [{ name: "other", type: "str", value: "active" }] });
    expect(entityDifferences(node, index)).toEqual([
      "attribute status: only on the node",
      "attribute other: only on the index",
    ]);

    const changed = entity({ attributes: [{ name: "status", type: "str", value: "retired" }] });
    expect(entityDifferences(node, changed)).toEqual([
      "attribute status: node str(active) vs index str(retired)",
    ]);
  });

  test("creation flags missing on one side are reported once", () => {
    const node = entity();
    const index = entity({ creationFlags: null });
    expect(entityDifferences(node, index)).toEqual(["creationFlags: node 0 vs index none"]);
  });
});

describe("speedupFactor", () => {
  test("is the node's time over the index's, and null when a side failed", () => {
    const fast = compareEntityPages(side(page([entity()]), 120), side(page([entity()]), 10));
    expect(speedupFactor(fast)).toBeCloseTo(12, 5);

    const failed = compareEntityPages(side(page([entity()]), 120), side(null, 10, new Error("nope")));
    expect(speedupFactor(failed)).toBeNull();

    const instant = compareEntityPages(side(page([entity()]), 120), side(page([entity()]), 0));
    expect(speedupFactor(instant)).toBeNull();
  });
});
