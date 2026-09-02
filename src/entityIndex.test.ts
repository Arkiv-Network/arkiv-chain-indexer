import { describe, expect, test } from "bun:test";
import {
  ENTITY_EVENT_TOPICS,
  OPERATION_CREATE,
  OPERATION_DELETE,
  OPERATION_EXTEND,
  OPERATION_TRANSFER,
  OPERATION_UPDATE,
  attachEventsToOps,
  foldEntityVersions,
  resolveRequestedExpiry,
  type EntityEventLog,
  type EntityOpRecord,
} from "./entityIndex";
import type { ArkivOperationAttribute } from "./arkivOperations";

const KEY = "0x" + "ab".repeat(32);
const ALICE = "0x" + "aa".repeat(20);
const BOB = "0x" + "bb".repeat(20);

const str = (key: string, value: string): ArkivOperationAttribute => ({ key, valueType: 8, valueTypeName: "str", value });
const u64 = (key: string, value: string): ArkivOperationAttribute => ({ key, valueType: 3, valueTypeName: "u64", value });
const i32 = (key: string, value: string): ArkivOperationAttribute => ({ key, valueType: 2, valueTypeName: "i32", value });
const dec = (key: string, value: string): ArkivOperationAttribute => ({ key, valueType: 5, valueTypeName: "dec", value });
const tombstone = (key: string): ArkivOperationAttribute => ({ key, valueType: 0, valueTypeName: "tombstone", value: "" });

function op(overrides: Partial<EntityOpRecord> & { blockNumber: number; operationType: number }): EntityOpRecord {
  return {
    position: 0,
    opIndex: 0,
    entityKey: KEY,
    sender: ALICE,
    contentType: null,
    payloadSizeBytes: 0,
    attributes: [],
    expiresAtBlocks: 0,
    newOwner: null,
    ...overrides,
  };
}

const create = (blockNumber: number, extra: Partial<EntityOpRecord> = {}) =>
  op({
    blockNumber,
    operationType: OPERATION_CREATE,
    contentType: "text/plain",
    payloadSizeBytes: 12,
    attributes: [str("project", "demo"), u64("rank", "7")],
    expiresAtBlocks: 900,
    ...extra,
  });

describe("resolveRequestedExpiry", () => {
  test("reads a count within reach of the block as a lifetime, beyond it as a deadline", () => {
    expect(resolveRequestedExpiry(1000, 900)).toBe(1900n);
    expect(resolveRequestedExpiry(1000, 1000)).toBe(2000n);
    expect(resolveRequestedExpiry(1000, 1001)).toBe(1001n);
    expect(resolveRequestedExpiry(1000, 0)).toBe(1000n);
    expect(resolveRequestedExpiry(1000, -5)).toBe(1000n);
  });
});

