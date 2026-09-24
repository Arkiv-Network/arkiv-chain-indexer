import { describe, expect, test } from "bun:test";
import { boundedJson, decimal, integer, signed } from "./common";
import { parseSimulatorConfig, sourceKind } from "./config";
import { parseFeedBlock, parseStatus, FEED_CAP } from "./wire";
import { genesis, history, status, ZERO } from "./testFixtures";
import { parsePredicate, predicateSql, SqlArgs } from "./query";
import { HttpSimulatorSource } from "./source";
describe("native simulator wire", () => {
  test("canonical header and exact u64/i64 metadata survive", () => {
    for (const b of history()) expect(parseFeedBlock(b)).toEqual(b);
    expect(parseStatus(status(genesis()))).toEqual(status(genesis()));
    expect(decimal("18446744073709551615")).toBe("18446744073709551615");
    expect(signed("-9223372036854775808")).toBe("-9223372036854775808");
  });
  test("rejects full calldata/field values and unknown versions/keys before persistence", () => {
    const b = history()[1]!;
    for (const mutated of [
      { ...b, input: "SECRET" },
      { ...b, feedVersion: 2 },
      { ...b, transactions: [{ ...b.transactions[0], payload: "SECRET" }] },
      {
        ...b,
        changes: [
          {
            ...b.changes[2],
            fields: [
              {
                name: "payload",
                type: "bytes",
                byteLength: "6",
                digest: ZERO,
                reference: null,
                value: "SECRET",
              },
            ],
          },
        ],
      },
    ])
      expect(() => parseFeedBlock(mutated)).toThrow();
  });
  test("hash/root/height, integer and receipt tampering fail closed", () => {
    const b = history()[1]!;
    expect(() =>
      parseFeedBlock({ ...b, header: { ...b.header, stateRoot: ZERO } }),
    ).toThrow("InvalidHeader");
    expect(() => parseFeedBlock({ ...b, spentUnits: "0" })).toThrow(
      "InvalidOutcome",
    );
    for (const x of [1, "01", "1e3", "18446744073709551616", "-1"])
      expect(() => decimal(x)).toThrow();
    for (const x of ["-0", "9223372036854775808", "-9223372036854775809"])
      expect(() => signed(x)).toThrow();
    expect(() =>
      parseFeedBlock({
        ...b,
        transactions: [{ ...b.transactions[0], status: "failed" }],
      }),
    ).toThrow("InvalidOutcome");
  });
  test("bounded streaming read ignores lying short content length and invalid UTF8", async () => {
    const chunks = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    await expect(
      boundedJson(
        new Response(chunks, { headers: { "content-length": "1" } }),
        10,
      ),
    ).rejects.toThrow("LimitExceeded");
    await expect(
      boundedJson(new Response(new Uint8Array([0xff])), 10),
    ).rejects.toThrow();
    await expect(
      boundedJson(
        new Response("{}", {
          headers: { "content-length": String(FEED_CAP + 1) },
        }),
        FEED_CAP,
      ),
    ).rejects.toThrow("LimitExceeded");
  });
  test("source pins identity, height, byte cap and never relays upstream body", async () => {
    const g = genesis();
    const source = new HttpSimulatorSource("http://source", g, async (r) =>
      Response.json(r.url.endsWith("status") ? status(g) : g),
    );
    expect((await source.block("0")).header.hash).toBe(g.header.hash);
    await expect(source.block("1")).rejects.toThrow("InvalidHeader");
    const wrong = new HttpSimulatorSource(
      "http://source",
      { ...g, runId: "22".repeat(16) },
      async () => Response.json(g),
    );
    await expect(wrong.block("0")).rejects.toThrow("IdentityMismatch");
    const bad = new HttpSimulatorSource(
      "http://source",
      g,
      async () => new Response("secret calldata", { status: 500 }),
    );
    await expect(bad.block("0")).rejects.toThrow("UpstreamUnavailable");
  });
  test("typed bounded query compiler parameterizes values and keeps missing attributes false", () => {
    const p = new SqlArgs();
    const q = parsePredicate({
      op: "not",
      arg: {
        op: "eq",
        attribute: { name: "text", type: "str", value: "'; DROP TABLE x; --" },
      },
    });
    const sql = predicateSql(q, '"sim_test"', p);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).not.toContain("DROP");
    expect(p.values).toContainEqual(Buffer.from("'; DROP TABLE x; --"));
    expect(() =>
      parsePredicate({
        op: "prefix",
        attribute: { name: "n", type: "u64", value: "2" },
      }),
    ).toThrow("UnsupportedQuery");
    expect(() =>
      parsePredicate({
        op: "and",
        args: Array(9).fill({ op: "exists", name: "n" }),
      }),
    ).toThrow("LimitExceeded");
  });
  test("Ethereum default and native explicit pinned identity without RPC config", () => {
    expect(sourceKind({})).toBe("ethereum");
    expect(() => sourceKind({ SOURCE_KIND: "typo" })).toThrow();
    const g = genesis();
    expect(
      parseSimulatorConfig({
        DATABASE_URL: "postgres://test",
        SIMULATOR_URL: "http://producer:8080",
        SIMULATOR_ALLOW_PRIVATE_HTTP: "true",
        SIMULATOR_SOURCE_ID: g.sourceId,
        SIMULATOR_RUN_ID: g.runId,
        SIMULATOR_GENESIS_HASH: g.genesisHash,
        SIMULATOR_CHAIN_ID: g.chainId,
      }).feedUrl,
    ).toBe("http://producer:8080");
  });
});

