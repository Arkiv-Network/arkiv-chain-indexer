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
  type EntityVersion,
} from "./entityIndex";
import type { ArkivOperationAttribute } from "./arkivOperations";
import { udcAttribute } from "./testUdc";

const KEY = "0x" + "ab".repeat(32);
const ALICE = "0x" + "aa".repeat(20);
const BOB = "0x" + "bb".repeat(20);

// Values in the decoder's (= the node's) wire encoding.
const str = (name: string, value: string): ArkivOperationAttribute => udcAttribute(name, "str", value);
const u64 = (name: string, value: string): ArkivOperationAttribute => udcAttribute(name, "u64", `0x${BigInt(value).toString(16)}`);
const i32 = (name: string, value: string): ArkivOperationAttribute => udcAttribute(name, "i32", Number(value));
const dec = (name: string, value: string): ArkivOperationAttribute => udcAttribute(name, "dec", value);
const tombstone = (name: string): ArkivOperationAttribute => udcAttribute(name, "tombstone", null);

function op(overrides: Partial<EntityOpRecord> & { blockNumber: number; operationType: number }): EntityOpRecord {
  return {
    position: 0,
    opIndex: 0,
    entityKey: KEY,
    sender: ALICE,
    creationFlags: null,
    attributes: [],
    expiresAt: null,
    minLifetime: null,
    newOwner: null,
    ...overrides,
  };
}

const create = (blockNumber: number, extra: Partial<EntityOpRecord> = {}) =>
  op({
    blockNumber,
    operationType: OPERATION_CREATE,
    attributes: [str("project", "demo"), u64("rank", "7")],
    expiresAt: 0n,
    minLifetime: 900n,
    ...extra,
  });

describe("resolveRequestedExpiry", () => {
  test("is exactly max(expiresAt, block + minLifetime), capped at 2^64 - 1", () => {
    expect(resolveRequestedExpiry(1000, 0n, 900n)).toBe(1900n);
    expect(resolveRequestedExpiry(1000, 5000n, 900n)).toBe(5000n);
    expect(resolveRequestedExpiry(1000, 1001n, 0n)).toBe(1001n);
    expect(resolveRequestedExpiry(1000, 0n, 0n)).toBe(1000n);
    const u64Max = (1n << 64n) - 1n;
    expect(resolveRequestedExpiry(1000, u64Max, 0n)).toBe(u64Max);
    // A lifetime that reaches past u64 is permanence too.
    expect(resolveRequestedExpiry(1000, 0n, u64Max - 10n)).toBe(u64Max);
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
      contentType: "",
      payloadSize: 0,
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
    expect(v1.attributes).toEqual([
      { name: "new", typeId: 8, valueText: "x", valueNum: null },
      { name: "rank", typeId: 2, valueText: "-2", valueNum: -2n },
      { name: "score", typeId: 5, valueText: "1.5", valueNum: 1_500_000_000_000_000_000n },
    ]);
  });

  test("extend replaces the expiry (event first, calldata otherwise); transfer replaces the owner", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1500, operationType: OPERATION_EXTEND, expiresAt: 0n, minLifetime: 901n }),
      op({ blockNumber: 1600, operationType: OPERATION_EXTEND, expiresAt: 0n, minLifetime: 5n, event: { expiresAt: 9999n } }),
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
          { name: "invalid", typeId: 0x87, type: "invalid(0x87)", indexed: true, value: null, size: 0, error: "bytes cannot be indexed" },
          udcAttribute("blob", "bytes", null, { size: 9, keccak256: `0x${"ab".repeat(32)}` }),
          udcAttribute("broken", "u64", "not a number"),
          udcAttribute("ok", "addr", "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"),
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

describe("foldEntityVersions with a genesis base", () => {
  const base = (): EntityVersion => ({
    entityKey: KEY,
    version: 0,
    fromBlock: 0,
    fromPosition: 41,
    fromOpIndex: 0,
    toBlock: null,
    deleted: false,
    owner: ALICE,
    creator: ALICE,
    createdAt: 0,
    createdPosition: 41,
    createdOpIndex: 0,
    updatedAt: 0,
    expiresAt: 5000n,
    creationFlags: 0,
    contentType: "application/json",
    payloadSize: 0,
    attributes: [
      { name: "project", typeId: 8, valueText: "seed", valueNum: null },
      { name: "rank", typeId: 3, valueText: "7", valueNum: 7n },
    ],
  });

  test("the base alone is version 0 with no end", () => {
    expect(foldEntityVersions(KEY, [], base())).toEqual([base()]);
  });

  test("operations replay on top of the base and keep its identity", () => {
    const versions = foldEntityVersions(
      KEY,
      [
        op({ blockNumber: 10, position: 2, operationType: OPERATION_UPDATE, attributes: [tombstone("project"), i32("rank", "-1"), str("new", "x")] }),
        op({ blockNumber: 20, operationType: OPERATION_EXTEND, expiresAt: 9000n, minLifetime: 0n }),
        op({ blockNumber: 30, operationType: OPERATION_TRANSFER, newOwner: BOB }),
        op({ blockNumber: 40, operationType: OPERATION_DELETE }),
      ],
      base(),
    );
    expect(versions.map((version) => [version.version, version.fromBlock, version.toBlock])).toEqual([
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
      [3, 30, 40],
      [4, 40, null],
    ]);
    expect(versions[0]!.attributes).toEqual(base().attributes);
    expect(versions[1]!.attributes).toEqual([
      { name: "new", typeId: 8, valueText: "x", valueNum: null },
      { name: "rank", typeId: 2, valueText: "-1", valueNum: -1n },
    ]);
    expect(versions[1]).toMatchObject({ fromPosition: 2, updatedAt: 10, createdAt: 0, createdPosition: 41, owner: ALICE, creator: ALICE });
    expect(versions[2]!.expiresAt).toBe(9000n);
    expect(versions[3]!.owner).toBe(BOB);
    expect(versions[3]!.creator).toBe(ALICE);
    expect(versions[4]!.deleted).toBe(true);
  });

  test("a create on a based key is ignored, like a create on any existing entity", () => {
    const versions = foldEntityVersions(KEY, [create(15), op({ blockNumber: 16, operationType: OPERATION_EXTEND, expiresAt: 7000n, minLifetime: 0n })], base());
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ version: 0, fromBlock: 0, toBlock: 16, contentType: "application/json" });
    expect(versions[1]).toMatchObject({ version: 1, fromBlock: 16, expiresAt: 7000n });
  });

  test("the base's attributes are copied, never shared with the versions", () => {
    const given = base();
    const versions = foldEntityVersions(KEY, [op({ blockNumber: 10, operationType: OPERATION_UPDATE, attributes: [str("project", "changed")] })], given);
    expect(given.attributes[0]).toEqual({ name: "project", typeId: 8, valueText: "seed", valueNum: null });
    expect(versions[0]!.attributes).not.toBe(given.attributes);
  });
});
