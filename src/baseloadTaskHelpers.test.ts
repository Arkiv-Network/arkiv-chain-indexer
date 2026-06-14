import { describe, expect, test } from "bun:test";
import {
  BASELOAD_PROJECT_ATTRIBUTE,
  chooseBaseloadOperation,
  createBaseloadAttributes,
  createBaseloadEntityInput,
  createBaseloadUpdateInput,
  getBaseloadLimitState,
  getEntitiesPerRequestLimit,
  getMillisecondsUntilNextMinute,
  getMinuteAttemptLimit,
  getTimeBombDetonationMs,
  getTimeBombRemainingSeconds,
  parseGweiToWei,
  pickSoonestExpiringPoolEntry,
  pickSoonestExpiringPoolEntries,
  pruneExpiredPoolEntries,
  randomOwnerAddress,
  type BaseloadPoolEntry,
} from "./baseloadTaskHelpers";
import { type BaseloadWorkerConfig } from "./baseloadConfig";

describe("baseload task helpers", () => {
  test("uses whole minute attempt budgets without fractional carryover", () => {
    expect(getMinuteAttemptLimit(3)).toBe(3);
    expect(getMinuteAttemptLimit(2.75)).toBe(2);
    expect(getMinuteAttemptLimit(0.5)).toBe(0);
    expect(getEntitiesPerRequestLimit(3)).toBe(3);
    expect(getEntitiesPerRequestLimit(2.75)).toBe(2);
    expect(getEntitiesPerRequestLimit(0)).toBe(1);
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

    expect(Array.from(input.payload)).toEqual([0, 1, 2, 3, 4]);
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

  test("sorts mixed attributes by key for the registry contract", () => {
    const attributes = createBaseloadAttributes(
      createWorker({
        singleCreateStringArgumentCount: 2,
        singleCreateNumberArgumentCount: 2,
      }),
      fixedRandomBytes,
    );

    const keys = attributes.map((attribute) => attribute.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe(BASELOAD_PROJECT_ATTRIBUTE.key);
  });

  test("converts gwei decimals to wei", () => {
    expect(parseGweiToWei(1)).toBe(1_000_000_000n);
    expect(parseGweiToWei(0.1)).toBe(100_000_000n);
    expect(parseGweiToWei(5.123456789)).toBe(5_123_456_789n);
  });

  test("chooses operations for the simple behaviors", () => {
    expect(chooseBaseloadOperation(createWorker({ behavior: "create" }), 0, 0)).toBe("create");
    expect(chooseBaseloadOperation(createWorker({ behavior: "create-ownership" }), 0, 3)).toBe(
      "create-and-own",
    );
    expect(chooseBaseloadOperation(createWorker({ behavior: "time-bomb" }), 0, 7)).toBe(
      "time-bomb-create",
    );
  });

  test("create-update fills the pool first and then only updates", () => {
    const worker = createWorker({ behavior: "create-update", entityPoolSize: 3 });

    expect(chooseBaseloadOperation(worker, 0, 0)).toBe("create");
    expect(chooseBaseloadOperation(worker, 2, 5)).toBe("create");
    expect(chooseBaseloadOperation(worker, 3, 6)).toBe("update");
    expect(chooseBaseloadOperation(worker, 5, 7)).toBe("update");
  });

  test("create-update-delete mixes operations around the pool target", () => {
    const worker = createWorker({ behavior: "create-update-delete", entityPoolSize: 2 });

    expect(chooseBaseloadOperation(worker, 0, 0)).toBe("create");
    expect(chooseBaseloadOperation(worker, 1, 2)).toBe("create");
    expect(chooseBaseloadOperation(worker, 1, 3)).toBe("update");
    expect(chooseBaseloadOperation(worker, 2, 4)).toBe("update");
    expect(chooseBaseloadOperation(worker, 2, 5)).toBe("delete");
  });

  test("prunes pool entries that are about to expire and refreshes the soonest", () => {
    const pool: BaseloadPoolEntry[] = [
      { entityKey: "0x01", expiresAtMs: 10_000 },
      { entityKey: "0x02", expiresAtMs: 50_000 },
      { entityKey: "0x03", expiresAtMs: 30_000 },
    ];

    expect(pruneExpiredPoolEntries(pool, 9_000, 2_000).map((entry) => entry.entityKey)).toEqual([
      "0x02",
      "0x03",
    ]);
    expect(pruneExpiredPoolEntries(pool, 1_000, 2_000)).toHaveLength(3);
    expect(pickSoonestExpiringPoolEntry(pool)?.entityKey).toBe("0x01");
    expect(pickSoonestExpiringPoolEntries(pool, 2).map((entry) => entry.entityKey)).toEqual([
      "0x01",
      "0x03",
    ]);
    expect(pickSoonestExpiringPoolEntries(pool, 0)).toEqual([]);
    expect(pickSoonestExpiringPoolEntry([])).toBeNull();
  });

  test("computes time bomb detonation and remaining TTL", () => {
    const worker = createWorker({ behavior: "time-bomb", timeBombOffsetSeconds: 300 });
    const detonationAtMs = getTimeBombDetonationMs(worker, 1_000_000);

    expect(detonationAtMs).toBe(1_300_000);
    expect(getTimeBombRemainingSeconds(detonationAtMs, 1_000_000)).toBe(300);
    expect(getTimeBombRemainingSeconds(detonationAtMs, 1_299_500)).toBe(1);
    expect(getTimeBombRemainingSeconds(detonationAtMs, 1_300_000)).toBe(0);
  });

  test("builds update inputs targeting an existing entity", () => {
    const worker = createWorker({ singleCreatePayloadSize: 3, ttlSeconds: 60 });

    const input = createBaseloadUpdateInput(worker, "0xabc", fixedRandomBytes);

    expect(input.entityKey).toBe("0xabc");
    expect(Array.from(input.payload)).toEqual([0, 1, 2]);
    expect(input.expiresIn).toBe(60);
    expect(input.attributes[0]).toEqual(BASELOAD_PROJECT_ATTRIBUTE);
  });

  test("derives random owner addresses from 20 bytes", () => {
    expect(randomOwnerAddress(fixedRandomBytes)).toBe("0x000102030405060708090a0b0c0d0e0f10111213");
  });
});

function createWorker(patch: Partial<BaseloadWorkerConfig>): BaseloadWorkerConfig {
  return {
    id: "wallet-1",
    behavior: "create",
    maxGasPriceGwei: 1000,
    opsPerMinute: 1,
    entitiesPerRequest: 1,
    singleCreatePayloadSize: 10,
    singleCreateStringArgumentCount: 2,
    singleCreateNumberArgumentCount: 2,
    entityPoolSize: 10,
    timeBombOffsetSeconds: 600,
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
