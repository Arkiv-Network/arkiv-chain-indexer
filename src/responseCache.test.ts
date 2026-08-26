import { describe, expect, test } from "bun:test";
import { ResponseCache } from "./responseCache";

const KEY_A = `0x${"aa".repeat(32)}`;
const KEY_B = `0x${"bb".repeat(32)}`;
const KEY_C = `0x${"cc".repeat(32)}`;

function response(body: string, status = 200) {
  return { status, body };
}

describe("ResponseCache", () => {
  test("serves the second load from cache without calling the loader", async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return response(`body-${calls}`);
    };

    const first = await cache.load(KEY_A, loader);
    const second = await cache.load(KEY_A, loader);

    expect(calls).toBe(1);
    expect(first).toEqual(response("body-1"));
    expect(second).toEqual(response("body-1"));
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  test("stores keys verbatim — normalization is the caller's job", async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return response(`body-${calls}`);
    };

    await cache.load("Key", loader);
    await cache.load("key", loader);
    expect(calls).toBe(2);
  });

  test("preserves binary bodies and extra headers", async () => {
    const cache = new ResponseCache();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const loader = async () => ({
      status: 200,
      body: bytes,
      headers: { "Content-Encoding": "zstd" },
    });

    await cache.load(KEY_A, loader);
    const cached = await cache.load(KEY_A, async () => {
      throw new Error("loader must not run on a hit");
    });

    expect(cached.body).toBe(bytes);
    expect(cached.headers).toEqual({ "Content-Encoding": "zstd" });
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: 5 });
  });

  test("invalidate drops the entry so the next load hits the loader", async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return response(`body-${calls}`);
    };

    await cache.load(KEY_A, loader);
    cache.invalidate(KEY_A);
    const reloaded = await cache.load(KEY_A, loader);

    expect(calls).toBe(2);
    expect(reloaded).toEqual(response("body-2"));
    expect(cache.stats()).toMatchObject({ invalidations: 1, bytes: "body-2".length });
  });

  test("caps the entry count by evicting the least recently used key", async () => {
    const cache = new ResponseCache({ maxEntries: 2 });
    const loads: string[] = [];
    const loaderFor = (name: string) => async () => {
      loads.push(name);
      return response(name);
    };

    await cache.load(KEY_A, loaderFor("a"));
    await cache.load(KEY_B, loaderFor("b"));
    // Touch A so B becomes the least recently used entry…
    await cache.load(KEY_A, loaderFor("a2"));
    // …and inserting C evicts B, not A.
    await cache.load(KEY_C, loaderFor("c"));
    await cache.load(KEY_A, loaderFor("a3"));
    await cache.load(KEY_B, loaderFor("b2"));

    expect(loads).toEqual(["a", "b", "c", "b2"]);
    expect(cache.stats()).toMatchObject({ entries: 2, evictions: 2 });
  });

  test("caps the total cached bytes", async () => {
    const cache = new ResponseCache({ maxBytes: 10 });

    await cache.load(KEY_A, async () => response("123456")); // 6 bytes
    await cache.load(KEY_B, async () => response("7890")); // 4 bytes -> fits (10)
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 10 });

    await cache.load(KEY_C, async () => response("abc")); // evicts A (oldest)
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 7, evictions: 1 });

    let reloaded = 0;
    await cache.load(KEY_A, async () => {
      reloaded += 1;
      return response("123456");
    });
    expect(reloaded).toBe(1);
  });

  test("never stores a body larger than the byte cap", async () => {
    const cache = new ResponseCache({ maxBytes: 4 });
    await cache.load(KEY_A, async () => response("too-large"));
    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0, evictions: 0 });
  });

  test("expires entries after the TTL", async () => {
    let clock = 1_000;
    const cache = new ResponseCache({ ttlMs: 50, now: () => clock });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return response(`body-${calls}`);
    };

    await cache.load(KEY_A, loader);
    clock += 49;
    await cache.load(KEY_A, loader);
    expect(calls).toBe(1);

    clock += 2;
    const reloaded = await cache.load(KEY_A, loader);
    expect(calls).toBe(2);
    expect(reloaded).toEqual(response("body-2"));
    expect(cache.stats()).toMatchObject({ expirations: 1 });
  });

  test("coalesces concurrent loads for the same key into one loader call", async () => {
    const cache = new ResponseCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async () => {
      calls += 1;
      await gate;
      return response("shared");
    };

    const loads = [cache.load(KEY_A, loader), cache.load(KEY_A, loader), cache.load(KEY_A, loader)];
    release();
    const results = await Promise.all(loads);

    expect(calls).toBe(1);
    expect(results).toEqual([response("shared"), response("shared"), response("shared")]);
    expect(cache.stats()).toMatchObject({ misses: 1, coalesced: 2 });
  });

  test("an invalidation racing an in-flight load prevents caching its stale result", async () => {
    const cache = new ResponseCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return response(`body-${calls}`);
    };

    // A read starts, then the key is invalidated (fresh data was committed)
    // before the read's pre-write snapshot resolves.
    const inflight = cache.load(KEY_A, loader);
    cache.invalidate(KEY_A);
    release();
    const stale = await inflight;

    // The waiting request still gets the loader's result, but it is not
    // cached: the next load consults storage again.
    expect(stale).toEqual(response("body-1"));
    const fresh = await cache.load(KEY_A, loader);
    expect(fresh).toEqual(response("body-2"));
    expect(calls).toBe(2);
  });

  test("clear drops every entry and poisons loads in flight", async () => {
    const cache = new ResponseCache();
    await cache.load(KEY_A, async () => response("a"));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const loader = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return response(`b-${calls}`);
    };
    const inflight = cache.load(KEY_B, loader);

    cache.clear();
    release();
    await inflight;

    expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
    // The poisoned in-flight result was not cached.
    await cache.load(KEY_B, loader);
    expect(calls).toBe(2);
  });

  test("a loader failure is propagated and nothing is cached", async () => {
    const cache = new ResponseCache();
    let calls = 0;

    await expect(
      cache.load(KEY_A, async () => {
        calls += 1;
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");

    const recovered = await cache.load(KEY_A, async () => {
      calls += 1;
      return response("ok");
    });
    expect(calls).toBe(2);
    expect(recovered).toEqual(response("ok"));
  });

  test("caches non-200 results just like successes", async () => {
    const cache = new ResponseCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return response('{"error":"not found"}', 404);
    };

    const first = await cache.load(KEY_A, loader);
    const second = await cache.load(KEY_A, loader);
    expect(calls).toBe(1);
    expect(first.status).toBe(404);
    expect(second).toEqual(first);
  });

  test("a zero cap disables caching entirely", async () => {
    for (const options of [{ maxEntries: 0 }, { maxBytes: 0 }, { ttlMs: 0 }]) {
      const cache = new ResponseCache(options);
      expect(cache.enabled).toBe(false);
      let calls = 0;
      const loader = async () => {
        calls += 1;
        return response("body");
      };
      await cache.load(KEY_A, loader);
      await cache.load(KEY_A, loader);
      expect(calls).toBe(2);
      expect(cache.stats()).toMatchObject({ entries: 0, bytes: 0 });
    }
  });
});
