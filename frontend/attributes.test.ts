import { describe, expect, test } from "bun:test";
import type { ArkivOperationAttribute } from "./src/api";
import {
  applyAttributeMutations,
  attributeCondition,
  attributeState,
  attributeText,
  conditionUnavailableReason,
  fromEntityAttribute,
  fromOperationAttribute,
  fromRpcAttributes,
  isQueryableName,
  schemaCondition,
  schemaNameOf,
  summarizeChanges,
  withoutSchemaTag,
  type AttributeView,
} from "./src/attributes";

const ADDR = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const KEY = `0x${"ab".repeat(32)}`;

function view(overrides: Partial<AttributeView> & Pick<AttributeView, "name" | "type">): AttributeView {
  return { indexed: true, value: null, ...overrides };
}

describe("attribute values", () => {
  test("integers render as exact decimal, u256 beyond 2^53 included", () => {
    expect(attributeText(view({ name: "a", type: "u64", value: "0xffffffffffffffff" }))).toBe("18446744073709551615");
    expect(attributeText(view({ name: "a", type: "u256", value: `0x${"f".repeat(64)}` }))).toBe(((1n << 256n) - 1n).toString());
    expect(attributeText(view({ name: "a", type: "i32", value: -2147483648 }))).toBe("-2147483648");
    expect(attributeText(view({ name: "a", type: "u64", value: "0x0" }))).toBe("0");
  });

  test("dec stays the node's decimal text; bool, str, key and bytes32 render plainly", () => {
    expect(attributeText(view({ name: "a", type: "dec", value: "-12.5" }))).toBe("-12.5");
    expect(attributeText(view({ name: "a", type: "bool", value: false }))).toBe("false");
    expect(attributeText(view({ name: "a", type: "str", value: "zażółć 🚀" }))).toBe("zażółć 🚀");
    expect(attributeText(view({ name: "a", type: "key", value: KEY.toUpperCase().replace("0X", "0x") }))).toBe(KEY);
    expect(attributeText(view({ name: "a", type: "bytes32", value: KEY }))).toBe(KEY);
  });

  test("addresses render EIP-55", () => {
    expect(attributeText(view({ name: "a", type: "addr", value: ADDR }))).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });

  test("bytes render as a size", () => {
    expect(attributeText(view({ name: "a", type: "bytes", indexed: false, size: 32768 }))).toBe("32,768 bytes");
  });
});

describe("sources", () => {
  test("a decoded triple keeps its flag, and bytes keep size and hash only", () => {
    const triple: ArkivOperationAttribute = { name: "body", typeId: 7, type: "bytes", indexed: false, value: null, size: 3, keccak256: "0xaa" };
    expect(fromOperationAttribute(triple)).toEqual({ name: "body", type: "bytes", indexed: false, value: null, size: 3, keccak256: "0xaa" });
    const str: ArkivOperationAttribute = { name: "s", typeId: 0x88, type: "str", indexed: true, value: "x", size: 1 };
    expect(fromOperationAttribute(str)).toEqual({ name: "s", type: "str", indexed: true, value: "x" });
  });

  test("an index state attribute maps across", () => {
    expect(fromEntityAttribute({ name: "n", type: "u64", indexed: true, value: "0x2a" })).toEqual({ name: "n", type: "u64", indexed: true, value: "0x2a" });
    expect(fromEntityAttribute({ name: "b", type: "bytes", indexed: false, value: null, size: 5, keccak256: "0xcc" })).toEqual(
      { name: "b", type: "bytes", indexed: false, value: null, size: 5, keccak256: "0xcc" },
    );
  });

  test("an RPC answer takes its flags from attributeSchema; bad bytes hex is flagged", () => {
    const out = fromRpcAttributes(
      [{ name: "a", type: "str", value: "x" }, { name: "b", type: "bytes", value: "0x12z" }, { nope: true }],
      [{ name: "a", type: "str", indexed: false }],
    );
    expect(out).toEqual([
      { name: "a", type: "str", indexed: false, value: "x" },
      { name: "b", type: "bytes", indexed: null, value: null, error: "bytes value is not hex" },
    ]);
  });
});

