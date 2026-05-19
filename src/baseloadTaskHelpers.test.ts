import { describe, expect, test } from "bun:test";
import {
  BASELOAD_PAYLOAD_FILL_BYTE,
  BASELOAD_PROJECT_ATTRIBUTE,
  createBaseloadAttributes,
  createBaseloadEntityInput,
  getBaseloadLimitState,
  getMillisecondsUntilNextMinute,
  getMinuteAttemptLimit,
  parseGweiToWei,
} from "./baseloadTaskHelpers";
import { type BaseloadWorkerConfig } from "./baseloadConfig";

describe("baseload task helpers", () => {
  test("uses whole minute attempt budgets without fractional carryover", () => {
    expect(getMinuteAttemptLimit(3)).toBe(3);
    expect(getMinuteAttemptLimit(2.75)).toBe(2);
    expect(getMinuteAttemptLimit(0.5)).toBe(0);
    expect(getMillisecondsUntilNextMinute(1_000, 31_000)).toBe(30_000);
    expect(getMillisecondsUntilNextMinute(1_000, 61_000)).toBe(0);
  });

  test("evaluates start block, end block, and duration limits", () => {
    const worker = createWorker({ startBlock: 10, endBlock: 20, durationSeconds: 30 });

    expect(getBaseloadLimitState(worker, 9, 1_000, 2_000)).toEqual({
      type: "before-start",
      currentBlock: 9,
    });
    expect(getBaseloadLimitState(worker, 21, 1_000, 2_000)).toEqual({
      type: "after-end",
      currentBlock: 21,
    });
    expect(getBaseloadLimitState(worker, 15, 1_000, 31_000)).toEqual({
      type: "duration-ended",
    });
    expect(getBaseloadLimitState(worker, 15, 1_000, 30_999)).toEqual({
      type: "active",
      currentBlock: 15,
    });
  });

  test("creates exact-sized payloads and requested random attributes", () => {
    const worker = createWorker({
      singleCreatePayloadSize: 5,
      singleCreateStringArgumentCount: 2,
      singleCreateNumberArgumentCount: 1,
      ttlSeconds: 120,
    });

    const input = createBaseloadEntityInput(worker, fixedRandomBytes);

    expect(input.payload).toHaveLength(5);
    expect(Array.from(input.payload)).toEqual([
      BASELOAD_PAYLOAD_FILL_BYTE,
      BASELOAD_PAYLOAD_FILL_BYTE,
      BASELOAD_PAYLOAD_FILL_BYTE,
      BASELOAD_PAYLOAD_FILL_BYTE,
      BASELOAD_PAYLOAD_FILL_BYTE,
    ]);
    expect(input.contentType).toBe("application/octet-stream");
    expect(input.expiresIn).toBe(120);
    expect(input.attributes).toHaveLength(4);
    expect(input.attributes[0]).toEqual(BASELOAD_PROJECT_ATTRIBUTE);
    expect(input.attributes.filter((attribute) => attribute.key.startsWith("random_string_"))).toHaveLength(2);
    expect(input.attributes.filter((attribute) => attribute.key.startsWith("random_number_"))).toHaveLength(1);
  });

  test("keeps project attribute separate from requested random attribute counts", () => {
    const attributes = createBaseloadAttributes(
      createWorker({
        singleCreateStringArgumentCount: 0,
        singleCreateNumberArgumentCount: 0,
      }),
      fixedRandomBytes,
    );

    expect(attributes).toEqual([BASELOAD_PROJECT_ATTRIBUTE]);
  });

  test("converts gwei decimals to wei", () => {
    expect(parseGweiToWei(1)).toBe(1_000_000_000n);
    expect(parseGweiToWei(0.1)).toBe(100_000_000n);
    expect(parseGweiToWei(5.123456789)).toBe(5_123_456_789n);
  });
});

function createWorker(patch: Partial<BaseloadWorkerConfig>): BaseloadWorkerConfig {
  return {
    id: "wallet-1",
    maxGasPriceGwei: 1000,
    createsPerMinute: 1,
    singleCreatePayloadSize: 10,
    singleCreateStringArgumentCount: 2,
    singleCreateNumberArgumentCount: 2,
    walletNumber: 1,
    walletAddress: "0x0000000000000000000000000000000000000001",
    startBlock: 0,
    endBlock: null,
    durationSeconds: null,
    ttlSeconds: 3600,
    ...patch,
  };
}

function fixedRandomBytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index % 256);
}
