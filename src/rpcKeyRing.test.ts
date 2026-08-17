import { describe, expect, test } from "bun:test";
import {
  RpcKeyRing,
  loadRpcKeyPool,
  maskRpcKey,
  parseRpcKeyList,
  parseRpcKeyPoolFile,
} from "./rpcKeyRing";

const QUOTA_BODY = JSON.stringify({ error: "QUOTA_EXCEEDED", message: "quota exhausted" });
const RATE_BODY = JSON.stringify({ error: "RATE_LIMITED" });

function ring(keys: string[], nowRef = { ms: 1_000 }) {
  return new RpcKeyRing({ keys, now: () => nowRef.ms, log: () => {}, cooldownMs: 1_000 });
}

describe("parseRpcKeyList", () => {
  test("splits on commas and whitespace, dropping blanks and duplicates", () => {
    expect(parseRpcKeyList(" a, b  c,,a ")).toEqual(["a", "b", "c"]);
    expect(parseRpcKeyList(undefined)).toEqual([]);
  });
});

describe("parseRpcKeyPoolFile", () => {
  test("reads a provisioned pool file", () => {
    expect(parseRpcKeyPoolFile(JSON.stringify({ quota: 1, keys: ["a", "b"] }))).toEqual(["a", "b"]);
  });

  test("accepts a bare array and objects with a key field", () => {
    expect(parseRpcKeyPoolFile(JSON.stringify(["a"]))).toEqual(["a"]);
    expect(parseRpcKeyPoolFile(JSON.stringify({ keys: [{ key: "a" }, { key: "b" }] }))).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("loadRpcKeyPool", () => {
  test("prefers the pool file, then the list, then the single key", async () => {
    const read = async () => JSON.stringify({ keys: ["file1", "file2"] });
    expect(
      await loadRpcKeyPool(
        { RPC_KEY_POOL_FILE: "/pool.json", SCANNER_RPC_API_KEYS: "a,b", SCANNER_RPC_API_KEY: "c" },
        read,
      ),
    ).toEqual(["file1", "file2"]);
    expect(await loadRpcKeyPool({ SCANNER_RPC_API_KEYS: "a,b", SCANNER_RPC_API_KEY: "c" })).toEqual([
      "a",
      "b",
    ]);
    expect(await loadRpcKeyPool({ SCANNER_RPC_API_KEY: "c" })).toEqual(["c"]);
    expect(await loadRpcKeyPool({})).toEqual([]);
  });

  test("surfaces an unreadable pool file instead of silently running keyless", async () => {
    const read = async () => {
      throw new Error("ENOENT");
    };
    expect(loadRpcKeyPool({ RPC_KEY_POOL_FILE: "/missing.json" }, read)).rejects.toThrow(
      /could not be read/,
    );
  });
});

describe("RpcKeyRing rotation", () => {
  test("hands out keys round-robin", () => {
    const r = ring(["a", "b", "c"]);
    expect([r.next(), r.next(), r.next(), r.next()]).toEqual(["a", "b", "c", "a"]);
  });

  test("returns null when no keys are configured", () => {
    expect(ring([]).next()).toBeNull();
  });

  test("drops duplicate keys", () => {
    expect(ring(["a", "a", "b"]).size).toBe(2);
  });
});

describe("RpcKeyRing quota handling", () => {
  test("retires a key on QUOTA_EXCEEDED and skips it afterwards", () => {
    const r = ring(["a", "b"]);
    r.noteResponse("a", 429, new Headers(), QUOTA_BODY);
    expect(r.usableCount()).toBe(1);
    expect([r.next(), r.next()]).toEqual(["b", "b"]);
  });

  test("retires a key the bouncer rejects outright", () => {
    const r = ring(["a", "b"]);
    r.noteResponse("a", 401, new Headers(), "unauthorized");
    expect(r.usableCount()).toBe(1);
  });

  test("a plain rate-limit 429 only rests the key briefly", () => {
    const now = { ms: 1_000 };
    const r = ring(["a", "b"], now);
    r.noteResponse("a", 429, new Headers(), RATE_BODY);
    expect(r.usableCount()).toBe(2);
    expect(r.next()).toBe("b");
    now.ms += 1_001;
    expect(r.next()).toBe("a");
  });

  test("records the reported quota percentage", () => {
    const r = ring(["a"]);
    r.noteResponse("a", 200, new Headers({ "arkiv-quota-used-percent": "42" }), "{}");
    expect(r.stats().keys[0]?.quotaUsedPercent).toBe(42);
  });

  test("still returns a key when the whole pool is burnt, so the failure is visible", () => {
    const r = ring(["a", "b"]);
    r.noteResponse("a", 429, new Headers(), QUOTA_BODY);
    r.noteResponse("b", 429, new Headers(), QUOTA_BODY);
    expect(r.usableCount()).toBe(0);
    expect(r.next()).not.toBeNull();
  });
});

describe("RpcKeyRing leases", () => {
  test("keeps one key per owner so cached clients are not rebuilt", () => {
    const r = ring(["a", "b", "c"]);
    expect(r.leaseFor("w0")).toBe("a");
    expect(r.leaseFor("w1")).toBe("b");
    expect(r.leaseFor("w0")).toBe("a");
    expect(r.leaseFor("w1")).toBe("b");
  });

  test("moves an owner onto a fresh key when its own key burns out", () => {
    const r = ring(["a", "b", "c"]);
    expect(r.leaseFor("w0")).toBe("a");
    r.noteResponse("a", 429, new Headers(), QUOTA_BODY);
    const next = r.leaseFor("w0");
    expect(next).not.toBe("a");
    expect(["b", "c"]).toContain(next!);
  });
});

describe("maskRpcKey", () => {
  test("never returns the whole key", () => {
    const key = "ark_live_EXAMPLEkeyFIXTUREonly0123456789ab";
    expect(maskRpcKey(key)).not.toContain("FIXTUREonly");
    expect(maskRpcKey(key).startsWith("ark_live_EXA")).toBe(true);
  });
});
