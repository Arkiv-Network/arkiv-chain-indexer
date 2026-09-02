import { describe, expect, test } from "bun:test";
import {
  appendQueryExpression,
  attributeFilterExpression,
  buildQueryParams,
  dataPageFilters,
  decodeQueryResult,
  describeQueryError,
  estimateBlockTimestampMs,
  formatAttributeValue,
  formatQueryLiteral,
  formatRelativeMs,
  isExpiringSoon,
  lifetimeProgress,
  locateQueryPosition,
  normalizeQueryInput,
  resolveExpirationFilter,
  resolvePageSize,
} from "./src/dataQuery";
import { RpcCallError, type BlockTiming } from "./src/dataRpc";

const KEY = "0x325ab0cef69bb69888e120bd3b5e4bd26f02397bf3d6898c6be1d5f361f3a649";
const OWNER = "0xc5b669e2c8d61aedc97d71f934a3c6d1d8c71e4c";

// As answered by the tiramisu node on 2026-09-02 (payload not selected).
const SAMPLE_RESULT = {
  data: [
    {
      key: KEY,
      owner: OWNER,
      creator: OWNER,
      createdAt: "0x17906",
      updatedAt: "0x17906",
      expiresAt: "0x17c8a",
      creationFlags: { readonly: false, permissionlessExtension: false, raw: 0 },
      contentType: "application/octet-stream",
      attributes: [
        { name: "project", type: "str", value: "arkiv-chain-indexer-baseload" },
        { name: "random_number_0", type: "u64", value: "0xa46a036e41c2" },
        { name: "flag", type: "bool", value: true },
        { name: "level", type: "i32", value: 7 },
      ],
    },
  ],
  blockNumber: "0x17906",
  cursor: "b64:D1OSQseliZQAAAAAAAIoRA",
};

describe("normalizeQueryInput", () => {
  test("rewrites a bare entity key into a key query", () => {
    expect(normalizeQueryInput(`  ${KEY} `)).toBe(`$key = key(${KEY})`);
  });

  test("rewrites a bare address into an owner query", () => {
    expect(normalizeQueryInput(OWNER)).toBe(`$owner = addr(${OWNER})`);
  });

  test("leaves an expression alone apart from trimming", () => {
    expect(normalizeQueryInput(" status = str('open') ")).toBe("status = str('open')");
    expect(normalizeQueryInput("0x1234")).toBe("0x1234");
  });
});

describe("page settings", () => {
  test("fall back to the defaults for junk", () => {
    expect(resolvePageSize("50")).toBe("50");
    expect(resolvePageSize("7")).toBe("25");
    expect(resolvePageSize(null)).toBe("25");
    expect(resolveExpirationFilter("soon")).toBe("soon");
    expect(resolveExpirationFilter("later")).toBe("all");
  });

  test("dataPageFilters leaves defaults out of the URL", () => {
    expect(dataPageFilters("*", "25", "all")).toEqual({ q: "*", pageSize: "", expiration: "", rpc: "" });
    expect(dataPageFilters("*", "100", "soon")).toEqual({ q: "*", pageSize: "100", expiration: "soon", rpc: "" });
  });

  test("dataPageFilters names a custom RPC endpoint so the link reproduces the run", () => {
    expect(dataPageFilters("*", "25", "all", " https://rpc.example/x ").rpc).toBe("https://rpc.example/x");
  });
});

describe("buildQueryParams", () => {
  test("selects everything but the payload and encodes the limit as hex", () => {
    const [query, options] = buildQueryParams({ query: "*", pageSize: 25 });
    expect(query).toBe("*");
    expect(options.limit).toBe("0x19");
    expect(options.select).not.toHaveProperty("payload");
    expect(options.select.attributes).toBe(true);
    expect(options).not.toHaveProperty("cursor");
    expect(options).not.toHaveProperty("atBlock");
  });

  test("clamps the limit to the node's maximum", () => {
    expect(buildQueryParams({ query: "*", pageSize: 1000 })[1].limit).toBe("0xc8");
    expect(buildQueryParams({ query: "*", pageSize: 0 })[1].limit).toBe("0x1");
  });

  test("resumes a cursor at the block its page was read at", () => {
    const [, options] = buildQueryParams({ query: "*", pageSize: 5, cursor: "b64:abc", atBlock: 96518 });
    expect(options.cursor).toBe("b64:abc");
    expect(options.atBlock).toBe("0x17906");
  });

  test("refuses a cursor without its block", () => {
    expect(() => buildQueryParams({ query: "*", pageSize: 5, cursor: "b64:abc" })).toThrow(/atBlock|block/);
  });
});

describe("decodeQueryResult", () => {
  test("decodes the node's shape into numbers and display strings", () => {
    const page = decodeQueryResult(SAMPLE_RESULT);
    expect(page.blockNumber).toBe(96518);
    expect(page.cursor).toBe("b64:D1OSQseliZQAAAAAAAIoRA");
    expect(page.entities).toHaveLength(1);
    const entity = page.entities[0];
    expect(entity.key).toBe(KEY);
    expect(entity.owner).toBe(OWNER);
    expect(entity.createdAt).toBe(96518);
    expect(entity.expiresAt).toBe(97418);
    expect(entity.creationFlags).toEqual({ readonly: false, permissionlessExtension: false, raw: 0 });
    expect(entity.contentType).toBe("application/octet-stream");
    expect(entity.attributes).toEqual([
      { name: "project", type: "str", value: "arkiv-chain-indexer-baseload" },
      { name: "random_number_0", type: "u64", value: "180775231046082" },
      { name: "flag", type: "bool", value: "true" },
      { name: "level", type: "i32", value: "7" },
    ]);
  });

  test("tolerates fields the query did not select", () => {
    const page = decodeQueryResult({ data: [{ key: KEY }], blockNumber: "0x1" });
    expect(page.cursor).toBeNull();
    expect(page.entities[0]).toEqual({
      key: KEY,
      owner: null,
      creator: null,
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      creationFlags: null,
      contentType: null,
      attributes: [],
    });
  });

  test("rejects a result without a data array", () => {
    expect(() => decodeQueryResult({ blockNumber: "0x1" })).toThrow(/data array/);
    expect(() => decodeQueryResult(null)).toThrow();
  });
});

