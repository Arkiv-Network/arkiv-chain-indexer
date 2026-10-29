import { describe, expect, test } from "bun:test";
import {
  byteaLiteral,
  bytesToText,
  fromUtf8Hex,
  fromWireAttributeValue,
  storedBytesValue,
  toStoredAttributeValue,
  utf8Hex,
  wireAttributeValue,
  type AttributeTypeTag,
} from "./entityValues";

describe("fromWireAttributeValue", () => {
  test("round-trips every wire encoding back to the stored form", () => {
    const cases: Array<[AttributeTypeTag, string]> = [
      ["bool", "true"],
      ["bool", "false"],
      ["i32", "-2147483648"],
      ["i32", "0"],
      ["i32", "2147483647"],
      ["u64", "0"],
      ["u64", "9007199254740993"],
      ["u64", "18446744073709551615"],
      ["u256", "115792089237316195423570985008687907853269984665640564039457584007913129639935"],
      ["dec", "1.5"],
      ["dec", "-0.000000000000000001"],
      ["dec", "42"],
      ["str", "hello 'world'"],
      // The node takes any UTF-8 as a str, control characters and NUL included.
      ["str", "line one\n\tline two"],
      ["str", "nul\u0000inside"],
      ["str", "\r\n\u001b[0m\u007f"],
      ["str", ""],
      ["addr", `0x${"ab".repeat(20)}`],
      ["key", `0x${"cd".repeat(32)}`],
      ["bytes32", `0x${"ef".repeat(32)}`],
    ];
    for (const [tag, text] of cases) {
      const stored = toStoredAttributeValue(tag, text);
      expect(stored).not.toBeNull();
      expect(fromWireAttributeValue(tag, wireAttributeValue(tag, stored!))).toEqual(stored);
    }
  });

  test("normalises what the wire allows", () => {
    expect(fromWireAttributeValue("u64", "0x0A")).toEqual({ valueText: "10", valueNum: 10n });
    expect(fromWireAttributeValue("addr", "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb")).toEqual({
      valueText: `0x${"bb".repeat(20)}`,
      valueNum: null,
    });
    expect(fromWireAttributeValue("dec", "1.500")).toEqual({ valueText: "1.5", valueNum: 1_500_000_000_000_000_000n });
  });

  test("refuses a JSON value of the wrong shape or range", () => {
    expect(fromWireAttributeValue("bool", "true")).toBeNull();
    expect(fromWireAttributeValue("i32", "7")).toBeNull();
    expect(fromWireAttributeValue("i32", 1.5)).toBeNull();
    expect(fromWireAttributeValue("i32", 2147483648)).toBeNull();
    expect(fromWireAttributeValue("u64", 7)).toBeNull();
    expect(fromWireAttributeValue("u64", "7")).toBeNull();
    expect(fromWireAttributeValue("u64", "0x10000000000000000")).toBeNull();
    expect(fromWireAttributeValue("str", 7)).toBeNull();
    // A lone surrogate has no UTF-8 form, so no node sends one.
    expect(fromWireAttributeValue("str", "a\ud800b")).toBeNull();
    expect(fromWireAttributeValue("addr", "0x1234")).toBeNull();
    expect(fromWireAttributeValue("key", `0x${"cd".repeat(31)}`)).toBeNull();
    expect(fromWireAttributeValue("bytes", "0x0")).toBeNull();
    expect(fromWireAttributeValue("bytes", 5)).toBeNull();
  });

  test("a node's bytes value is kept as its keccak256 and length, never its content", () => {
    expect(fromWireAttributeValue("bytes", "0x010203")).toEqual({
      valueText: "0xf1885eda54b7a053318cd41e2093220dab15d65381b1157a3633a83bfd5c9239",
      valueNum: 3n,
    });
    expect(fromWireAttributeValue("bytes", "0x")).toEqual({
      valueText: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
      valueNum: 0n,
    });
    expect(storedBytesValue(`0x${"AB".repeat(32)}`, 7)).toEqual({ valueText: `0x${"ab".repeat(32)}`, valueNum: 7n });
    expect(storedBytesValue("0x12", 7)).toBeNull();
    // The index answers bytes as null on the wire.
    expect(wireAttributeValue("bytes", { valueText: `0x${"ab".repeat(32)}`, valueNum: 7n })).toBeNull();
  });
});

describe("text crossing into Postgres as bytes", () => {
  const texts = ["", "plain", "nul\u0000inside", "line one\n\tline two", "zażółć 🦀"];

  test("utf8Hex round-trips any str, NUL included", () => {
    for (const text of texts) expect(fromUtf8Hex(utf8Hex(text))).toBe(text);
    expect(utf8Hex("a\0b")).toBe("0x610062");
  });

  test("byteaLiteral is Postgres bytea input, and bytesToText reads a bytea back", () => {
    expect(byteaLiteral("a\0b")).toBe("\\x610062");
    for (const text of texts) expect(bytesToText(Buffer.from(byteaLiteral(text).slice(2), "hex"))).toBe(text);
  });
});
