import { afterEach, describe, expect, test } from "bun:test";
import { fetchNodeBlock, fetchNodeStatus, inspectNodeQuery, pinSelection, QUERY_EXAMPLES, readableKey, validateInspectedPage } from "./src/nodeDebugApi";
import { uiMode, type EqSelection } from "./src/simulatorApi";
import fixture from "./fixtures/node-debug/membership.json";

const selection: EqSelection = { height: fixture.snapshot.height, ...fixture.query, valueType: "u64", cursor: null };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("dedicated node client", () => {
  test("the real hosted membership inspection has rows and its actual witness", () => {
    const result = validateInspectedPage(fixture, fixture, selection);
    expect(result.rows.map((row) => row.recordId)).toEqual(["3", "4", "5"]);
    expect(result.postingCount).toBe(5);
    expect(result.inspection.pointPaths).toHaveLength(8);
    expect(result.rows[0].attributes).toEqual([{ name: "group", type: "u64", value: "1" }]);
  });

  test("malformed or mismatched traces fail before the visualizer renders", () => {
    const mutations: Array<(page: any) => void> = [
      (p) => { p.runId = "different-run"; },
      (p) => { p.snapshot.height = "21"; },
      (p) => { p.query.value = "2"; },
      (p) => { p.inspection = {}; },
      (p) => { p.inspection.version = 2; },
      (p) => { p.inspection.stateComposition.stateRoot = "0x" + "00".repeat(32); },
      (p) => { p.inspection.stateComposition.namespace = null; },
      (p) => { p.inspection.pointPaths = [null]; },
      (p) => { p.inspection.pointPaths[0].root = "0x" + "00".repeat(32); },
      (p) => { p.inspection.pointPaths[1].nodes = [{ kind: "branch" }]; },
      (p) => { p.inspection.pointPaths[1].nodes[0].children[0].hash = {}; },
      (p) => { p.inspection.pointPaths[1].nodes[0].kind = ["extension"]; },
      (p) => { p.inspection.postingSet.recordIds = []; },
      (p) => { p.inspection.postingSet.selectedRecordIds.reverse(); },
      (p) => { p.inspection.postingSet.authenticatedRoot = "0x" + "00".repeat(32); },
      (p) => { p.rows[0].attributes = [null]; },
      (p) => { p.rows[0].fields[0].type = {}; },
      (p) => { p.rows[0].namespaceId = "2"; },
      (p) => { p.diagnostics.verifyMs = {}; },
      (p) => { p.canonicalProof = "0x0"; },
    ];
    for (const mutate of mutations) {
      const page = structuredClone(fixture);
      mutate(page);
      expect(() => validateInspectedPage(page, fixture, selection)).toThrow();
    }
  });

  test("inspection reads go directly to the same-origin node proxy without credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(fixture);
    }) as unknown as typeof fetch;
    await inspectNodeQuery(fixture, selection);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/node-sim/v1/query/inspect");
    expect(calls[0].init?.credentials).toBe("omit");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(selection);
  });

  test("status is role-bound and never calls explorer capabilities", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ ...fixture, role: "light", health: "following", paused: false, head: fixture.snapshot });
    }) as unknown as typeof fetch;
    expect((await fetchNodeStatus("lightnode")).role).toBe("light");
    await expect(fetchNodeStatus("fullnode")).rejects.toThrow("NodeIdentityMismatch");
    expect(calls).toEqual(["/node-sim/v1/status", "/node-sim/v1/status"]);
  });

  test("a block from another run is rejected", async () => {
    globalThis.fetch = (async () => Response.json({ ...fixture, runId: "old", header: { height: "20" }, transactions: [], operations: [], changes: [] })) as unknown as typeof fetch;
    await expect(fetchNodeBlock(fixture, "20")).rejects.toThrow("BlockIdentityMismatch");
  });

  test("latest resolves before querying; a continuation keeps the previous height and exact integer precision", () => {
    const first = pinSelection({ ...selection, height: "latest", value: "18446744073709551615" }, "9007199254740993");
    expect(first.height).toBe("9007199254740993");
    expect(first.value).toBe("18446744073709551615");
    const next = pinSelection({ ...first, cursor: fixture.continuation }, "9007199254740994");
    expect(next.height).toBe(first.height);
    expect(next.cursor).toBe(fixture.continuation);
    expect(() => pinSelection({ ...selection, height: "21" }, "20")).toThrow("BlockNotSynced");
    expect(() => pinSelection({ ...selection, value: "18446744073709551616" }, "20")).toThrow("IntegerOutOfRange");
    expect(() => pinSelection({ ...selection, valueType: "bool", value: "yes" }, "20")).toThrow("InvalidBoolean");
    expect(pinSelection({ ...selection, valueType: "bool", value: "false" }, "20").value).toBe(false);
  });

  test("examples pin reproducible snapshots and record labels decode only printable keys", () => {
    expect(QUERY_EXAMPLES.map((sample) => sample.request.height)).toEqual(["20", "20", "13", "14"]);
    expect(readableKey(fixture.rows[0].recordKey)).toBe("7-0-recreated");
    expect(readableKey("0xff00")).toBe("0xff00");
  });

  test("node modes are explicitly selected without changing explorer defaults", () => {
    const globals = globalThis as unknown as { window?: { __ARKIV_CONFIG__: Record<string, string> } };
    const before = globals.window;
    try {
      for (const mode of ["fullnode", "lightnode", "debug", "explorer"] as const) {
        globals.window = { __ARKIV_CONFIG__: { VITE_UI_MODE: mode } };
        expect(uiMode()).toBe(mode);
      }
      globals.window = { __ARKIV_CONFIG__: { VITE_UI_MODE: "unknown" } };
      expect(uiMode()).toBe("explorer");
    } finally {
      if (before) globals.window = before;
      else delete globals.window;
    }
  });
});
