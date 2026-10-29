import { describe, expect, test, spyOn } from "bun:test";
import { WebsiteRpcTokenManager } from "./src/websiteRpcTokens";

function fixture() {
  let now = 1_000_000;
  let minted = 0;
  let failures = 0;
  let stored: string | null = null;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const manager = new WebsiteRpcTokenManager({
    origin: "https://explorer.test", now: () => now,
    storage: () => ({ getItem: () => stored, setItem: (_k, value) => { stored = value; } }),
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/website-rpc/token") return Response.json({ token: `wrpc.test.${++minted}`, expiresInMs: 120_000, expiresAt: now + 999_000 });
      if (failures > 0) { failures--; return new Response(null, { status: 401 }); }
      return Response.json({ result: "ok" });
    },
  });
  return { manager, calls, advance: (ms: number) => { now += ms; }, fail: (count: number) => { failures = count; }, minted: () => minted,
    setStored: (value: string) => { stored = value; } };
}

describe("website RPC browser transport", () => {
  test("deduplicates async token acquisition, stores tokens, and refreshes at one minute", async () => {
    const f = fixture();
    const values = await Promise.all(Array.from({ length: 10 }, () => f.manager.get()));
    expect(f.minted()).toBe(1);
    expect(new Set(values.map(v => v.token)).size).toBe(1);
    f.advance(59_999);
    await f.manager.get();
    expect(f.minted()).toBe(1);
    f.advance(1);
    await f.manager.get();
    expect(f.minted()).toBe(2);
    f.advance(600_000); // a suspended tab must refresh before its next RPC
    await f.manager.fetch("/api/entity-explorer/rpc", { method: "POST" });
    expect(f.minted()).toBe(3);
    expect(new Headers(f.calls.at(-1)!.init!.headers).get("authorization")).toBe("Bearer wrpc.test.3");
    expect(f.calls.at(-1)!.init!.credentials).toBe("same-origin");
  });

  test("recovers once from cookie races or invalidated tokens, never loops on 401", async () => {
    const f = fixture();
    f.fail(1);
    expect((await f.manager.fetch("/api/shadow-rpc/experimental")).status).toBe(200);
    expect(f.minted()).toBe(2);
    f.fail(10);
    expect((await f.manager.fetch("/api/shadow-rpc/experimental")).status).toBe(401);
    expect(f.minted()).toBe(3);
  });

  test("does not leak credentials to custom nodes or unrelated same-origin endpoints", async () => {
    const f = fixture();
    for (const url of ["https://other.test/api/entity-explorer/rpc", "/api/other", "//other.test/api/entity-explorer/rpc"]) {
      await f.manager.fetch(url, { headers: { authorization: "Bearer secret", "x-csrf-token": "secret" } });
      const init = f.calls.at(-1)!.init!;
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      expect(new Headers(init.headers).has("x-csrf-token")).toBe(false);
    }
    expect(f.minted()).toBe(0);
  });

  test("rejects malformed stored credentials and works when localStorage is disabled", async () => {
    const f = fixture();
    f.setStored('{"token":"wrpc.fake","expiresAt":99999999999999}');
    await f.manager.get();
    expect(f.minted()).toBe(1);
    const manager = new WebsiteRpcTokenManager({
      origin: "https://explorer.test", storage: () => { throw new Error("disabled"); },
      fetch: async () => Response.json({ token: "wrpc.test", expiresInMs: 120_000 }),
    });
    expect((await manager.get()).token).toBe("wrpc.test");
  });

  test("a failed refresh can be retried on the next call", async () => {
    let calls = 0;
    const manager = new WebsiteRpcTokenManager({ origin: "https://explorer.test", fetch: async () => {
      if (++calls === 1) return new Response(null, { status: 503 });
      return Response.json({ token: "wrpc.test", expiresInMs: 120_000 });
    } });
    await expect(manager.get()).rejects.toThrow("503");
    expect((await manager.get()).token).toBe("wrpc.test");
  });
});

test("the minute timer refreshes even when issuance finished after the timer started", async () => {
  let tick: (() => void) | undefined;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
    expect(ms).toBe(60_000);
    tick = callback;
    return 123;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  try {
    const f = fixture();
    const stop = f.manager.start();
    await f.manager.get();
    f.advance(59_000); // the token was minted after the interval was started
    tick!();
    await f.manager.get();
    expect(f.minted()).toBe(2);
    stop();
    expect(clear).toHaveBeenCalled();
  } finally { interval.mockRestore(); clear.mockRestore(); }
});