describe("foldEntityVersions", () => {
  test("a create is version 0 with the sender as owner and creator", () => {
    const [v0] = foldEntityVersions(KEY, [create(1000)]);
    expect(v0).toEqual({
      entityKey: KEY,
      version: 0,
      fromBlock: 1000,
      fromPosition: 0,
      fromOpIndex: 0,
      toBlock: null,
      deleted: false,
      owner: ALICE,
      creator: ALICE,
      createdAt: 1000,
      createdPosition: 0,
      createdOpIndex: 0,
      updatedAt: 1000,
      expiresAt: 1900n,
      creationFlags: null,
      contentType: "text/plain",
      payloadSize: 12,
      attributes: [
        { name: "project", typeId: 8, valueText: "demo", valueNum: null },
        { name: "rank", typeId: 3, valueText: "7", valueNum: 7n },
      ],
    });
  });

  test("the receipt event wins over the calldata for expiry and flags", () => {
    const [v0] = foldEntityVersions(KEY, [create(1000, { event: { expiresAt: 5000n, creationFlags: 3 } })]);
    expect(v0!.expiresAt).toBe(5000n);
    expect(v0!.creationFlags).toBe(3);
  });

  test("attributes are kept in byte order of their names whatever the calldata order", () => {
    const [v0] = foldEntityVersions(KEY, [
      create(1000, { attributes: [str("zeta", "z"), str("Alpha", "A"), str("alpha", "a"), str("ä", "umlaut")] }),
    ]);
    expect(v0!.attributes.map((attribute) => attribute.name)).toEqual(["Alpha", "alpha", "zeta", "ä"]);
  });

  test("a patch sets, retypes and unsets attributes and bumps updatedAt", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({
        blockNumber: 1010,
        position: 3,
        operationType: OPERATION_UPDATE,
        attributes: [tombstone("project"), i32("rank", "-2"), dec("score", "1.50"), str("new", "x")],
      }),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.toBlock).toBe(1010);
    const v1 = versions[1]!;
    expect(v1.version).toBe(1);
    expect(v1.fromBlock).toBe(1010);
    expect(v1.fromPosition).toBe(3);
    expect(v1.updatedAt).toBe(1010);
    expect(v1.createdAt).toBe(1000);
    expect(v1.expiresAt).toBe(1900n);
    expect(v1.contentType).toBe("text/plain");
    expect(v1.payloadSize).toBe(12);
    expect(v1.attributes).toEqual([
      { name: "new", typeId: 8, valueText: "x", valueNum: null },
      { name: "rank", typeId: 2, valueText: "-2", valueNum: -2n },
      { name: "score", typeId: 5, valueText: "1.5", valueNum: 1_500_000_000_000_000_000n },
    ]);
  });

  test("a patch carrying payload or content type cells replaces those fields", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1001, operationType: OPERATION_UPDATE, contentType: "application/json", payloadSizeBytes: 40 }),
      op({ blockNumber: 1002, operationType: OPERATION_UPDATE, attributes: [str("k", "v")] }),
    ]);
    expect(versions[1]).toMatchObject({ contentType: "application/json", payloadSize: 40 });
    // A patch that carried neither cell leaves both alone.
    expect(versions[2]).toMatchObject({ contentType: "application/json", payloadSize: 40 });
  });

  test("extend replaces the expiry (event first, calldata otherwise); transfer replaces the owner", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1500, operationType: OPERATION_EXTEND, expiresAtBlocks: 901 }),
      op({ blockNumber: 1600, operationType: OPERATION_EXTEND, expiresAtBlocks: 5, event: { expiresAt: 9999n } }),
      op({ blockNumber: 1700, operationType: OPERATION_TRANSFER, newOwner: BOB.toUpperCase().replace("0X", "0x") }),
    ]);
    expect(versions.map((version) => version.expiresAt)).toEqual([1900n, 2401n, 9999n, 9999n]);
    expect(versions[3]).toMatchObject({ owner: BOB, creator: ALICE, updatedAt: 1700 });
    expect(versions.map((version) => version.toBlock)).toEqual([1500, 1600, 1700, null]);
  });

  test("a delete ends the entity and later operations are ignored", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1001, operationType: OPERATION_DELETE }),
      op({ blockNumber: 1002, operationType: OPERATION_UPDATE, attributes: [str("k", "v")] }),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ deleted: true, fromBlock: 1001, toBlock: null, owner: ALICE });
  });

  test("operations before the create and unknown types are ignored; order is by chain position", () => {
    const versions = foldEntityVersions(KEY, [
      op({ blockNumber: 1000, position: 2, operationType: OPERATION_UPDATE, attributes: [str("late", "y")] }),
      op({ blockNumber: 999, operationType: OPERATION_UPDATE, attributes: [str("early", "x")] }),
      op({ blockNumber: 1000, position: 1, opIndex: 1, operationType: 9 }),
      create(1000, { position: 1 }),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ fromBlock: 1000, fromPosition: 1, toBlock: 1000 });
    expect(versions[1]!.attributes.map((attribute) => attribute.name)).toEqual(["late", "project", "rank"]);
  });

  test("cells of a type the index cannot hold are skipped, not stored", () => {
    const [v0] = foldEntityVersions(KEY, [
      create(1000, {
        attributes: [
          { key: "legacy", valueType: 1, valueTypeName: "uint", value: "5" },
          { key: "blob", valueType: 7, valueTypeName: "bytes", value: "<9 bytes>" },
          { key: "broken", valueType: 3, valueTypeName: "u64", value: "not a number" },
          { key: "ok", valueType: 9, valueTypeName: "addr", value: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" },
        ],
      }),
    ]);
    expect(v0!.attributes).toEqual([{ name: "ok", typeId: 9, valueText: ALICE, valueNum: null }]);
  });

  test("no create means no versions", () => {
    expect(foldEntityVersions(KEY, [op({ blockNumber: 1, operationType: OPERATION_UPDATE })])).toEqual([]);
    expect(foldEntityVersions(KEY, [])).toEqual([]);
  });
});