describe("binary feed metadata commitment", () => {
  test("shared Rust golden codec and hash are independent of JSON/object insertion order", async () => {
    const { encodeFeedValue, feedDigest } = await import("./feedDigest");
    const value = {
      z: [null, false, true, 4294967295],
      é: "a\u0000",
      a: "9007199254740993",
    };
    expect(encodeFeedValue(value).toString("hex")).toBe(
      "060000000304000000016104000000103930303731393932353437343039393304000000017a050000000400010203ffffffff0400000002c3a904000000026100",
    );
    expect(feedDigest(value)).toBe(
      "0xf0db2b45a68f5c2f427351f89e2aa35072cff97bea42f76262038225be3341b6",
    );
    expect(feedDigest({ a: value.a, é: value.é, z: value.z })).toBe(
      feedDigest(value),
    );
    expect(() => encodeFeedValue(value, 16)).toThrow("LimitExceeded");
    expect(() => encodeFeedValue(4294967296)).toThrow();
  });
  test("changed redacted metadata cannot reuse old feed digest; changes cannot originate in rollback", () => {
    const b = history()[1]!,
      changed = structuredClone(b);
    (changed.changes[0] as any).name = "altered";
    expect(() => parseFeedBlock(changed)).toThrow("InvalidFeedDigest");
    const missing = { ...b, changes: b.changes.slice(1) };
    expect(() => parseFeedBlock(missing)).toThrow("InvalidProjection");
    const injected = {
      ...b,
      changes: [
        ...b.changes,
        { kind: "rawDelete", namespaceId: "1", key: "0x00" },
      ],
    };
    expect(() => parseFeedBlock(injected)).toThrow("InvalidProjection");
  });
});

test("body read deadline cancels a stalled stream", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await expect(boundedJson(new Response(stream), 16, 10)).rejects.toThrow(
    "ReadTimeout",
  );
  expect(cancelled).toBe(true);
});

test("remote source/control transports require HTTPS or explicit private-network opt-in", () => {
  const g = genesis(),
    base = {
      DATABASE_URL: "postgres://test",
      SIMULATOR_SOURCE_ID: g.sourceId,
      SIMULATOR_RUN_ID: g.runId,
      SIMULATOR_GENESIS_HASH: g.genesisHash,
      SIMULATOR_CHAIN_ID: g.chainId,
    };
  expect(() =>
    parseSimulatorConfig({ ...base, SIMULATOR_URL: "http://remote.example" }),
  ).toThrow("SimulatorHttpsRequired");
  expect(
    parseSimulatorConfig({ ...base, SIMULATOR_URL: "https://remote.example" })
      .feedUrl,
  ).toBe("https://remote.example");
  expect(() =>
    parseSimulatorConfig({
      ...base,
      SIMULATOR_URL: "http://127.0.0.1",
      SIMULATOR_CONTROL_URL: "http://producer",
    }),
  ).toThrow("SimulatorHttpsRequired");
  expect(() =>
    parseSimulatorConfig({
      ...base,
      SIMULATOR_URL: "http://127.0.0.1",
      SIMULATOR_SCHEMA: "public",
    }),
  ).toThrow("InvalidSchema");
});

test("fenced producer status may retain current plus prepared manifest", () => {
  const s = status(genesis());
  expect(
    parseStatus({
      ...s,
      health: "storage-fenced",
      memory: { ...s.memory, residentManifests: 2 },
    }).memory.residentManifests,
  ).toBe(2);
  expect(() =>
    parseStatus({ ...s, memory: { ...s.memory, residentManifests: 3 } }),
  ).toThrow();
});

test("u32 wire integers reject noncanonical negative zero", () => {
  expect(() => integer(-0)).toThrow();
});
