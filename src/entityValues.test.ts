import { describe, expect, test } from "bun:test";
import { fromWireAttributeValue, toStoredAttributeValue, wireAttributeValue, type AttributeTypeTag } from "./entityValues";

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
    expect(fromWireAttributeValue("addr", "0x1234")).toBeNull();
    expect(fromWireAttributeValue("key", `0x${"cd".repeat(31)}`)).toBeNull();
    expect(fromWireAttributeValue("bytes", "0x00")).toBeNull();
  });
});
