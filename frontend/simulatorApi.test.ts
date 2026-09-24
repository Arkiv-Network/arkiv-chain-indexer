import { afterEach, describe, expect, test } from "bun:test";
import {
  NativeHttpError,
  retrySameControl,
  boundedJson,
  displayNative,
  fetchSourceKind,
  localVerifiedQuery,
  validateVerifiedPage,
  type EqSelection,
  type NativeIdentity,
} from "./src/simulatorApi";

const id: NativeIdentity = {
  sourceId: "00000000-0000-4000-8000-000000000001",
  runId: "22".repeat(16),
  genesisHash: "0x" + "33".repeat(32),
  chainId: "9001",
};
const request: EqSelection = {
  height: "9007199254740993",
  namespace: "1",
  attribute: "group",
  valueType: "u64",
  value: "18446744073709551615",
  limit: 3,
  cursor: null,
};
const page = () => ({
  ...id,
  verification:
    "proof verified against trusted simulator root; unsigned source",
  snapshot: {
    height: request.height,
    hash: "0x" + "44".repeat(32),
    stateRoot: "0x" + "55".repeat(32),
  },
  query: {
    namespace: "1",
    attribute: "group",
    valueType: "u64",
    value: request.value,
    limit: 3,
  },
  rows: [],
  continuation: null,
  postingCount: 0,
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("native result trust and binding", () => {
  test("a SQL badge or verified Boolean cannot become local proof verification", () => {
    expect(() =>
      validateVerifiedPage(
        { ...page(), verification: "unverified-projection", verified: true },
        id,
        request,
      ),
    ).toThrow();
    expect(() =>
      validateVerifiedPage({ verified: true, rows: [] }, id, request),
    ).toThrow();
    expect(validateVerifiedPage(page(), id, request).snapshot.height).toBe(
      "9007199254740993",
    );
    expect(displayNative("18446744073709551615")).toBe("18446744073709551615");
  });
  test("run, height, query, page size and root shape stay bound", () => {
    for (const value of [
      { ...page(), runId: "66".repeat(16) },
      { ...page(), snapshot: { ...page().snapshot, height: "4" } },
      { ...page(), snapshot: { ...page().snapshot, stateRoot: "0x00" } },
      { ...page(), query: { ...page().query, value: "1" } },
      { ...page(), query: { ...page().query, limit: 4 } },
      { ...page(), rows: [{}, {}, {}, {}] },
    ])
      expect(() => validateVerifiedPage(value, id, request)).toThrow();
  });
  test("only the configured same-origin local light path receives verification queries, without credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return Response.json(
        calls.length === 1 ? { ...id, role: "light" } : page(),
      );
    }) as unknown as typeof fetch;
    await localVerifiedQuery(id, request);
    expect(calls.map((c) => c.url)).toEqual([
      "/local-sim/v1/status",
      "/local-sim/v1/query/verified",
    ]);
    expect(calls.every((c) => c.init?.credentials === "omit")).toBe(true);
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual(request);
  });
  test("an unpinned source or non-light response stops before a proof query", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      ++calls;
      return Response.json({ ...id, role: "producer" });
    }) as unknown as typeof fetch;
    await expect(localVerifiedQuery(id, request)).rejects.toThrow(
      "LocalVerifierIdentityMismatch",
    );
    expect(calls).toBe(1);
  });
});

test("capability selection is explicit and unknown native modes never fall through to Ethereum", async () => {
  for (const [sourceKind, expected] of [
    ["arkiv-native-simulator", "native-simulator"],
    ["ethereum", "ethereum"],
  ] as const) {
    globalThis.fetch = (async () =>
      Response.json({ sourceKind })) as unknown as typeof fetch;
    expect(await fetchSourceKind()).toBe(expected);
  }
  globalThis.fetch = (async () =>
    Response.json({
      sourceKind: "unsigned-unknown-v2",
    })) as unknown as typeof fetch;
  await expect(fetchSourceKind()).rejects.toThrow("UnsupportedSourceKind");
});

test("stream byte bounds ignore a false Content-Length and reject before parsing", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(17));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    boundedJson(
      new Response(stream, { headers: { "content-length": "1" } }),
      16,
    ),
  ).rejects.toThrow("ResponseTooLarge");
  expect(cancelled).toBe(true);
});

test("only uncertain control outcomes retain the exact retry command", () => {
  for (const status of [400, 401, 403, 404, 409, 413, 422])
    expect(retrySameControl(new NativeHttpError(status, "Rejected"))).toBe(
      false,
    );
  for (const error of [
    new NativeHttpError(503, "CommitUncertain"),
    new NativeHttpError(429, "ServerBusy"),
    new Error("NetworkError"),
  ])
    expect(retrySameControl(error)).toBe(true);
});
