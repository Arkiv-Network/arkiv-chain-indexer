import { afterEach, expect, test } from "bun:test";
import fixture from "./fixtures/range-inspection/price.json";
import { initialRangeInspection, inspectRange, validateRangeInspection } from "./src/rangeInspectionApi";
import type { RangeSelection } from "./src/rangeProofApi";
const request = fixture.query as RangeSelection;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("real range inspection preserves matching leaves and excluded boundary evidence", () => {
  const result = validateRangeInspection(fixture, fixture.identity, request);
  expect(result.rows.map(row => row.recordId)).toEqual(["47839", "47840"]);
  expect(result.inspection.interval.suppliedNodeCount).toBe(13);
  const leaves = result.inspection.interval.nodes.filter(node => node.leaf).map(node => [node.proofIndex, node.leaf?.value, node.leaf?.included]);
  expect(leaves).toEqual([[9, "10", true], [10, "15", true], [12, "20", false]]);
  expect(result.inspection.postingSets.map(term => term.recordIds)).toEqual([["47839"], ["47840"]]);
});

test("malformed or cross-bound range traces fail before tree rendering", () => {
  const mutations: Array<(data: any) => void> = [
    d => { d.inspection.proofProfile = "eq-page-v2"; },
    d => { d.inspection.stateComposition.stateRoot = "0x" + "00".repeat(32); },
    d => { d.canonicalProof = "0x0"; },
    d => { d.inspection.interval.root = "0x" + "00".repeat(32); },
    d => { d.inspection.interval.nodes[7].parentIndex = 7; },
    d => { d.inspection.interval.nodes[9].proofIndex = 10; },
    d => { d.inspection.interval.nodes[8].children[10].childIndex = 8; },
    d => { d.inspection.interval.nodes[8].children[10].childIndex = null; },
    d => { d.inspection.interval.nodes[8].children[10].hash = "0x" + "00".repeat(32); },
    d => { d.inspection.interval.nodes[8].children[11].decision = "open"; },
    d => { d.inspection.interval.nodes[12].leaf.included = true; },
    d => { d.inspection.interval.suppliedNodeCount = 12; },
    d => { d.inspection.interval.nodes[9].rlp = null; },
    d => { d.inspection.interval.nodes[9].leaf.postingRoot = "0x" + "00".repeat(32); },
    d => { d.inspection.postingSets[0].recordIds = ["47840"]; },
    d => { d.inspection.postingSets[0].termNodeIndex = 12; },
    d => { d.inspection.postingSets[0].termValue = "11"; },
    d => { d.inspection.pointPaths.pop(); },
    d => { d.inspection.pointPaths[1].root = "0x" + "00".repeat(32); },
    d => { d.inspection.interval.nodes.push({ ...d.inspection.interval.nodes[12], index: 13, proofIndex: 13 }); d.inspection.interval.suppliedNodeCount++; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(fixture); mutate(data);
    expect(() => validateRangeInspection(data, fixture.identity, request)).toThrow();
  }
});

test("inspection uses its own credential-free bounded route", async () => {
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    expect(url).toBe("/node-sim/v1/query/range/inspect");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(String(init.body))).toEqual(request);
    return Response.json(fixture);
  }) as typeof fetch;
  expect((await inspectRange(fixture.identity, request, new AbortController().signal)).inspection.postingSets).toHaveLength(2);
});

test("links from a verified result preserve its exact query and snapshot", () => {
  const linked = initialRangeInspection("50000", "?attribute=price&valueType=u64&namespace=1&height=42884&lower=10&lowerInclusive=true&upper=20&upperInclusive=false");
  expect(linked).toEqual(request);
  expect(initialRangeInspection("50000", "?range=price-empty")).toMatchObject({ height: "latest", lower: { value: "10", inclusive: false }, upper: { value: "15", inclusive: false } });
  expect(initialRangeInspection("50000", "?attribute=price&lower=20&lowerInclusive=false").upper).toBeUndefined();
});
