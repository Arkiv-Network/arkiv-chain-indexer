// Unit tests for the e2e harness's bytes handling (not part of `bun test src`):
//   bun test scripts/udcE2eModel.test.ts
import { describe, expect, test } from "bun:test";
import { keccak256 } from "viem";
import { jsonEqual, splitBytes, withheldVerdict, type RpcEntity } from "./udcE2eModel";

const KEY = `0x${"ab".repeat(32)}` as const;

function entity(attributes: NonNullable<RpcEntity["attributes"]>): RpcEntity {
  return { key: KEY, expiresAt: "0xffffffffffffffff", attributes };
}

describe("splitBytes", () => {
  test("a withheld bytes value matches the node's content, measured and hashed", () => {
    const node = entity([{ name: "body", type: "bytes", value: "0x68656C6C6F" }, { name: "title", type: "str", value: "x" }]);
    const index = entity([{ name: "body", type: "bytes", value: null }, { name: "title", type: "str", value: "x" }]);
    const split = splitBytes(index, node);
    expect(jsonEqual(split.got, split.want)).toBe(true);
    expect(split.expected).toEqual([{ name: "body", size: 5, keccak256: keccak256("0x68656c6c6f") }]);
    expect(split.leaked).toEqual([]);
  });

  test("everything but bytes values still compares exactly", () => {
    const node = entity([{ name: "body", type: "bytes", value: "0x00" }, { name: "title", type: "str", value: "x" }]);
    const index = entity([{ name: "body", type: "bytes", value: null }, { name: "title", type: "str", value: "y" }]);
    const split = splitBytes(index, node);
    expect(jsonEqual(split.got, split.want)).toBe(false);
  });

  test("a bytes value the index returns is a leak, whatever it holds", () => {
    const node = entity([{ name: "body", type: "bytes", value: "0x0102" }]);
    for (const leaked of ["0x0102", "0x", ""]) {
      const split = splitBytes(entity([{ name: "body", type: "bytes", value: leaked }]), node);
      expect(split.leaked).toEqual(["body"]);
    }
  });

  test("an entity without attributes or bytes splits to nothing", () => {
    const split = splitBytes({ key: KEY }, { key: KEY });
    expect(split).toEqual({ got: { key: KEY }, want: { key: KEY }, expected: [], leaked: [] });
  });
});

describe("withheldVerdict", () => {
  test("fails with the names of leaked bytes", () => {
    expect(withheldVerdict({ expected: [{ name: "body", size: 1, keccak256: "0x" }], leaked: ["body"] })).toEqual({ outcome: "fail", leaked: ["body"] });
  });

  test("passes when there were bytes and all were withheld", () => {
    expect(withheldVerdict({ expected: [{ name: "body", size: 1, keccak256: "0x" }], leaked: [] })).toEqual({ outcome: "pass", leaked: [] });
  });

  test("has nothing to judge without bytes", () => {
    expect(withheldVerdict({ expected: [], leaked: [] })).toEqual({ outcome: "none", leaked: [] });
  });
});
