import { describe, expect, test } from "bun:test";
import {
  isBaseloadTransactionReceiptSuccessful,
  readBaseloadCreatedEntityKeyFromSdkResult,
  readBaseloadEntityKeysFromSdkResult,
} from "./baseloadRuntime";

const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;
const ENTITY_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const SECOND_ENTITY_KEY = `0x${"22".repeat(32)}` as `0x${string}`;

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

  test("trusts valid entity key arrays returned by batch mutations", () => {
    expect(
      readBaseloadEntityKeysFromSdkResult(
        [ENTITY_KEY, SECOND_ENTITY_KEY],
        TX_HASH,
        2,
        "createdEntities",
      ),
    ).toEqual([ENTITY_KEY, SECOND_ENTITY_KEY]);
  });

  test("rejects malformed batch mutation entity key arrays", () => {
    expect(() =>
      readBaseloadEntityKeysFromSdkResult([ENTITY_KEY], TX_HASH, 2, "createdEntities"),
    ).toThrow(/expected 2 keys/);
    expect(() =>
      readBaseloadEntityKeysFromSdkResult([ENTITY_KEY, "0x1234"], TX_HASH, 2, "createdEntities"),
    ).toThrow(/createdEntities\[1\]/);
  });
});

describe("baseload runtime receipt handling", () => {
  test("accepts successful transaction receipt status forms", () => {
    expect(isBaseloadTransactionReceiptSuccessful({ status: "0x1" })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: "1" })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 1 })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 1n })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: true })).toBe(true);
  });

  test("rejects reverted transaction receipt status forms", () => {
    expect(isBaseloadTransactionReceiptSuccessful({ status: "0x0" })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: "0" })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 0 })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 0n })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: false })).toBe(false);
  });

  test("keeps compatibility with receipt fixtures that omit status", () => {
    expect(isBaseloadTransactionReceiptSuccessful({ transactionHash: TX_HASH })).toBe(true);
  });
});
