import { describe, expect, test } from "bun:test";
import { MAX_EXPIRES_AT } from "@arkiv-network/sdk";
import { QueryError } from "@arkiv-network/sdk/query";
import type { BlockTiming } from "./src/entityExplorer/lib/client";
import {
  appendQueryExpression,
  explorerLinkFilters,
  describeQueryError,
  estimateBlockIso,
  estimateBlockTimestampMs,
  formatRelativeMs,
  isExpiringSoon,
  lifetimeProgress,
  locateQueryPosition,
  normalizeQueryInput,
  typescriptSnippet,
} from "./src/entityExplorer/lib/query";

const KEY = "0x325ab0cef69bb69888e120bd3b5e4bd26f02397bf3d6898c6be1d5f361f3a649";
const OWNER = "0xc5b669e2c8d61aedc97d71f934a3c6d1d8c71e4c";

describe("normalizeQueryInput", () => {
  test("rewrites a bare entity key into a key query", () => {
    expect(normalizeQueryInput(`  ${KEY} `)).toBe(`$key = key(${KEY})`);
  });

  test("rewrites a bare address into an owner query", () => {
    expect(normalizeQueryInput(OWNER)).toBe(`$owner = addr(${OWNER})`);
  });

  test("leaves an expression alone apart from trimming", () => {
    expect(normalizeQueryInput("  arkiv.schema = str('posts')\n")).toBe("arkiv.schema = str('posts')");
    expect(normalizeQueryInput("   ")).toBe("");
  });
});

describe("page settings", () => {
  test("explorerLinkFilters leaves defaults out of the URL", () => {
    expect(explorerLinkFilters("q", "50", "all")).toEqual({ q: "q", pageSize: "", expiration: "" });
    expect(explorerLinkFilters("q", "10", "soon")).toEqual({ q: "q", pageSize: "10", expiration: "soon" });
  });

  test("appendQueryExpression joins with AND", () => {
    expect(appendQueryExpression("", "a = i32(1)")).toBe("a = i32(1)");
    expect(appendQueryExpression("a = i32(1)", "b = true")).toBe("a = i32(1)\n    AND b = true");
  });
});

describe("describeQueryError", () => {
  test("explains each SDK QueryError kind, with the position of a parse error", () => {
    const parse = new QueryError("parse", -32001, "a = i32(1", { position: 9, expected: "')'", got: "end of input" });
    expect(describeQueryError(parse)).toEqual({
      title: "Query syntax error",
      detail: "The query doesn't parse. Expected ')', got end of input.",
      position: 9,
    });
    expect(describeQueryError(new QueryError("type", -32002, "q", undefined)).title).toBe("Type error");
    expect(describeQueryError(new QueryError("cursor", -32005, "q", undefined)).detail).toContain("Run the query again");
  });

  test("names rate limits anywhere in the cause chain", () => {
    const error = new Error("HTTP request failed", { cause: { status: 429 } });
    expect(describeQueryError(error).title).toBe("Rate limited");
  });

  test("falls back to the message for anything else", () => {
    expect(describeQueryError(new Error("boom"))).toEqual({ title: "Query failed", detail: "boom", position: null });
  });

  test("locateQueryPosition finds the line and column", () => {
    expect(locateQueryPosition("a = i32(1)\n    AND b = str('x", 25)).toEqual({ line: 1, column: 14, lineText: "    AND b = str('x" });
    expect(locateQueryPosition("abc", 99)).toEqual({ line: 0, column: 3, lineText: "abc" });
  });
});

describe("block timing", () => {
  const timing: BlockTiming = { currentBlock: 1000n, currentBlockTime: 1_788_382_095, blockDuration: 2 };

  test("estimateBlockTimestampMs walks from the head block", () => {
    expect(estimateBlockTimestampMs(1000n, timing)).toBe(1_788_382_095_000);
    expect(estimateBlockTimestampMs(1010n, timing)).toBe(1_788_382_115_000);
    expect(estimateBlockTimestampMs(900n, timing)).toBe(1_788_381_895_000);
  });

  test("estimateBlockIso gives up on a permanent expiry instead of printing an invalid date", () => {
    expect(estimateBlockIso(1000n, timing)).toBe(new Date(1_788_382_095_000).toISOString());
    expect(estimateBlockIso(MAX_EXPIRES_AT, timing)).toBeNull();
  });

  test("lifetimeProgress reports how much of the lifetime is used", () => {
    expect(lifetimeProgress(0n, 100n, 25n)).toEqual({ consumedPct: 25, leftPct: 75, expired: false });
    expect(lifetimeProgress(0n, 100n, 100n)).toEqual({ consumedPct: 100, leftPct: 0, expired: true });
    expect(lifetimeProgress(50n, 50n, 10n)).toEqual({ consumedPct: 100, leftPct: 0, expired: false });
    expect(lifetimeProgress(0n, MAX_EXPIRES_AT, 10n)).toEqual({ consumedPct: 0, leftPct: 100, expired: false });
  });

  test("isExpiringSoon is a 24h window in front of now", () => {
    const now = 1_788_382_095_000;
    expect(isExpiringSoon(1000n + 3600n, timing, now)).toBe(true); // 2 hours ahead
    expect(isExpiringSoon(1000n + 43_200n + 10n, timing, now)).toBe(false); // just past 24h
    expect(isExpiringSoon(999n, timing, now)).toBe(false); // already expired
    expect(isExpiringSoon(MAX_EXPIRES_AT, timing, now)).toBe(false);
  });

  test("formatRelativeMs picks a sensible unit", () => {
    const now = 0;
    expect(formatRelativeMs(30_000, now)).toBe("in 30 seconds");
    expect(formatRelativeMs(-5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelativeMs(3 * 3_600_000, now)).toBe("in 3 hours");
    expect(formatRelativeMs(2 * 86_400_000, now)).toBe("in 2 days");
    expect(formatRelativeMs(-400 * 86_400_000, now)).toBe("last year");
    expect(formatRelativeMs(Number.MAX_VALUE, now)).toBe("in the far future");
  });
});

describe("typescriptSnippet", () => {
  test("embeds the normalized query in a template literal and never a node URL", () => {
    const snippet = typescriptSnippet(KEY, "0.8.1-dev.1");
    expect(snippet).toContain(`publicClient.query(\`$key = key(${KEY})\``);
    expect(snippet).toContain('http("<RPC URL>")');
    expect(snippet).toContain("@arkiv-network/sdk 0.8.1-dev.1");
  });

  test("escapes backticks and interpolation", () => {
    expect(typescriptSnippet("name = str('`${x}`')", "v")).toContain("str('\\`\\${x}\\`')");
  });
});