describe("attachEventsToOps", () => {
  const REGISTRY = "0x4400000000000000000000000000000000000044";
  const log = (overrides: Partial<EntityEventLog> & { logIndex: number; topic0: string }): EntityEventLog => ({
    address: REGISTRY,
    topic1: KEY,
    topic2: null,
    topic3: null,
    data: "0x",
    ...overrides,
  });
  const word = (value: bigint) => value.toString(16).padStart(64, "0");

  test("pairs the n-th operation of a kind with the n-th event of that kind", () => {
    const other = "0x" + "cd".repeat(32);
    const ops = [
      op({ blockNumber: 5, opIndex: 0, operationType: OPERATION_CREATE }),
      op({ blockNumber: 5, opIndex: 1, operationType: OPERATION_CREATE, entityKey: other }),
      op({ blockNumber: 5, opIndex: 2, operationType: OPERATION_EXTEND, entityKey: other }),
      op({ blockNumber: 5, opIndex: 3, operationType: OPERATION_TRANSFER }),
    ];
    attachEventsToOps(ops, [
      log({ logIndex: 3, topic0: ENTITY_EVENT_TOPICS.ownershipTransferred, topic2: "0x" + "00".repeat(12) + ALICE.slice(2), topic3: "0x" + "00".repeat(12) + BOB.slice(2) }),
      log({ logIndex: 0, topic0: ENTITY_EVENT_TOPICS.created, data: `0x${word(1500n)}${word(1n)}` }),
      log({ logIndex: 1, topic0: ENTITY_EVENT_TOPICS.created, topic1: other, data: `0x${word(1600n)}${word(0n)}` }),
      log({ logIndex: 2, topic0: ENTITY_EVENT_TOPICS.expiryExtended, topic1: other, data: `0x${word(2600n)}` }),
    ]);
    expect(ops[0]!.event).toEqual({ expiresAt: 1500n, creationFlags: 1 });
    expect(ops[1]!.event).toEqual({ expiresAt: 1600n, creationFlags: 0 });
    expect(ops[2]!.event).toEqual({ expiresAt: 2600n });
    expect(ops[3]!.event).toEqual({ newOwner: BOB });
  });

  test("a disagreeing key or a foreign log leaves the operation on its calldata", () => {
    const ops = [op({ blockNumber: 5, operationType: OPERATION_CREATE })];
    attachEventsToOps(ops, [
      log({ logIndex: 0, topic0: ENTITY_EVENT_TOPICS.created, address: "0x" + "11".repeat(20), data: `0x${word(1n)}${word(0n)}` }),
      log({ logIndex: 1, topic0: ENTITY_EVENT_TOPICS.created, topic1: "0x" + "ee".repeat(32), data: `0x${word(2n)}${word(0n)}` }),
    ]);
    expect(ops[0]!.event).toBeUndefined();
  });

  test("a full u64 expiry survives", () => {
    const ops = [op({ blockNumber: 5, operationType: OPERATION_CREATE })];
    const u64Max = (1n << 64n) - 1n;
    attachEventsToOps(ops, [log({ logIndex: 0, topic0: ENTITY_EVENT_TOPICS.created, data: `0x${word(u64Max)}${word(0n)}` })]);
    expect(ops[0]!.event?.expiresAt).toBe(u64Max);
    expect(foldEntityVersions(KEY, ops)[0]!.expiresAt).toBe(u64Max);
  });

  test("an expiry word wider than u64 is kept unclipped rather than wrapped", () => {
    const ops = [op({ blockNumber: 5, operationType: OPERATION_CREATE })];
    attachEventsToOps(ops, [log({ logIndex: 0, topic0: ENTITY_EVENT_TOPICS.created, data: `0x${"f".repeat(64)}${word(0n)}` })]);
    expect(ops[0]!.event?.expiresAt).toBe((1n << 256n) - 1n);
    expect(foldEntityVersions(KEY, ops)[0]!.expiresAt).toBe((1n << 256n) - 1n);
  });
});
