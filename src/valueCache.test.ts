import { describe, expect, test } from "bun:test";
import { ValueCache } from "./valueCache";

describe("ValueCache", () => {
  test("serves the second load from cache without calling the loader", async () => {
    const cache = new ValueCache<number>();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return 42;
    };

    expect(await cache.load("a", loader)).toBe(42);
    expect(await cache.load("a", loader)).toBe(42);
    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  test("caches zero as a value rather than treating it as a miss", async () => {
    const cache = new ValueCache<number>();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return 0;
    };

    expect(await cache.load("empty", loader)).toBe(0);
    expect(await cache.load("empty", loader)).toBe(0);
    expect(calls).toBe(1);
  });

  test("coalesces concurrent misses into a single loader call", async () => {
    const cache = new ValueCache<number>();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async () => {
      calls += 1;
      await gate;
      return 7;
    };

    const inflight = [cache.load("a", loader), cache.load("a", loader), cache.load("a", loader)];
    release?.();

    expect(await Promise.all(inflight)).toEqual([7, 7, 7]);
    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({ misses: 1, coalesced: 2 });
  });

  test("an invalidation during a load keeps that result out of the cache", async () => {
    const cache = new ValueCache<number>();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loader = async () => {
      calls += 1;
      await gate;
      return calls;
    };

    const inflight = cache.load("a", loader);
    cache.invalidate("a");
    release?.();

    // The waiter still gets the value it was promised...
    expect(await inflight).toBe(1);
    // ...but it was never cached, so the next read re-runs the loader.
    expect(cache.get("a")).toBeNull();
  });

  test("clear() drops every entry and poisons loads in flight", async () => {
    const cache = new ValueCache<number>();
    await cache.load("a", async () => 1);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inflight = cache.load("b", async () => {
      await gate;
      return 2;
    });
    cache.clear();
    release?.();
    await inflight;

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  });

  test("expires entries once the TTL passes", async () => {
    let clock = 1_000;
    const cache = new ValueCache<number>({ ttlMs: 50, now: () => clock });
    await cache.load("a", async () => 1);

    clock += 49;
    expect(cache.get("a")).toEqual({ value: 1 });

    clock += 2;
    expect(cache.get("a")).toBeNull();
    expect(cache.stats()).toMatchObject({ expirations: 1 });
  });

  test("evicts the least recently used entry past the entry cap", async () => {
    const cache = new ValueCache<number>({ maxEntries: 2 });
    await cache.load("a", async () => 1);
    await cache.load("b", async () => 2);
    // Touch "a" so "b" becomes the least recently used.
    expect(cache.get("a")).toEqual({ value: 1 });
    await cache.load("c", async () => 3);

    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).toEqual({ value: 1 });
    expect(cache.get("c")).toEqual({ value: 3 });
    expect(cache.stats()).toMatchObject({ evictions: 1, entries: 2 });
  });

  test("a zero cap or TTL disables caching but still serves loads", async () => {
    for (const options of [{ maxEntries: 0 }, { ttlMs: 0 }]) {
      const cache = new ValueCache<number>(options);
      let calls = 0;
      const loader = async () => {
        calls += 1;
        return calls;
      };

      expect(cache.enabled).toBe(false);
      expect(await cache.load("a", loader)).toBe(1);
      expect(await cache.load("a", loader)).toBe(2);
      expect(cache.get("a")).toBeNull();
    }
  });
});
