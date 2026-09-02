import { describe, expect, test } from "bun:test";
import { parseEntityQuery } from "./entityQueryLanguage";
import { compileEntityQuery, likePrefixPattern, queryValueOperand } from "./entityQuerySql";

const ATTRS = '"public".entity_version_attributes';
const compile = (query: string, paramOffset = 0) =>
  compileEntityQuery(parseEntityQuery(query), { attributesTable: ATTRS, paramOffset });

describe("compileEntityQuery", () => {
  test("* is TRUE and binds nothing", () => {
    expect(compile("*")).toEqual({ text: "TRUE", params: [] });
  });

  test("a user attribute predicate is a correlated EXISTS on the same version", () => {
    const { text, params } = compile("level >= i32(10)");
    expect(text).toBe(
      `(EXISTS (SELECT 1 FROM ${ATTRS} a WHERE a.entity_key = v.entity_key AND a.version = v.version` +
        " AND a.name = $1 AND a.type_id = $2::smallint AND a.value_num >= $3::numeric))",
    );
    expect(params).toEqual(["level", 2, "10"]);
  });

  test("unordered types compare the canonical text", () => {
    expect(compile("name = str('Bob')")).toMatchObject({ params: ["name", 8, "Bob"] });
    expect(compile("name = str('Bob')").text).toContain("a.value_text = $3)");
    expect(compile("flag = true")).toMatchObject({ params: ["flag", 1, "true"] });
    expect(compile(`who = addr(0x${"AB".repeat(20)})`)).toMatchObject({ params: ["who", 9, `0x${"ab".repeat(20)}`] });
    expect(compile(`parent = key(0x${"cd".repeat(32)})`)).toMatchObject({ params: ["parent", 10, `0x${"cd".repeat(32)}`] });
  });

  test("ordered types compare the scaled numeric", () => {
    expect(compile("score >= dec(3.5)")).toMatchObject({ params: ["score", 5, "3500000000000000000"] });
    expect(compile("score = dec(-1)")).toMatchObject({ params: ["score", 5, "-1000000000000000000"] });
    expect(compile("balance > u256(0xff)")).toMatchObject({ params: ["balance", 4, "255"] });
    expect(compile("height = u64(7)").text).toContain("a.value_num = $3::numeric");
  });

  test("STARTSWITH is an escaped LIKE prefix", () => {
    const { text, params } = compile("desc STARTSWITH str('50%_off\\')");
    expect(text).toContain("a.value_text LIKE $3 ESCAPE '\\'");
    expect(params[2]).toBe("50\\%\\_off\\\\%");
    expect(likePrefixPattern("plain")).toBe("plain%");
  });

  test("system attributes hit the version columns", () => {
    expect(compile(`$owner = addr(0x${"ab".repeat(20)})`)).toEqual({ text: "(v.owner = $1)", params: [`0x${"ab".repeat(20)}`] });
    expect(compile(`$creator = '0x${"ab".repeat(20)}'`)).toEqual({ text: "(v.creator = $1)", params: [`0x${"ab".repeat(20)}`] });
    expect(compile(`$key = key(0x${"cd".repeat(32)})`)).toEqual({ text: "(v.entity_key = $1)", params: [`0x${"cd".repeat(32)}`] });
    expect(compile("$expiresAt < u64(1200000)")).toEqual({ text: "(v.expires_at < $1::numeric)", params: ["1200000"] });
    expect(compile("$createdAt >= u64(0x10)")).toEqual({ text: "(v.created_at >= $1::bigint)", params: ["16"] });
    expect(compile("$contentType = str('text/plain')")).toEqual({ text: "(v.content_type = $1)", params: ["text/plain"] });
    expect(compile("$contentType STARTSWITH str('image/')")).toEqual({
      text: "(v.content_type LIKE $1 ESCAPE '\\')",
      params: ["image/%"],
    });
  });

  test("boolean structure and parameter numbering survive nesting and an offset", () => {
    const { text, params } = compile("NOT (a = true OR b = 2) AND $owner = addr(0x" + "ab".repeat(20) + ")", 3);
    expect(text).toBe(
      "((NOT ((EXISTS (SELECT 1 FROM " +
        ATTRS +
        " a WHERE a.entity_key = v.entity_key AND a.version = v.version AND a.name = $4 AND a.type_id = $5::smallint AND a.value_text = $6))" +
        " OR (EXISTS (SELECT 1 FROM " +
        ATTRS +
        " a WHERE a.entity_key = v.entity_key AND a.version = v.version AND a.name = $7 AND a.type_id = $8::smallint AND a.value_num = $9::numeric)))) AND (v.owner = $10))",
    );
    expect(params).toEqual(["a", 1, "true", "b", 2, "2", `0x${"ab".repeat(20)}`]);
  });

  test("queryValueOperand renders every type", () => {
    expect(queryValueOperand({ type: "bool", value: false })).toBe("false");
    expect(queryValueOperand({ type: "i32", value: -7 })).toBe("-7");
    expect(queryValueOperand({ type: "u64", value: 5n })).toBe("5");
    expect(queryValueOperand({ type: "dec", units: 15n })).toBe("15");
    expect(queryValueOperand({ type: "bytes32", value: "0xab" })).toBe("0xab");
  });
});
