import { describe, expect, test } from "bun:test";
import {
  MAX_ATTRIBUTE_NAME_BYTES,
  MAX_NESTING_DEPTH,
  MAX_PREDICATES,
  MAX_QUERY_BYTES,
  QueryParseError,
  parseEntityQuery,
  queryErrorBody,
  type QueryAst,
  type QueryParseErrorKind,
} from "./entityQueryLanguage";

const addrHex = (byte: string) => `0x${byte.repeat(20)}`;
const wordHex = (byte: string) => `0x${byte.repeat(32)}`;

function fail(query: string): QueryParseError {
  try {
    parseEntityQuery(query);
  } catch (error) {
    if (error instanceof QueryParseError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(query)} to be rejected`);
}

function kindOf(query: string): QueryParseErrorKind {
  return fail(query).kind;
}

/** What the live cheesecake node answered on 2026-09-03 (code, message, position). */
function expectNodeVerdict(query: string, code: number, message: string, position: number): void {
  const error = fail(query);
  expect(error.rpcCode).toBe(code);
  expect(error.message).toBe(message);
  expect(error.position).toBe(position);
}

const eq = (name: string, value: unknown): QueryAst => ({
  kind: "compare",
  op: "eq",
  key: { kind: "user", name },
  value: value as QueryAst extends { value: infer V } ? V : never,
});

describe("typed literals", () => {
  test("every tag parses to its own type", () => {
    expect(parseEntityQuery("level = i32(10)")).toEqual(eq("level", { type: "i32", value: 10 }));
    expect(parseEntityQuery("balance = u256(1000000)")).toEqual(eq("balance", { type: "u256", value: 1_000_000n }));
    expect(parseEntityQuery("height = u64(42)")).toEqual(eq("height", { type: "u64", value: 42n }));
    expect(parseEntityQuery("name = str('Bob')")).toEqual(eq("name", { type: "str", value: "Bob" }));
    expect(parseEntityQuery("flagged = true")).toEqual(eq("flagged", { type: "bool", value: true }));
    expect(parseEntityQuery("flagged = false")).toEqual(eq("flagged", { type: "bool", value: false }));
    expect(parseEntityQuery(`parent = key(${wordHex("AB")})`)).toEqual(eq("parent", { type: "key", value: wordHex("ab") }));
    expect(parseEntityQuery(`hash = bytes32(${wordHex("cd")})`)).toEqual(eq("hash", { type: "bytes32", value: wordHex("cd") }));
    expect(parseEntityQuery(`who = addr(${addrHex("ab")})`)).toEqual(eq("who", { type: "addr", value: addrHex("ab") }));
    expect(parseEntityQuery("score = dec(3.5)")).toEqual(eq("score", { type: "dec", units: 3_500_000_000_000_000_000n }));
  });

  test("the same number under two tags is two different predicates", () => {
    expect(parseEntityQuery("level = i32(10)")).not.toEqual(parseEntityQuery("level = u256(10)"));
  });

  test("a bare number is an i32 and only an i32", () => {
    expect(parseEntityQuery("level = 10")).toEqual(parseEntityQuery("level = i32(10)"));
    expect(parseEntityQuery("level = -10")).toEqual(eq("level", { type: "i32", value: -10 }));
    expect(kindOf("level = 2147483648")).toBe("literal");
    expect(kindOf("name = 'Bob'")).toBe("type");
  });

  test("literal validation errors are their own kind", () => {
    expect(kindOf("level = i32(2147483648)")).toBe("literal");
    expect(kindOf("score = dec(0.1234567890123456789)")).toBe("literal");
    expect(kindOf("who = addr(0xdead)")).toBe("literal");
    expect(kindOf("parent = key(0xdead)")).toBe("literal");
  });

  test("i32 covers its whole range and names the fix past it", () => {
    expect(parseEntityQuery("a = i32(2147483647)")).toEqual(eq("a", { type: "i32", value: 2147483647 }));
    expect(parseEntityQuery("a = i32(-2147483648)")).toEqual(eq("a", { type: "i32", value: -2147483648 }));
    expect(parseEntityQuery("a = i32(+7)")).toEqual(eq("a", { type: "i32", value: 7 }));
    expect(kindOf("a = i32(-2147483649)")).toBe("literal");
    expect(fail("a = i32(99999999999)").message).toContain("u256");
    expect(fail("a = i32()").message).toBe("i32 expects a number");
    expect(fail("a = i32(12a)").message).toBe("i32 expects decimal digits");
  });

  test("u64 accepts decimal and hex within range", () => {
    expect(parseEntityQuery("a = u64(0)")).toEqual(eq("a", { type: "u64", value: 0n }));
    expect(parseEntityQuery("a = u64(0x1a)")).toEqual(eq("a", { type: "u64", value: 26n }));
    expect(parseEntityQuery("a = u64(18446744073709551615)")).toEqual(eq("a", { type: "u64", value: 18446744073709551615n }));
    expect(parseEntityQuery("a = u64(0xffffffffffffffff)")).toEqual(eq("a", { type: "u64", value: 18446744073709551615n }));
    expect(fail("a = u64(18446744073709551616)").message).toBe("value is out of range for u64");
    expect(fail("a = u64(-1)").message).toBe("u64 is unsigned — remove the sign, or use i32(…)");
    expect(fail("a = u64(0x10000000000000000)").message).toContain("1 to 16 digits");
    expect(fail("a = u64(0x)").message).toContain("1 to 16 digits");
    expect(fail("a = u64(nope)").message).toBe("u64 expects decimal digits");
  });

  test("u256 takes decimal and hex up to its maximum", () => {
    expect(parseEntityQuery("a = u256(0xf4240)")).toEqual(eq("a", { type: "u256", value: 1_000_000n }));
    expect(parseEntityQuery("a = u256(0X01)")).toEqual(eq("a", { type: "u256", value: 1n }));
    expect(parseEntityQuery(`a = u256(0x${"0".repeat(100)}5)`)).toEqual(eq("a", { type: "u256", value: 5n }));
    expect(parseEntityQuery(`a = u256(0x${"f".repeat(64)})`)).toEqual(eq("a", { type: "u256", value: (1n << 256n) - 1n }));
    expect(kindOf(`a = u256(0x${"f".repeat(65)})`)).toBe("literal");
    expect(kindOf("a = u256(115792089237316195423570985008687907853269984665640564039457584007913129639936)")).toBe("literal");
    expect(parseEntityQuery("a = u256(115792089237316195423570985008687907853269984665640564039457584007913129639935)")).toEqual(
      eq("a", { type: "u256", value: (1n << 256n) - 1n }),
    );
    expect(kindOf("a = u256(-1)")).toBe("literal");
    expect(kindOf("a = u256(+1)")).toBe("literal");
    expect(fail("a = u256(0xzz)").message).toBe("u256 contains a non-hex digit");
  });

  test("dec scales by eighteen places and keeps its sign", () => {
    expect(parseEntityQuery("a = dec(1.5)")).toEqual(eq("a", { type: "dec", units: 1_500_000_000_000_000_000n }));
    expect(parseEntityQuery("a = dec(3)")).toEqual(eq("a", { type: "dec", units: 3_000_000_000_000_000_000n }));
    expect(parseEntityQuery("a = dec(0)")).toEqual(eq("a", { type: "dec", units: 0n }));
    expect(parseEntityQuery("a = dec(3.50)")).toEqual(parseEntityQuery("a = dec(3.5)"));
    expect(parseEntityQuery("a = dec(-1)")).toEqual(eq("a", { type: "dec", units: -1_000_000_000_000_000_000n }));
    expect(parseEntityQuery("a = dec(0.123456789012345678)")).toEqual(eq("a", { type: "dec", units: 123456789012345678n }));
    expect(fail("a = dec(0.1234567890123456789)").message).toContain("never rounded");
    expect(fail("a = dec(.5)").message).toContain("before the decimal point");
    expect(fail("a = dec(1.)").message).toContain("after the decimal point");
    expect(fail("a = dec(1e10)").message).toBe("dec expects decimal digits");
    expect(fail("a = dec(1.2.3)").message).toBe("dec expects decimal digits");
    expect(fail("a = dec()").message).toContain("before the decimal point");
  });

  test("str unquotes, escapes doubled quotes and bounds length", () => {
    expect(parseEntityQuery("a = str('')")).toEqual(eq("a", { type: "str", value: "" }));
    expect(parseEntityQuery("a = str('it''s')")).toEqual(eq("a", { type: "str", value: "it's" }));
    expect(parseEntityQuery("a = str('a)b')")).toEqual(eq("a", { type: "str", value: "a)b" }));
    expect(parseEntityQuery("a = str( 'spaced' )")).toEqual(eq("a", { type: "str", value: "spaced" }));
    expect(parseEntityQuery("a = str('zażółć')")).toEqual(eq("a", { type: "str", value: "zażółć" }));
    expect(parseEntityQuery(`a = str('${"a".repeat(128)}')`)).toBeDefined();
    expect(fail(`a = str('${"a".repeat(129)}')`).message).toBe("str values are limited to 128 bytes of UTF-8");
    expect(fail(`a = str('${"ż".repeat(65)}')`).message).toBe("str values are limited to 128 bytes of UTF-8");
    expect(fail("a = str(Bob)").message).toContain("str('Bob')");
    expect(fail("a = str('a' b)").message).toContain("after the closing quote");
  });

  test("addr accepts uniform case and checks EIP-55 on mixed case", () => {
    expect(parseEntityQuery(`a = addr(${addrHex("AB")})`)).toEqual(eq("a", { type: "addr", value: addrHex("ab") }));
    expect(parseEntityQuery(`a = addr(0x${"1".repeat(40)})`)).toBeDefined();
    for (const checksummed of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      expect(parseEntityQuery(`a = addr(${checksummed})`)).toEqual(eq("a", { type: "addr", value: checksummed.toLowerCase() }));
    }
    expect(fail("a = addr(0x5aAeb6053f3E94C9b9A09f33669435E7Ef1BeAed)").message).toContain("EIP-55");
    expect(fail("a = addr(0xdead)").message).toBe("an address is 0x followed by exactly 40 hex digits");
    expect(fail(`a = addr(${"a".repeat(40)})`).message).toContain("0x-prefixed");
    expect(fail(`a = addr(0x${"z".repeat(40)})`).message).toBe("addr contains a non-hex digit");
  });

  test("key and bytes32 need exactly 64 hex digits, any case", () => {
    expect(parseEntityQuery(`a = key(${wordHex("cD")})`)).toEqual(eq("a", { type: "key", value: wordHex("cd") }));
    expect(fail("a = key(0xcd)").message).toBe("expected 0x followed by exactly 64 hex digits");
    expect(fail(`a = bytes32(${"cd".repeat(32)})`).message).toBe("expected a 0x-prefixed 32-byte value");
    expect(fail(`a = key(0x${"g".repeat(64)})`).message).toBe("key contains a non-hex digit");
  });

  test("bool rejects the wrapper form", () => {
    expectNodeVerdict("flag = bool(true)", -32003, "bool takes no wrapper — write the literal true or false", 12);
  });
});

describe("the operator × type matrix", () => {
  test("ranges are allowed on the numeric types", () => {
    for (const query of [
      "level > i32(1)",
      "level >= i32(1)",
      "level < i32(1)",
      "level <= i32(1)",
      "balance > u256(1)",
      "height >= u64(1)",
      "score >= dec(3.5)",
      "level > 5",
    ]) {
      expect(parseEntityQuery(query)).toBeDefined();
    }
  });

  test("ranges are rejected on the unordered types", () => {
    for (const query of [
      "flagged > true",
      "name > str('a')",
      `who > addr(${addrHex("ab")})`,
      `parent > key(${wordHex("ab")})`,
      `hash > bytes32(${wordHex("ab")})`,
    ]) {
      const error = fail(query);
      expect(error.kind).toBe("type");
      expect(error.message).toContain("no ordering");
    }
    expectNodeVerdict("project > str('a')", -32002, "str values have no ordering — only i32, u64, u256 and dec support < <= > >=", 10);
  });

  test("STARTSWITH takes strings only", () => {
    expect(parseEntityQuery("desc STARTSWITH str('ab')")).toEqual({
      kind: "startsWith",
      key: { kind: "user", name: "desc" },
      value: { type: "str", value: "ab" },
    });
    expect(parseEntityQuery("desc startswith str('ab')")).toBeDefined();
    expect(kindOf("level STARTSWITH i32(1)")).toBe("type");
    expect(kindOf("flagged STARTSWITH true")).toBe("type");
    expectNodeVerdict("project STARTSWITH 'arkiv'", -32002, "untagged strings are only valid for system attributes — write str('…')", 19);
  });
});

describe("system attributes", () => {
  test("resolve and type-check", () => {
    expect(parseEntityQuery(`$owner = addr(${addrHex("ab")})`)).toEqual({
      kind: "compare",
      op: "eq",
      key: { kind: "builtin", field: "owner" },
      value: { type: "addr", value: addrHex("ab") },
    });
    expect(parseEntityQuery(`$creator = addr(${addrHex("cd")})`)).toMatchObject({ key: { field: "creator" } });
    expect(parseEntityQuery(`$key = key(${wordHex("ab")})`)).toMatchObject({ key: { field: "key" } });
    expect(parseEntityQuery("$contentType = str('text/plain')")).toEqual({
      kind: "compare",
      op: "eq",
      key: { kind: "builtin", field: "contentType" },
      value: { type: "str", value: "text/plain" },
    });
    expect(parseEntityQuery("$contentType STARTSWITH str('application')")).toMatchObject({ kind: "startsWith" });
  });

  test("block heights need the u64 tag and range freely", () => {
    expect(parseEntityQuery("$expiresAt < u64(1200000)")).toEqual({
      kind: "compare",
      op: "lt",
      key: { kind: "builtin", field: "expiresAt" },
      value: { type: "u64", value: 1_200_000n },
    });
    expect(parseEntityQuery("$createdAt >= u64(7)")).toMatchObject({ op: "gte", key: { field: "createdAt" } });
    expectNodeVerdict("$expiresAt > 1", -32002, "this system attribute holds u64 — write u64(1)", 13);
    expectNodeVerdict("$expiresAt > i32(1)", -32002, "this system attribute holds u64, but the value is i32", 13);
    expect(fail("$createdAt >= 1").position).toBe(14);
  });

  test("accept their quoted hex forms", () => {
    expect(parseEntityQuery(`$owner = '${addrHex("ab")}'`)).toEqual(parseEntityQuery(`$owner = addr(${addrHex("ab")})`));
    expect(parseEntityQuery(`$key = '${wordHex("ab")}'`)).toEqual(parseEntityQuery(`$key = key(${wordHex("ab")})`));
    expect(parseEntityQuery("$contentType = 'text/plain'")).toEqual(parseEntityQuery("$contentType = str('text/plain')"));
    expect(kindOf("$expiresAt = '5'")).toBe("type");
  });

  test("reject the wrong type", () => {
    expect(kindOf("$owner = i32(5)")).toBe("type");
    expect(kindOf("$expiresAt = str('soon')")).toBe("type");
    expect(kindOf("$contentType = i32(1)")).toBe("type");
    expect(kindOf("$key = true")).toBe("type");
    expectNodeVerdict("$owner = str('x')", -32002, "this system attribute holds addr, but the value is str", 9);
    expectNodeVerdict(
      `$key = bytes32(${wordHex("2a")})`,
      -32002,
      "this system attribute holds key, but the value is bytes32",
      7,
    );
    expectNodeVerdict(
      "$owner = addr(0x07974C7C641dF9004c362Db2b930A0Da4F761d6E)",
      -32003,
      "address fails its EIP-55 checksum — fix the capitalization, or write it all-lowercase",
      14,
    );
    expect(fail("$owner = addr(0x07974c7c641df9004c362db2b930a0da4f761d6e) AND $owner = 5").message).toBe(
      "this system attribute holds addr, but the value is an untagged number (which means i32)",
    );
  });

  test("unqueryable and renamed system attributes say so", () => {
    for (const [query, hint] of [
      ["$updatedAt > 1", "projections only"],
      ["$creationFlags = true", "projections only"],
      ["$payload = str('x')", "no index"],
      ["$expiration > 1", "$expiresAt"],
      ["$createdAtBlock > 1", "$createdAt"],
      ["$nope = true", "unknown system attribute"],
    ] as const) {
      const error = fail(query);
      expect(error.kind).toBe("type");
      expect(error.message).toContain(hint);
    }
    expectNodeVerdict(
      "$all",
      -32002,
      "unknown system attribute $all — expected $key, $owner, $creator, $expiresAt, $createdAt or $contentType",
      0,
    );
    expectNodeVerdict("$updatedAt >= u64(1)", -32002, "$updatedAt is not queryable — it is returned by projections only", 0);
    expectNodeVerdict("$payload = str('x')", -32002, "$payload is not queryable — bytes values carry no index", 0);
  });
});

describe("what this version deliberately leaves out", () => {
  test("cut operators name their replacement", () => {
    expectNodeVerdict(
      "project != str('x')",
      -32002,
      "!= is not part of the query language — write NOT (attr = value) for the complement",
      8,
    );
    expectNodeVerdict(
      "EXISTS(project)",
      -32002,
      "exists(…) is not supported — the index has no per-attribute presence set in this version",
      0,
    );
    expectNodeVerdict(
      "TYPEOF(project) = str",
      -32002,
      "typeof(…) is not supported — a value predicate already asserts the attribute's type",
      0,
    );
  });

  test("the removed symbol operators are gone", () => {
    for (const query of ["a = true && b = true", "a = true || b = true", "!(a = true)", "name ~ 'ab*'"]) {
      expect(kindOf(query)).toBe("malformed");
    }
    expectNodeVerdict(
      "project = str('a') && project = str('b')",
      -32001,
      "symbol operators (&& || ~) were removed — use AND, OR, STARTSWITH",
      19,
    );
    expect(fail("!(a = true)").message).toBe("unexpected '!' — negation is written NOT");
    // IN is gone too — the comma is not even a token.
    expectNodeVerdict("project IN (str('a'), str('b'))", -32001, "unexpected character", 20);
    expectNodeVerdict('project = "x"', -32001, "unexpected character", 10);
  });
});

describe("boolean structure", () => {
  test("precedence is NOT, then AND, then OR", () => {
    expect(parseEntityQuery("a = true OR b = true AND c = true")).toMatchObject({
      kind: "or",
      right: { kind: "and" },
    });
    expect(parseEntityQuery("NOT a = true AND b = true")).toMatchObject({
      kind: "and",
      left: { kind: "not" },
    });
    expect(parseEntityQuery("(a = true OR b = true) AND c = true")).toMatchObject({
      kind: "and",
      left: { kind: "or" },
    });
  });

  test("connectives are left-associative", () => {
    expect(parseEntityQuery("a = true AND b = true AND c = true")).toMatchObject({ kind: "and", left: { kind: "and" } });
    expect(parseEntityQuery("a = true OR b = true OR c = true")).toMatchObject({ kind: "or", left: { kind: "or" } });
  });

  test("nested NOTs and groups collapse cleanly", () => {
    expect(parseEntityQuery("NOT NOT a = true")).toMatchObject({ kind: "not", inner: { kind: "not" } });
    expect(parseEntityQuery("((a = true))")).toMatchObject({ kind: "compare" });
    expect(parseEntityQuery("((((project = str('x'))))) OR (project = str('y') AND NOT (n = 1))")).toMatchObject({ kind: "or" });
  });

  test("the star selector stands alone", () => {
    expect(parseEntityQuery("*")).toEqual({ kind: "all" });
    expect(parseEntityQuery("  *  ")).toEqual({ kind: "all" });
    expectNodeVerdict("* AND project = str('x')", -32001, "* matches every entity and cannot be combined with other predicates", 2);
    expect(kindOf("$all")).toBe("type");
  });
});

describe("lexical surface", () => {
  test("comments and whitespace are insignificant", () => {
    const spread = `
        level >= i32(10)   -- at least ten
    AND name  =  str('Bob') -- and named Bob
    `;
    expect(parseEntityQuery(spread)).toEqual(parseEntityQuery("level >= i32(10) AND name = str('Bob')"));
    expect(parseEntityQuery("a -- trailing\n= true")).toEqual(eq("a", { type: "bool", value: true }));
  });

  test("keywords are case-insensitive, names are not", () => {
    expect(parseEntityQuery("a = true and b = true")).toMatchObject({ kind: "and" });
    expect(parseEntityQuery("a = true Or b = true")).toMatchObject({ kind: "or" });
    expect(parseEntityQuery("not a = TRUE")).toMatchObject({ kind: "not" });
    expect(parseEntityQuery("Level = true")).not.toEqual(parseEntityQuery("level = true"));
  });

  test("type tags are only tags in front of a paren", () => {
    expect(parseEntityQuery("a = dec (3.5)")).toEqual(parseEntityQuery("a = dec(3.5)"));
    expect(fail("str = true").message).toContain("type name");
    expect(fail("i32 = true").message).toBe("i32 is a type name and cannot be an attribute name");
  });

  test("names take dots, dashes and underscores but do not start with them", () => {
    expect(parseEntityQuery("my.attr-name_2 = str('x')")).toMatchObject({ key: { name: "my.attr-name_2" } });
    expectNodeVerdict("_x = str('x')", -32001, "unexpected character", 0);
    expect(fail("-name = true").message).toBe("expected digits after the sign");
  });

  test("reserved words cannot be attributes", () => {
    expect(fail("and = true").message).toBe("a reserved word cannot be used as an attribute name");
    // `not` lexes as negation, so what follows it has to be a predicate.
    expect(fail("not = true").message).toBe("expected an attribute name");
  });

  test("bare hex literals are rejected with the tagged forms", () => {
    const error = fail("$owner = 0xabcdef");
    expect(error.message).toContain("addr(0x…)");
    expect(error.position).toBe(9);
    expect(kindOf("h = 0Xdead")).toBe("malformed");
    expect(parseEntityQuery("a = 0")).toEqual(eq("a", { type: "i32", value: 0 }));
  });

  test("system names need a name after the dollar", () => {
    expect(fail("$ = 1").message).toBe("expected a system attribute name after '$'");
  });

  test("over-long attribute names are rejected", () => {
    expect(kindOf(`${"a".repeat(MAX_ATTRIBUTE_NAME_BYTES + 1)} = true`)).toBe("malformed");
    expect(parseEntityQuery(`${"a".repeat(MAX_ATTRIBUTE_NAME_BYTES)} = true`)).toBeDefined();
  });

  test("malformed queries are syntax errors with positions", () => {
    for (const query of [
      "",
      "level =",
      "= i32(1)",
      "level",
      "level = i32(1) AND",
      "(level = i32(1)",
      "level = = i32(1)",
      "level = i32(1) name = str('x')",
      "name = str('oops",
      "name = str('ok'",
    ]) {
      const error = fail(query);
      expect(error.kind).toBe("malformed");
      expect(error.position).toBeDefined();
    }
    expectNodeVerdict("", -32001, "empty query — write a predicate, or * to match every entity", 0);
    expectNodeVerdict("   ", -32001, "empty query — write a predicate, or * to match every entity", 0);
    expectNodeVerdict("-- hi", -32001, "empty query — write a predicate, or * to match every entity", 0);
    expect(fail("level = i32(1) name = str('x')").message).toContain("trailing input");
    expect(fail("(level = i32(1)").message).toBe("unclosed group — expected ')'");
    expect(fail("name = str('ok'").message).toContain("closing ')'");
    expect(fail("level =").message).toBe("expected a value, e.g. i32(10) or str('Bob')");
    expect(fail("level").message).toContain("after the attribute");
  });

  test("positions are byte offsets", () => {
    // 'ż' is two bytes, so the error after it lands one byte further than its character index.
    expect(fail("a = str('ż') b").position).toBe(14);
    expectNodeVerdict("project = u64('x')", -32003, "u64 expects decimal digits", 14);
    expectNodeVerdict(
      "n = i32(3000000000)",
      -32003,
      "value is out of range for i32 [-2147483648, 2147483647] — use u256(…) for larger numbers",
      8,
    );
  });
});

describe("limits", () => {
  test("oversized queries are limit errors", () => {
    const long = `name = str('${"a".repeat(MAX_QUERY_BYTES)}')`;
    const tooLong = fail(long);
    expect(tooLong.kind).toBe("limit");
    expect(tooLong.rpcCode).toBe(-32004);
    expect(tooLong.position).toBeUndefined();

    const many = Array.from({ length: MAX_PREDICATES + 1 }, (_unused, index) => `a${index} = true`).join(" AND ");
    expect(kindOf(many)).toBe("limit");
    const atLimit = Array.from({ length: MAX_PREDICATES }, (_unused, index) => `a${index} = true`).join(" AND ");
    expect(parseEntityQuery(atLimit)).toBeDefined();

    const depth = MAX_NESTING_DEPTH + 1;
    expect(kindOf(`${"(".repeat(depth)}a = true${")".repeat(depth)}`)).toBe("limit");
    expect(kindOf(`${"NOT ".repeat(depth)}a = true`)).toBe("limit");
    expect(kindOf("(".repeat(200))).toBe("limit");
  });

  test("the spec's example query parses", () => {
    const query = `    level       >= i32(10)
             AND balance     >  u256(1000000)
             AND score       >= dec(3.5)
             AND score       <= dec(5)
             AND name        =  str('Bob')
             AND desc        STARTSWITH str('ab')
             AND parent      =  key(${wordHex("12")})
             AND hash        =  bytes32(${wordHex("45")})
             AND flagged     =  true
             AND $owner      =  addr(${addrHex("ab")})
             AND $expiresAt  <  u64(1200000)`;
    expect(parseEntityQuery(query)).toBeDefined();
  });
});

describe("queryErrorBody", () => {
  test("carries the code, message and position the way the node does", () => {
    expect(queryErrorBody(fail("$createdAt >= 1"))).toEqual({
      code: -32002,
      message: "this system attribute holds u64 — write u64(1)",
      data: { position: 14, message: "this system attribute holds u64 — write u64(1)" },
    });
    expect(queryErrorBody(fail("(".repeat(200)))).toMatchObject({ code: -32004, data: { message: "query is nested too deeply" } });
    expect(queryErrorBody(fail(`a = str('${"a".repeat(MAX_QUERY_BYTES)}')`)).data).toEqual({ message: "query is too long" });
  });
});