describe("query conditions", () => {
  test("only indexed, non-bytes attributes with spellable names get a condition", () => {
    expect(attributeCondition(view({ name: "status", type: "str", value: "it's" }))).toBe("status = str('it''s')");
    expect(attributeCondition(view({ name: "n", type: "u64", value: "0x10" }))).toBe("n = u64(16)");
    expect(attributeCondition(view({ name: "ok", type: "bool", value: true }))).toBe("ok = true");
    expect(attributeCondition(view({ name: "who", type: "addr", value: ADDR }))).toBe(`who = addr(${ADDR})`);
    expect(attributeCondition(view({ name: "arkiv.schema", type: "str", value: "posts" }))).toBe("arkiv.schema = str('posts')");
    // Unknown flag (an endpoint without attributeSchema): offered.
    expect(attributeCondition(view({ name: "s", type: "str", indexed: null, value: "x" }))).toBe("s = str('x')");

    const stored = view({ name: "s", type: "str", indexed: false, value: "x" });
    expect(attributeCondition(stored)).toBeNull();
    expect(conditionUnavailableReason(stored)).toBe("stored, not queryable");
    const bytes = view({ name: "b", type: "bytes", indexed: false, size: 3 });
    expect(attributeCondition(bytes)).toBeNull();
    expect(conditionUnavailableReason(bytes)).toMatch(/never indexed/);
    expect(attributeCondition(view({ name: "x", type: "tombstone" }))).toBeNull();
    expect(attributeCondition(view({ name: "x:y", type: "str", value: "v" }))).toBeNull();
  });

  test("names follow the node's lexer: a letter first, no type names or keywords", () => {
    expect(isQueryableName("a")).toBe(true);
    expect(isQueryableName("Case.Sensitive_name-1")).toBe(true);
    for (const name of ["", "1a", "_a", "a b", "é", "str", "KEY", "and", "exists", "true"]) expect(isQueryableName(name)).toBe(false);
  });
});

describe("schemas", () => {
  test("only an indexed str arkiv.schema is the schema, and it leaves the rows", () => {
    const tag = view({ name: "arkiv.schema", type: "str", value: "posts" });
    const other = view({ name: "title", type: "str", value: "hello" });
    expect(schemaNameOf([other, tag])).toBe("posts");
    expect(withoutSchemaTag([other, tag])).toEqual([other]);
    const unindexed = view({ name: "arkiv.schema", type: "str", indexed: false, value: "posts" });
    expect(schemaNameOf([unindexed])).toBeNull();
    expect(withoutSchemaTag([unindexed])).toEqual([unindexed]);
    expect(schemaCondition("o'reilly")).toBe("arkiv.schema = str('o''reilly')");
  });
});

describe("patches", () => {
  const before = attributeState([
    view({ name: "count", type: "u64", value: "0x5" }),
    view({ name: "note", type: "str", indexed: false, value: "hi" }),
    view({ name: "gone", type: "str", value: "bye" }),
    view({ name: "same", type: "bool", indexed: false, value: true }),
  ]);

  test("set, changed (retyped, re-indexed), unchanged and unset", () => {
    const { changes, next } = applyAttributeMutations(before, [
      view({ name: "count", type: "dec", value: "5.5" }),
      view({ name: "note", type: "str", indexed: true, value: "hi" }),
      view({ name: "gone", type: "tombstone" }),
      view({ name: "fresh", type: "i32", value: -1 }),
      view({ name: "same", type: "bool", indexed: false, value: true }),
      view({ name: "never", type: "tombstone" }),
    ]);
    expect(changes.map((change) => [change.name, change.kind, change.retyped, change.indexChange])).toEqual([
      ["count", "changed", true, null],
      ["note", "changed", false, "indexed"],
      ["gone", "unset", false, null],
      ["fresh", "set", false, null],
      ["same", "unchanged", false, null],
      ["never", "unset-missing", false, null],
    ]);
    expect(changes[2]!.before?.value).toBe("bye");
    expect([...next!.keys()].sort()).toEqual(["count", "fresh", "note", "same"]);
    expect(summarizeChanges(changes)).toBe("1 set, 2 changed (1 retyped, 1 re-indexed), 2 unset, 1 unchanged");
  });

  test("mutations of one name apply in order", () => {
    const { changes, next } = applyAttributeMutations(new Map(), [
      view({ name: "a", type: "str", value: "1" }),
      view({ name: "a", type: "str", value: "2" }),
      view({ name: "a", type: "tombstone" }),
    ]);
    expect(changes.map((change) => change.kind)).toEqual(["set", "changed", "unset"]);
    expect(next!.size).toBe(0);
  });

  test("without the prior state every write is a set marked as such", () => {
    const { changes, next } = applyAttributeMutations(null, [view({ name: "a", type: "str", value: "1" }), view({ name: "b", type: "tombstone" })]);
    expect(next).toBeNull();
    expect(changes.map((change) => [change.kind, change.priorUnknown])).toEqual([["set", true], ["unset", true]]);
  });

  test("bytes compare by size and hash", () => {
    const state = attributeState([view({ name: "b", type: "bytes", indexed: false, size: 3, keccak256: "0xaa" })]);
    const same = applyAttributeMutations(state, [view({ name: "b", type: "bytes", indexed: false, size: 3, keccak256: "0xaa" })]);
    expect(same.changes[0]!.kind).toBe("unchanged");
    const other = applyAttributeMutations(state, [view({ name: "b", type: "bytes", indexed: false, size: 3, keccak256: "0xbb" })]);
    expect(other.changes[0]!.kind).toBe("changed");
  });
});

