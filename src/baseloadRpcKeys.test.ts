import { describe, expect, test } from "bun:test";
import {
  BaseloadRpcKeyPool,
  applyRpcKey,
  maskKey,
  parseBaseloadRpcKeyRuntimeConfig,
  parseGeneratedKey,
  parseRpcKeyStore,
  type BaseloadRpcKeyRuntimeConfig,
} from "./baseloadRpcKeys";

const RPC = "https://rpc.example.test";

const CONFIG: BaseloadRpcKeyRuntimeConfig = {
  serviceUrl: "http://arkiv-keys:8787",
  placement: "bearer",
  headerName: "X-Api-Key",
  namePrefix: "baseload",
  storePath: "/tmp/does-not-exist/rpc-keys.json",
  requestTimeoutMs: 5_000,
};

describe("parseBaseloadRpcKeyRuntimeConfig", () => {
  test("stays disabled without a service URL", () => {
    expect(parseBaseloadRpcKeyRuntimeConfig({})).toBeNull();
  });

  test("trims the service URL and applies defaults", () => {
    const config = parseBaseloadRpcKeyRuntimeConfig({
      BASELOAD_RPC_KEY_SERVICE_URL: " http://arkiv-keys:8787/ ",
    });
    expect(config).toEqual({
      serviceUrl: "http://arkiv-keys:8787",
      placement: "bearer",
      headerName: "X-Api-Key",
      namePrefix: "baseload",
      storePath: "baseload-keys/rpc-keys.json",
      requestTimeoutMs: 180_000,
    });
  });

  test("rejects an unknown placement", () => {
    expect(() =>
      parseBaseloadRpcKeyRuntimeConfig({
        BASELOAD_RPC_KEY_SERVICE_URL: "http://arkiv-keys:8787",
        BASELOAD_RPC_KEY_PLACEMENT: "query",
      }),
    ).toThrow(/BASELOAD_RPC_KEY_PLACEMENT/);
  });

  test("rejects a non-positive timeout", () => {
    expect(() =>
      parseBaseloadRpcKeyRuntimeConfig({
        BASELOAD_RPC_KEY_SERVICE_URL: "http://arkiv-keys:8787",
        BASELOAD_RPC_KEY_TIMEOUT_SECONDS: "0",
      }),
    ).toThrow(/positive number/);
  });
});

describe("applyRpcKey", () => {
  test("sends a bearer header by default", () => {
    expect(applyRpcKey(RPC, "ark_live_abc", CONFIG)).toEqual({
      url: RPC,
      headers: { Authorization: "Bearer ark_live_abc" },
    });
  });

  test("sends the configured header when placement is header", () => {
    expect(applyRpcKey(RPC, "ark_live_abc", { ...CONFIG, placement: "header" })).toEqual({
      url: RPC,
      headers: { "X-Api-Key": "ark_live_abc" },
    });
  });

  test("appends the key as the last path segment when placement is path", () => {
    expect(applyRpcKey(`${RPC}/`, "ark_live_abc", { ...CONFIG, placement: "path" })).toEqual({
      url: `${RPC}/ark_live_abc`,
      headers: {},
    });
  });
});

describe("parseGeneratedKey", () => {
  test("reads the generator response", () => {
    const record = parseGeneratedKey(
      { key: "ark_live_abc", name: "baseload_w0", wallet: "0x1", createdAt: "2026-01-01" },
      "w0",
    );
    expect(record).toEqual({
      key: "ark_live_abc",
      name: "baseload_w0",
      wallet: "0x1",
      createdAt: "2026-01-01",
    });
  });

  test("surfaces the generator's error message when no key came back", () => {
    expect(() => parseGeneratedKey({ error: "captcha timeout" }, "w0")).toThrow(/captcha timeout/);
  });
});