describe("attribute formatting", () => {
  test("formatAttributeValue renders integers in decimal and passes strings through", () => {
    expect(formatAttributeValue("u256", "0xde0b6b3a7640000")).toBe("1000000000000000000");
    expect(formatAttributeValue("i32", -5)).toBe("-5");
    expect(formatAttributeValue("u64", "12")).toBe("12");
    expect(formatAttributeValue("dec", "3.5")).toBe("3.5");
    expect(formatAttributeValue("bool", "false")).toBe("false");
    expect(formatAttributeValue("addr", OWNER)).toBe(OWNER);
    expect(formatAttributeValue("str", { odd: true })).toBe('{"odd":true}');
  });

  test("formatQueryLiteral writes the 0.8 typed literal", () => {
    expect(formatQueryLiteral("str", "it's")).toBe("str('it''s')");
    expect(formatQueryLiteral("bool", "true")).toBe("true");
    expect(formatQueryLiteral("u64", "12")).toBe("u64(12)");
    expect(formatQueryLiteral("addr", OWNER)).toBe(`addr(${OWNER})`);
  });

  test("attributeFilterExpression and appendQueryExpression build the next query", () => {
    const expr = attributeFilterExpression({ name: "status", type: "str", value: "open" });
    expect(expr).toBe("status = str('open')");
    expect(appendQueryExpression("", expr)).toBe(expr);
    expect(appendQueryExpression("  ", expr)).toBe(expr);
    expect(appendQueryExpression("*", expr)).toBe(expr);
    expect(appendQueryExpression("level > i32(1)", expr)).toBe("level > i32(1)\n    AND status = str('open')");
  });
});

describe("describeQueryError", () => {
  test("surfaces the node's syntax message and position", () => {
    const error = new RpcCallError("arkiv_query", "arkiv_query was rejected (-32001): unterminated typed literal", {
      code: -32001,
      data: { message: "unterminated typed literal — expected a closing ')'", position: 9 },
    });
    expect(describeQueryError(error)).toEqual({
      title: "Query syntax error",
      detail: "unterminated typed literal — expected a closing ')'",
      position: 9,
    });
  });

  test("names unsupported operators, rate limits, and missing methods", () => {
    expect(
      describeQueryError(new RpcCallError("arkiv_query", "x", { code: -32002, data: { message: "exists(…) is not supported" } }))
        .title,
    ).toBe("Unsupported query");
    expect(describeQueryError(new RpcCallError("arkiv_query", "arkiv_query answered HTTP 429", { httpStatus: 429 })).title).toBe(
      "Rate limited",
    );
    const missing = describeQueryError(new RpcCallError("arkiv_query", "arkiv_query was rejected (-32601): Method not found", { code: -32601 }));
    expect(missing.title).toBe("Method not available");
    expect(missing.detail).toContain("Method not found");
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
  const timing: BlockTiming = { currentBlock: 1000, currentBlockTime: 1_788_382_095, blockDurationSeconds: 2 };

  test("estimateBlockTimestampMs walks from the head block", () => {
    expect(estimateBlockTimestampMs(1000, timing)).toBe(1_788_382_095_000);
    expect(estimateBlockTimestampMs(1010, timing)).toBe(1_788_382_115_000);
    expect(estimateBlockTimestampMs(900, timing)).toBe(1_788_381_895_000);
  });

  test("lifetimeProgress reports how much of the lifetime is used", () => {
    expect(lifetimeProgress(0, 100, 25)).toEqual({ consumedPct: 25, leftPct: 75, expired: false });
    expect(lifetimeProgress(0, 100, 100)).toEqual({ consumedPct: 100, leftPct: 0, expired: true });
    expect(lifetimeProgress(50, 50, 10)).toEqual({ consumedPct: 100, leftPct: 0, expired: false });
    expect(lifetimeProgress(200, 300, 10).consumedPct).toBe(0);
  });

  test("isExpiringSoon is a 24h window in front of now", () => {
    const now = 1_788_382_095_000;
    expect(isExpiringSoon(1000 + 3600, timing, now)).toBe(true); // 2 hours ahead
    expect(isExpiringSoon(1000 + 43_200 + 10, timing, now)).toBe(false); // just past 24h
    expect(isExpiringSoon(999, timing, now)).toBe(false); // already expired
    expect(isExpiringSoon(null, timing, now)).toBe(false);
  });

  test("formatRelativeMs picks a sensible unit", () => {
    const now = 0;
    expect(formatRelativeMs(30_000, now)).toBe("in 30 seconds");
    expect(formatRelativeMs(-5 * 60_000, now)).toBe("5 minutes ago");
    expect(formatRelativeMs(3 * 3_600_000, now)).toBe("in 3 hours");
    expect(formatRelativeMs(2 * 86_400_000, now)).toBe("in 2 days");
    expect(formatRelativeMs(-400 * 86_400_000, now)).toBe("last year");
  });
});
