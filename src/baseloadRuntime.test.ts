import { describe, expect, test } from "bun:test";
import { readBaseloadCreatedEntityKeyFromSdkResult } from "./baseloadRuntime";

const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;
const ENTITY_KEY = `0x${"11".repeat(32)}` as `0x${string}`;

describe("baseload runtime SDK entity key handling", () => {
  test("trusts a valid entity key returned by the SDK", () => {
    expect(readBaseloadCreatedEntityKeyFromSdkResult(ENTITY_KEY, TX_HASH)).toBe(ENTITY_KEY);
  });

  test("rejects a missing SDK entity key", () => {
    expect(() => readBaseloadCreatedEntityKeyFromSdkResult(undefined, TX_HASH)).toThrow(
      /SDK returned invalid entity key/,
    );
  });

  test("rejects a malformed SDK entity key", () => {
    expect(() => readBaseloadCreatedEntityKeyFromSdkResult("0x1234", TX_HASH)).toThrow(
      /SDK returned invalid entity key/,
    );
  });
});