describe("parseRpcKeyStore", () => {
  test("drops entries without a key and unknown versions", () => {
    const store = parseRpcKeyStore(
      JSON.stringify({ version: 1, keys: { w0: { key: "ark_live_abc" }, w1: { name: "x" } } }),
    );
    expect(Object.keys(store.keys)).toEqual(["w0"]);
    expect(parseRpcKeyStore(JSON.stringify({ version: 99, keys: { w0: { key: "a" } } })).keys).toEqual(
      {},
    );
  });
});

describe("maskKey", () => {
  test("keeps enough of a key to identify it without revealing it", () => {
    expect(maskKey("ark_live_EXAMPLEkeyFIXTUREonly0123456789ab")).toBe("ark_live_EXA…89ab");
    expect(maskKey("short")).toBe("shor…");
  });
});

function stubGenerator(keys: string[]) {
  let index = 0;
  const calls: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(JSON.parse(String(init?.body ?? "{}")).name));
    const key = keys[index++] ?? "ark_live_exhausted";
    return new Response(JSON.stringify({ key, name: key, wallet: "0x1" }), { status: 201 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function stubStore() {
  const written: string[] = [];
  return {
    written,
    readFileImpl: async () => {
      const last = written[written.length - 1];
      if (last === undefined) throw new Error("ENOENT");
      return last;
    },
    writeFileImpl: async (_path: string, contents: string) => {
      written.push(contents);
    },
  };
}

describe("BaseloadRpcKeyPool", () => {
  test("mints one key per worker and reuses it", async () => {
    const generator = stubGenerator(["ark_live_one", "ark_live_two"]);
    const store = stubStore();
    const pool = new BaseloadRpcKeyPool(CONFIG, { ...generator, ...store, log: () => {} });

    expect(await pool.endpointFor(RPC, "creator-w0")).toEqual({
      url: RPC,
      headers: { Authorization: "Bearer ark_live_one" },
    });
    expect(await pool.endpointFor(RPC, "churner-w1")).toEqual({
      url: RPC,
      headers: { Authorization: "Bearer ark_live_two" },
    });
    // Second ask for the same worker must not burn another mint.
    expect(await pool.endpointFor(RPC, "creator-w0")).toEqual({
      url: RPC,
      headers: { Authorization: "Bearer ark_live_one" },
    });
    expect(generator.calls).toEqual(["baseload_creator-w0", "baseload_churner-w1"]);
  });

  test("mints once for concurrent asks from the same worker", async () => {
    const generator = stubGenerator(["ark_live_one", "ark_live_two"]);
    const pool = new BaseloadRpcKeyPool(CONFIG, { ...generator, ...stubStore(), log: () => {} });

    const [a, b] = await Promise.all([pool.keyFor("creator-w0"), pool.keyFor("creator-w0")]);
    expect(a.key).toBe("ark_live_one");
    expect(b.key).toBe("ark_live_one");
    expect(generator.calls).toHaveLength(1);
  });

  test("reloads persisted keys instead of minting again", async () => {
    const store = stubStore();
    const first = new BaseloadRpcKeyPool(CONFIG, {
      ...stubGenerator(["ark_live_one"]),
      ...store,
      log: () => {},
    });
    await first.keyFor("creator-w0");

    const generator = stubGenerator(["ark_live_fresh"]);
    const second = new BaseloadRpcKeyPool(CONFIG, { ...generator, ...store, log: () => {} });
    expect((await second.keyFor("creator-w0")).key).toBe("ark_live_one");
    expect(generator.calls).toEqual([]);
  });

  test("keeps minting for other workers after one mint fails", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response("captcha timeout", { status: 502 });
      return new Response(JSON.stringify({ key: "ark_live_two" }), { status: 201 });
    }) as unknown as typeof fetch;
    const pool = new BaseloadRpcKeyPool(CONFIG, { fetchImpl, ...stubStore(), log: () => {} });

    await expect(pool.keyFor("creator-w0")).rejects.toThrow(/HTTP 502/);
    expect((await pool.keyFor("churner-w1")).key).toBe("ark_live_two");
  });
});
