import { describe, expect, test } from "bun:test";
import {
  GENESIS_SELECT,
  GenesisEntityError,
  GenesisRpcError,
  GenesisSourceUnavailable,
  MAX_GENESIS_POSITION,
  createRpcGenesisSource,
  genesisEntityToVersion,
  walkGenesisEntities,
} from "./entityGenesis";
import { FAKE_GENESIS_OWNER, createFakeGenesisSource, fakeWireEntity } from "./testGenesisSource";

const KEY_7 = `0x${"7".padStart(64, "0")}`;

describe("genesisEntityToVersion", () => {
  test("maps a node's entity at block 0 to version 0 at its position", () => {
    const version = genesisEntityToVersion(
      fakeWireEntity(7, {
        creationFlags: { readonly: true, permissionlessExtension: true, raw: 3 },
        expiresAt: "0x2c4cca",
        attributes: [
          { name: "z", type: "i32", value: -5 },
          { name: "Verified", type: "bool", value: true },
          { name: "matchid", type: "u64", value: "0x2abefef" },
          { name: "deployer", type: "addr", value: "0x0C45a3EBd981d9A57126834a9390E8d0b1Eb084B" },
          { name: "ref", type: "key", value: KEY_7.toUpperCase().replace("0X", "0x") },
          { name: "price", type: "dec", value: "1.5" },
          { name: "big", type: "u256", value: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
          { name: "ä", type: "str", value: "umlaut" },
        ],
      }),
      41,
    );
    expect(version).toEqual({
      entityKey: KEY_7,
      version: 0,
      fromBlock: 0,
      fromPosition: 41,
      fromOpIndex: 0,
      toBlock: null,
      deleted: false,
      owner: FAKE_GENESIS_OWNER,
      creator: FAKE_GENESIS_OWNER,
      createdAt: 0,
      createdPosition: 41,
      createdOpIndex: 0,
      updatedAt: 0,
      expiresAt: 0x2c4ccan,
      creationFlags: 3,
      contentType: "application/json",
      payloadSize: 0,
      attributes: [
        { name: "Verified", typeId: 1, valueText: "true", valueNum: null },
        { name: "big", typeId: 4, valueText: (2n ** 256n - 1n).toString(), valueNum: 2n ** 256n - 1n },
        { name: "deployer", typeId: 9, valueText: "0x0c45a3ebd981d9a57126834a9390e8d0b1eb084b", valueNum: null },
        { name: "matchid", typeId: 3, valueText: "44822511", valueNum: 44822511n },
        { name: "price", typeId: 5, valueText: "1.5", valueNum: 1_500_000_000_000_000_000n },
        { name: "ref", typeId: 10, valueText: KEY_7, valueNum: null },
        { name: "z", typeId: 2, valueText: "-5", valueNum: -5n },
        { name: "ä", typeId: 8, valueText: "umlaut", valueNum: null },
      ],
    });
  });

  test("flags come from the raw byte, from the booleans without one, or stay unknown", () => {
    expect(genesisEntityToVersion(fakeWireEntity(1, { creationFlags: { raw: 2, readonly: true, permissionlessExtension: false } }), 1).creationFlags).toBe(2);
    expect(genesisEntityToVersion(fakeWireEntity(1, { creationFlags: { readonly: true, permissionlessExtension: true } }), 1).creationFlags).toBe(3);
    expect(genesisEntityToVersion(fakeWireEntity(1, { creationFlags: undefined }), 1).creationFlags).toBeNull();
    expect(genesisEntityToVersion(fakeWireEntity(1, { creationFlags: null }), 1).creationFlags).toBeNull();
  });

  test("a never-expiring entity keeps 2^64-1, and an absent content type or attribute list is empty", () => {
    const version = genesisEntityToVersion(fakeWireEntity(1, { contentType: undefined, attributes: undefined }), 0);
    expect(version.expiresAt).toBe(2n ** 64n - 1n);
    expect(version.contentType).toBe("");
    expect(version.attributes).toEqual([]);
  });

  test("refuses anything the index could only store as a guess", () => {
    const refuse = (entity: unknown, position = 0) => expect(() => genesisEntityToVersion(entity, position)).toThrow(GenesisEntityError);
    refuse("nope");
    refuse(fakeWireEntity(1, { key: "0x1234" }));
    refuse(fakeWireEntity(1, { createdAt: "0x5" }));
    refuse(fakeWireEntity(1, { updatedAt: "0x5" }));
    refuse(fakeWireEntity(1, { owner: "0xabc" }));
    refuse(fakeWireEntity(1, { creator: undefined }));
    refuse(fakeWireEntity(1, { expiresAt: "0x0" }));
    refuse(fakeWireEntity(1, { expiresAt: "0x10000000000000000" }));
    refuse(fakeWireEntity(1, { expiresAt: 5 }));
    refuse(fakeWireEntity(1, { creationFlags: { raw: 256 } }));
    refuse(fakeWireEntity(1, { attributes: [{ name: "x", type: "bytes", value: "0x00" }] }));
    refuse(fakeWireEntity(1, { attributes: [{ name: "x", type: "u128", value: "0x1" }] }));
    refuse(fakeWireEntity(1, { attributes: [{ name: "x", type: "u64", value: 5 }] }));
    refuse(fakeWireEntity(1, { attributes: [{ name: "x", type: "str", value: "a" }, { name: "x", type: "str", value: "b" }] }));
    refuse(fakeWireEntity(1, { attributes: [{ name: "", type: "str", value: "a" }] }));
    refuse(fakeWireEntity(1, { attributes: [{ name: "x", type: "str" }] }));
    refuse(fakeWireEntity(1, { attributes: "none" }));
    refuse(fakeWireEntity(1), -1);
    refuse(fakeWireEntity(1), MAX_GENESIS_POSITION + 1);
    expect(() => genesisEntityToVersion(fakeWireEntity(1, { createdAt: "0x5" }), 0)).toThrow(/not a genesis entity/);
  });
});

describe("walkGenesisEntities", () => {
  const entities = Array.from({ length: 7 }, (_, id) => fakeWireEntity(id));

  test("pages newest-first and hands every entity its id as position", async () => {
    const source = createFakeGenesisSource(entities);
    const pages = [];
    for await (const page of walkGenesisEntities(source, { cursor: null, imported: 0, total: 7, pageSize: 3 })) pages.push(page);
    expect(pages.map((page) => [page.versions.map((version) => version.createdPosition), page.cursor, page.imported])).toEqual([
      [[6, 5, 4], "c:3", 3],
      [[3, 2, 1], "c:6", 6],
      [[0], null, 7],
    ]);
    expect(pages[0]!.versions[0]!.entityKey).toBe(fakeWireEntity(6).key as string);
    expect(source.pages).toBe(3);
  });

  test("resumes after a stored cursor with the same positions", async () => {
    const source = createFakeGenesisSource(entities);
    const pages = [];
    for await (const page of walkGenesisEntities(source, { cursor: "c:3", imported: 3, total: 7, pageSize: 3 })) pages.push(page);
    expect(pages.map((page) => page.versions.map((version) => version.createdPosition))).toEqual([[3, 2, 1], [0]]);
  });

  test("refuses a walk that does not add up", async () => {
    const collect = async (source: ReturnType<typeof createFakeGenesisSource>, total: number, resume = { cursor: null, imported: 0 }) => {
      for await (const _page of walkGenesisEntities(source, { ...resume, total, pageSize: 3 })) {
        // drain
      }
    };
    await expect(collect(createFakeGenesisSource(entities), 5)).rejects.toThrow(/more than the 5 entities/);
    await expect(collect(createFakeGenesisSource(entities), 9)).rejects.toThrow(/ended after 7 of the 9/);
    await expect(collect(createFakeGenesisSource(entities), 7, { cursor: null, imported: 8 })).rejects.toThrow(/8 entities imported of 7/);
    const elsewhere = createFakeGenesisSource(entities);
    const page = elsewhere.page.bind(elsewhere);
    elsewhere.page = async (cursor, limit) => ({ ...(await page(cursor, limit)), blockNumber: "0x5" });
    await expect(collect(elsewhere, 7)).rejects.toThrow(/block 0x5/);
    const stuck = createFakeGenesisSource(entities);
    stuck.page = async () => ({ data: [fakeWireEntity(6)], blockNumber: "0x0", cursor: "same" });
    await expect(collect(stuck, 7)).rejects.toThrow(/repeated a page cursor/);
    await expect(collect(createFakeGenesisSource(entities), MAX_GENESIS_POSITION + 1)).rejects.toThrow(/position range/);
  });

  test("a failing page surfaces where it is awaited, not as an unhandled rejection", async () => {
    const source = createFakeGenesisSource(entities);
    const walk = walkGenesisEntities(source, { cursor: null, imported: 0, total: 7, pageSize: 3 });
    expect((await walk.next()).value?.imported).toBe(3);
    source.failNextPage(new Error("boom"));
    // The second page was prefetched before the failure was scheduled; the
    // third is the one that fails.
    expect((await walk.next()).value?.imported).toBe(6);
    await expect(walk.next()).rejects.toThrow("boom");
  });
});

describe("createRpcGenesisSource", () => {
  interface Call {
    body: { id: number; method: string; params: unknown[] };
    headers: Record<string, string>;
  }
  type Reply = (call: Call) => Response;

  function fakeFetch(replies: Reply[]): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Call["body"];
      const call: Call = { body, headers: { ...(init?.headers as Record<string, string>) } };
      calls.push(call);
      const reply = replies.shift();
      if (!reply) throw new Error("no reply scheduled");
      return reply(call);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const ok = (call: Call, result: unknown) => json({ jsonrpc: "2.0", id: call.body.id, result });
  const failure = (call: Call, code: number, message: string) => json({ jsonrpc: "2.0", id: call.body.id, error: { code, message } });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  test("asks the node exactly what the walk needs, with the key in the header", async () => {
    const { fetchImpl, calls } = fakeFetch([
      (call) => ok(call, "0x75ff6e"),
      (call) => ok(call, { hash: `0x${"AB".repeat(32)}`, stateRoot: `0x${"CD".repeat(32)}` }),
      (call) => ok(call, 28825),
      (call) => ok(call, { data: [fakeWireEntity(1)], blockNumber: "0x0", cursor: "b64:next" }),
      (call) => ok(call, { data: [], blockNumber: "0x0" }),
    ]);
    const source = createRpcGenesisSource({ url: "http://node.test/", apiKey: "secret", fetchImpl, sleep });
    expect(await source.describe()).toEqual({ chainId: 7733102n, genesisHash: `0x${"ab".repeat(32)}`, stateRoot: `0x${"cd".repeat(32)}` });
    expect(await source.count()).toBe(28825);
    expect(await source.page(undefined, 200)).toEqual({ data: [fakeWireEntity(1)], blockNumber: "0x0", cursor: "b64:next" });
    expect(await source.page("b64:next", 200)).toEqual({ data: [], blockNumber: "0x0" });
    expect(calls.map((call) => [call.body.method, call.body.params])).toEqual([
      ["eth_chainId", []],
      ["eth_getBlockByNumber", ["0x0", false]],
      ["arkiv_getEntityCount", [{ block: 0 }]],
      ["arkiv_query", ["*", { atBlock: "0x0", select: GENESIS_SELECT, limit: 200 }]],
      ["arkiv_query", ["*", { atBlock: "0x0", select: GENESIS_SELECT, limit: 200, cursor: "b64:next" }]],
    ]);
    expect(calls.every((call) => call.headers["x-api-key"] === "secret")).toBe(true);
    expect(new Set(calls.map((call) => call.body.id)).size).toBe(5);
  });

  test("retries a throttled or failing transport and honours Retry-After", async () => {
    sleeps.length = 0;
    const { fetchImpl, calls } = fakeFetch([
      () => json({ error: "slow down" }, 503, { "retry-after": "3" }),
      () => {
        throw new TypeError("connection reset");
      },
      (call) => ok(call, 5),
    ]);
    const source = createRpcGenesisSource({ url: "http://node.test/", fetchImpl, sleep });
    expect(await source.count()).toBe(5);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 2000]);
  });

  test("gives up after the configured attempts", async () => {
    const { fetchImpl } = fakeFetch(Array.from({ length: 2 }, () => () => json({}, 502)));
    const source = createRpcGenesisSource({ url: "http://node.test/", fetchImpl, sleep, attempts: 2 });
    await expect(source.count()).rejects.toThrow(/HTTP 502/);
  });

  test("tells a node that cannot answer for block 0 from any other error", async () => {
    const { fetchImpl } = fakeFetch([
      (call) => failure(call, -32006, "block 0 is unavailable: state for this block is not retained"),
      (call) => failure(call, -32601, "Method not found"),
      (call) => failure(call, -32602, "invalid params"),
      (call) => json({ jsonrpc: "2.0", id: call.body.id + 100, result: 1 }),
      () => new Response("<html>", { status: 200 }),
    ]);
    const source = createRpcGenesisSource({ url: "http://node.test/", fetchImpl, sleep });
    await expect(source.count()).rejects.toBeInstanceOf(GenesisSourceUnavailable);
    await expect(source.count()).rejects.toBeInstanceOf(GenesisSourceUnavailable);
    await expect(source.count()).rejects.toBeInstanceOf(GenesisRpcError);
    await expect(source.count()).rejects.toThrow(/mismatched id/);
    await expect(source.count()).rejects.toThrow(/malformed JSON/);
  });

  test("refuses a page that is not an entity page", async () => {
    const { fetchImpl } = fakeFetch([(call) => ok(call, { data: "nope", blockNumber: "0x0" }), (call) => ok(call, { data: [], blockNumber: "0x0", cursor: "" })]);
    const source = createRpcGenesisSource({ url: "http://node.test/", fetchImpl, sleep });
    await expect(source.page(undefined, 10)).rejects.toBeInstanceOf(GenesisEntityError);
    await expect(source.page(undefined, 10)).rejects.toThrow(/invalid cursor/);
  });
});