describe("visible text", () => {
  test("bidi, C1 and invisible format characters are shown escaped", async () => {
    const { visibleText } = await import("./src/attributes");
    expect(visibleText("abc‮txt.exe")).toBe("abc\\u{202E}txt.exe");
    expect(visibleText("a\u0085b​c⁦d⁩﻿")).toBe("a\\u{0085}b\\u{200B}c\\u{2066}d\\u{2069}\\u{FEFF}");
    // Ordinary text, accents, CJK and joined emoji are untouched.
    expect(visibleText("zażółć 日本語 👨‍👩‍👧")).toBe("zażółć 日本語 👨‍👩‍👧");
  });

  test("a str value shows every control character, DEL and spoofing character as an escape", async () => {
    const { strValueParts, escapedStrValue } = await import("./src/attributes");
    // Rabdi mined these: the node takes any UTF-8 as a str.
    expect(escapedStrValue("line one\n\tline two")).toBe("line one\\n\\tline two");
    expect(escapedStrValue("nul\u0000inside")).toBe("nul\\0inside");
    expect(escapedStrValue("\r\n\u001b[0m")).toBe("\\r\\n\\u{001B}[0m");
    expect(escapedStrValue("del\u007f")).toBe("del\\u{007F}");
    expect(escapedStrValue("abc\u202etxt")).toBe("abc\\u{202E}txt");
    // So "nul\0inside" and "nulinside" never look alike.
    expect(escapedStrValue("nulinside")).toBe("nulinside");
    expect(strValueParts("a\u0000b")).toEqual([
      { kind: "text", text: "a" },
      { kind: "escape", text: "\\0", char: "\u0000", title: "U+0000 NUL" },
      { kind: "text", text: "b" },
    ]);
    expect(strValueParts("\u001b")).toEqual([{ kind: "escape", text: "\\u{001B}", char: "\u001b", title: "U+001B control character" }]);
    expect(strValueParts("")).toEqual([]);
    expect(escapedStrValue("zażółć 日本語 👨‍👩‍👧 'quoted' \\n")).toBe("zażółć 日本語 👨‍👩‍👧 'quoted' \\n");
    // Once anything is escaped, a typed backslash is doubled: a newline and a typed \\n differ.
    expect(escapedStrValue("a\nb")).toBe("a\\nb");
    expect(escapedStrValue("a\\nb\t")).toBe("a\\\\nb\\t");
  });

  test("a str with anything to escape also copies escaped, as a JavaScript string body", async () => {
    const { escapedStrCopy } = await import("./src/attributes");
    expect(escapedStrCopy("plain \\ text")).toBeNull();
    expect(escapedStrCopy("line one\n\tline two")).toBe("line one\\n\\tline two");
    expect(escapedStrCopy("nul\u0000inside")).toBe("nul\\0inside");
    // Literal backslashes are doubled once anything is escaped, so the copy reads back exactly.
    expect(escapedStrCopy("C:\\dir\n")).toBe("C:\\\\dir\\n");
    // \0 before a digit would be an octal escape.
    expect(escapedStrCopy("a\u00001")).toBe("a\\u{0000}1");
    // Quotes are escaped, so the copy pastes between single or double quotes.
    expect(escapedStrCopy(`say "hi" it's\n`)).toBe(`say \\"hi\\" it\\'s\\n`);
    for (const value of ["nul\u0000inside", "line one\n\tline two", "C:\\dir\n", "a\u00001", "\r\n\u001b[0m\u007f", "abc\u202etxt", `say "hi" it's\n`]) {
      expect(new Function(`return "${escapedStrCopy(value)}"`)()).toBe(value);
      expect(new Function(`return '${escapedStrCopy(value)}'`)()).toBe(value);
    }
  });

  test("visibleText still leaves a text blob's line breaks and tabs alone", async () => {
    const { visibleText } = await import("./src/attributes");
    expect(visibleText("line one\n\tline two")).toBe("line one\n\tline two");
  });
});
