import { describe, expect, test } from "bun:test";
import { defaultProjection, projectEntity, type Projection } from "./arkivJsonRpc";
import { fillCreateEntityKeys, parseDecoderResponse, type ArkivOperationAttribute } from "./arkivOperations";
import {
  ENTITY_EVENT_TOPICS,
  EntityFoldError,
  OPERATION_CREATE,
  OPERATION_DELETE,
  OPERATION_EXTEND,
  OPERATION_PATCH,
  OPERATION_TRANSFER,
  PERMANENT_EXPIRY,
  attachEventsToOps,
  foldEntityVersions,
  resolveRequestedExpiry,
  type EntityEventLog,
  type EntityOpRecord,
  type EntityVersion,
} from "./entityIndex";
import { LIVE_BLOCKS, udcAttribute } from "./testUdc";
import type { Hex } from "./types";

const KEY = "0x" + "ab".repeat(32);
const ALICE = "0x" + "aa".repeat(20);
const BOB = "0x" + "bb".repeat(20);
const HASH = `0x${"ee".repeat(32)}`;

// Values in the decoder's (= the node's) wire encoding; indexed unless said otherwise.
const str = (name: string, value: string, indexed = true): ArkivOperationAttribute => udcAttribute(name, "str", value, { indexed });
const u64 = (name: string, value: string): ArkivOperationAttribute => udcAttribute(name, "u64", `0x${BigInt(value).toString(16)}`);
const i32 = (name: string, value: string, indexed = true): ArkivOperationAttribute => udcAttribute(name, "i32", Number(value), { indexed });
const dec = (name: string, value: string): ArkivOperationAttribute => udcAttribute(name, "dec", value);
const bytes = (name: string, size: number, keccak256: string): ArkivOperationAttribute =>
  udcAttribute(name, "bytes", null, { size, keccak256 });
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
    creationFlags: 0,
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
    expect(resolveRequestedExpiry(1000, PERMANENT_EXPIRY, 0n)).toBe(PERMANENT_EXPIRY);
    // A lifetime that reaches past u64 is permanence too.
    expect(resolveRequestedExpiry(1000, 0n, PERMANENT_EXPIRY - 10n)).toBe(PERMANENT_EXPIRY);
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
      creationFlags: 0,
      bytesSize: 0,
      schemaName: null,
      attributes: [
        { name: "project", typeId: 8, indexed: true, valueText: "demo", valueNum: null },
        { name: "rank", typeId: 3, indexed: true, valueText: "7", valueNum: 7n },
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

  test("unindexed attributes are kept with their flag; bytes as keccak256 and size; the schema tag is lifted", () => {
    const hash = `0x${"5a".repeat(32)}`;
    const [v0] = foldEntityVersions(KEY, [
      create(1000, {
        attributes: [
          str("arkiv.schema", "posts"),
          bytes("body", 49, hash),
          str("mimeType", "application/json", false),
          i32("level", "42"),
          bytes("thumb", 7, `0x${"5b".repeat(32)}`),
        ],
      }),
    ]);
    expect(v0!.attributes).toEqual([
      { name: "arkiv.schema", typeId: 8, indexed: true, valueText: "posts", valueNum: null },
      { name: "body", typeId: 7, indexed: false, valueText: hash, valueNum: 49n },
      { name: "level", typeId: 2, indexed: true, valueText: "42", valueNum: 42n },
      { name: "mimeType", typeId: 8, indexed: false, valueText: "application/json", valueNum: null },
      { name: "thumb", typeId: 7, indexed: false, valueText: `0x${"5b".repeat(32)}`, valueNum: 7n },
    ]);
    expect(v0!.bytesSize).toBe(56);
    expect(v0!.schemaName).toBe("posts");
  });

  test("only an indexed str arkiv.schema is a schema tag", () => {
    const [v0] = foldEntityVersions(KEY, [create(1000, { attributes: [str("arkiv.schema", "posts", false)] })]);
    expect(v0!.schemaName).toBeNull();
  });

  test("a patch sets, retypes, re-flags and unsets attributes in calldata order and bumps updatedAt", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000, { attributes: [str("project", "demo"), u64("rank", "7"), str("title", "a", false), bytes("body", 3, `0x${"01".repeat(32)}`)] }),
      op({
        blockNumber: 1010,
        position: 3,
        operationType: OPERATION_PATCH,
        attributes: [
          tombstone("project"),
          i32("rank", "-2"),
          dec("score", "1.50"),
          str("title", "a"), // stored → indexed, same value
          bytes("body", 13, `0x${"02".repeat(32)}`),
          str("new", "x", false),
        ],
      }),
      op({ blockNumber: 1011, operationType: OPERATION_PATCH, attributes: [str("title", "b", false), tombstone("body")] }),
    ]);
    expect(versions).toHaveLength(3);
    expect(versions[0]!.toBlock).toBe(1010);
    const v1 = versions[1]!;
    expect(v1).toMatchObject({ version: 1, fromBlock: 1010, fromPosition: 3, updatedAt: 1010, createdAt: 1000, expiresAt: 1900n, bytesSize: 13 });
    expect(v1.attributes).toEqual([
      { name: "body", typeId: 7, indexed: false, valueText: `0x${"02".repeat(32)}`, valueNum: 13n },
      { name: "new", typeId: 8, indexed: false, valueText: "x", valueNum: null },
      { name: "rank", typeId: 2, indexed: true, valueText: "-2", valueNum: -2n },
      { name: "score", typeId: 5, indexed: true, valueText: "1.5", valueNum: 1_500_000_000_000_000_000n },
      { name: "title", typeId: 8, indexed: true, valueText: "a", valueNum: null },
    ]);
    const v2 = versions[2]!;
    expect(v2.bytesSize).toBe(0);
    expect(v2.attributes.find((attribute) => attribute.name === "title")).toEqual({
      name: "title",
      typeId: 8,
      indexed: false,
      valueText: "b",
      valueNum: null,
    });
    expect(v2.attributes.map((attribute) => attribute.name)).toEqual(["new", "rank", "score", "title"]);
  });

  test("the same name set twice in one patch ends with the last triple", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1001, operationType: OPERATION_PATCH, attributes: [str("k", "first"), tombstone("k"), i32("k", "3")] }),
    ]);
    expect(versions[1]!.attributes.find((attribute) => attribute.name === "k")).toMatchObject({ typeId: 2, valueText: "3" });
  });

  test("extend replaces the expiry (event first, calldata otherwise); transfer replaces the owner", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1500, operationType: OPERATION_EXTEND, expiresAt: 0n, minLifetime: 901n }),
      op({ blockNumber: 1600, operationType: OPERATION_EXTEND, expiresAt: 0n, minLifetime: 5n, event: { expiresAt: 9999n } }),
      op({ blockNumber: 1650, operationType: OPERATION_EXTEND, expiresAt: PERMANENT_EXPIRY, minLifetime: 0n }),
      op({ blockNumber: 1700, operationType: OPERATION_TRANSFER, newOwner: BOB.toUpperCase().replace("0X", "0x") }),
    ]);
    expect(versions.map((version) => version.expiresAt)).toEqual([1900n, 2401n, 9999n, PERMANENT_EXPIRY, PERMANENT_EXPIRY]);
    expect(versions[4]).toMatchObject({ owner: BOB, creator: ALICE, updatedAt: 1700 });
    expect(versions.map((version) => version.toBlock)).toEqual([1500, 1600, 1650, 1700, null]);
  });

  test("a delete ends the entity and later operations are ignored", () => {
    const versions = foldEntityVersions(KEY, [
      create(1000),
      op({ blockNumber: 1001, operationType: OPERATION_DELETE }),
      op({ blockNumber: 1002, operationType: OPERATION_PATCH, attributes: [str("k", "v")] }),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ deleted: true, fromBlock: 1001, toBlock: null, owner: ALICE });
  });

  test("operations before the create and unknown types are ignored; order is by chain position", () => {
    const versions = foldEntityVersions(KEY, [
      op({ blockNumber: 1000, position: 2, operationType: OPERATION_PATCH, attributes: [str("late", "y")] }),
      op({ blockNumber: 999, operationType: OPERATION_PATCH, attributes: [str("early", "x")] }),
      op({ blockNumber: 1000, position: 1, opIndex: 1, operationType: 9 }),
      create(1000, { position: 1 }),
    ]);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ fromBlock: 1000, fromPosition: 1, toBlock: 1000 });
    expect(versions[1]!.attributes.map((attribute) => attribute.name)).toEqual(["late", "project", "rank"]);
  });

  test("an applied triple the node would refuse, or a value not of its type, stops the fold instead of vanishing", () => {
    const fold = (attribute: ArkivOperationAttribute) => () => foldEntityVersions(KEY, [create(1000, { attributes: [attribute] })]);
    const flagged = { name: "invalid", typeId: 0x87, type: "invalid(0x87)", indexed: true, value: null, size: 0, error: "bytes cannot be indexed" };
    expect(fold(flagged)).toThrow(EntityFoldError);
    expect(fold(flagged)).toThrow(`operation 0 of transaction 0 in block 1000 (entity ${KEY}): attribute "invalid" carries the decoder error "bytes cannot be indexed"`);
    expect(fold({ name: "nohash", typeId: 7, type: "bytes", indexed: false, value: null, size: 9 })).toThrow('attribute "nohash" (typeId 7) does not read as its type');
    expect(fold(udcAttribute("broken", "u64", "not a number"))).toThrow('attribute "broken" (typeId 131) does not read as its type');
    const patched = () =>
      foldEntityVersions(KEY, [create(1000), op({ blockNumber: 1001, operationType: OPERATION_PATCH, attributes: [udcAttribute("broken", "i32", "1")] })]);
    expect(patched).toThrow("in block 1001");
    // The node's addresses are lowercase; the fold stores them so.
    const [v0] = foldEntityVersions(KEY, [create(1000, { attributes: [udcAttribute("ok", "addr", "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa")] })]);
    expect(v0!.attributes).toEqual([{ name: "ok", typeId: 9, indexed: true, valueText: ALICE, valueNum: null }]);
  });

  test("no create means no versions", () => {
    expect(foldEntityVersions(KEY, [op({ blockNumber: 1, operationType: OPERATION_PATCH })])).toEqual([]);
    expect(foldEntityVersions(KEY, [])).toEqual([]);
  });
});

describe("fold of the live UDC chain's creates against the node's own view", () => {
  const FULL: Projection = {
    ...defaultProjection(),
    owner: true,
    creator: true,
    createdAt: true,
    updatedAt: true,
    expiresAt: true,
    creationFlags: true,
    attributeSchema: true,
    attributes: { mode: "all" },
  };

  /** Every create the fixtures recorded, folded alone from its decoded calldata and receipt, as the index sees it. */
  function liveCreates(): Array<{ block: number; key: string; version: EntityVersion; node: Record<string, unknown> }> {
    const out: Array<{ block: number; key: string; version: EntityVersion; node: Record<string, unknown> }> = [];
    for (const block of LIVE_BLOCKS) {
      for (const transaction of block.transactions) {
        const operations = parseDecoderResponse(transaction.decoded);
        const logs = transaction.logs.map((log, logIndex) => ({
          logIndex,
          address: "0x4400000000000000000000000000000000000044" as Hex,
          topics: log.topics,
          data: log.data,
        }));
        fillCreateEntityKeys(transaction.hash, operations, {
          transactionHash: transaction.hash,
          gasUsed: "0x0",
          status: transaction.status,
          logs: logs.map(({ address, topics, data }) => ({ address, topics, data })),
        });
        const records: EntityOpRecord[] = operations
          .filter((operation) => operation.entityKey !== null)
          .map((operation) => ({
            blockNumber: block.blockNumber,
            position: transaction.transactionIndex,
            opIndex: operation.opIndex,
            operationType: operation.operationType,
            entityKey: operation.entityKey!,
            sender: transaction.from.toLowerCase(),
            creationFlags: operation.creationFlags,
            attributes: operation.attributes,
            expiresAt: operation.expiresAt === null ? null : BigInt(operation.expiresAt),
            minLifetime: operation.minLifetime === null ? null : BigInt(operation.minLifetime),
            newOwner: operation.newOwner,
          }));
        attachEventsToOps(
          records,
          logs.map((log) => ({
            logIndex: log.logIndex,
            address: log.address,
            topic0: log.topics[0] ?? null,
            topic1: log.topics[1] ?? null,
            topic2: log.topics[2] ?? null,
            topic3: log.topics[3] ?? null,
            data: log.data,
          })),
        );
        for (const record of records.filter((candidate) => candidate.operationType === OPERATION_CREATE)) {
          const view = transaction.nodeViews.find((candidate) => candidate.key === record.entityKey && candidate.atBlock === block.blockNumber);
          if (!view?.entity) continue;
          const versions = foldEntityVersions(record.entityKey, records.filter((candidate) => candidate.entityKey === record.entityKey));
          out.push({ block: block.blockNumber, key: record.entityKey, version: versions.at(-1)!, node: view.entity as unknown as Record<string, unknown> });
        }
      }
    }
    return out;
  }

  test("covers the permanent, mixed-batch, all-types, 32 KiB bytes and case-sensitive creates", () => {
    const blocks = new Set(liveCreates().map((entry) => entry.block));
    for (const block of [16, 48, 52, 54, 63, 65, 101]) expect(blocks.has(block)).toBe(true);
  });

  test("each create folds to exactly the entity the node answered, bytes values aside", () => {
    for (const { key, version, node } of liveCreates()) {
      const projected = projectEntity(version, FULL);
      // The node returns bytes contents; the fixture keeps their size and
      // hash, and the index answers null for them (it never holds them).
      const nodeAttributes = (node.attributes as Array<{ name: string; type: string; value: unknown }>).map(({ name, type, value }) => ({ name, type, value }));
      expect({ key, ...projected } as Record<string, unknown>).toEqual({ key, ...node, attributes: nodeAttributes });
      for (const attribute of node.attributes as Array<{ name: string; type: string; size?: number; keccak256?: string }>) {
        if (attribute.type !== "bytes") continue;
        const stored = version.attributes.find((candidate) => candidate.name === attribute.name)!;
        expect(stored).toMatchObject({ typeId: 7, indexed: false, valueText: attribute.keccak256, valueNum: BigInt(attribute.size!) });
      }
    }
  });

  test("the permanent create of block 48 carries 2^64 - 1", () => {
    const permanent = liveCreates().find((entry) => entry.block === 48)!;
    expect(permanent.version.expiresAt).toBe(PERMANENT_EXPIRY);
    expect(projectEntity(permanent.version, FULL).expiresAt).toBe("0xffffffffffffffff");
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

  test("an event word wider than the engine's uint64 expiry or uint8 flags stops the fold, not the database", () => {
    const attach = (topic0: string, data: string) => () =>
      attachEventsToOps([op({ blockNumber: 5, operationType: topic0 === ENTITY_EVENT_TOPICS.created ? OPERATION_CREATE : OPERATION_EXTEND })], [log({ logIndex: 3, topic0, data })]);
    expect(attach(ENTITY_EVENT_TOPICS.created, `0x${word(1n << 64n)}${word(0n)}`)).toThrow(EntityFoldError);
    expect(attach(ENTITY_EVENT_TOPICS.created, `0x${word(1n << 64n)}${word(0n)}`)).toThrow("log 3: its EntityCreated expiresAt word 18446744073709551616 exceeds 18446744073709551615");
    expect(attach(ENTITY_EVENT_TOPICS.created, `0x${word(9n)}${word(256n)}`)).toThrow("EntityCreated creationFlags word 256 exceeds 255");
    expect(attach(ENTITY_EVENT_TOPICS.expiryExtended, `0x${"f".repeat(64)}`)).toThrow("ExpiryExtended expiresAt word");
    // 2^64 - 1 itself is the permanent expiry, kept exactly.
    const ops = [op({ blockNumber: 5, operationType: OPERATION_CREATE })];
    attachEventsToOps(ops, [log({ logIndex: 0, topic0: ENTITY_EVENT_TOPICS.created, data: `0x${word((1n << 64n) - 1n)}${word(3n)}` })]);
    expect(ops[0]!.event).toEqual({ expiresAt: (1n << 64n) - 1n, creationFlags: 3 });
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
    bytesSize: 0,
    schemaName: null,
    attributes: [
      { name: "project", typeId: 8, indexed: true, valueText: "seed", valueNum: null },
      { name: "rank", typeId: 3, indexed: true, valueText: "7", valueNum: 7n },
    ],
  });

  test("the base alone is version 0 with no end", () => {
    expect(foldEntityVersions(KEY, [], base())).toEqual([base()]);
  });

  test("operations replay on top of the base and keep its identity", () => {
    const versions = foldEntityVersions(
      KEY,
      [
        op({ blockNumber: 10, position: 2, operationType: OPERATION_PATCH, attributes: [tombstone("project"), i32("rank", "-1"), str("new", "x")] }),
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
      { name: "new", typeId: 8, indexed: true, valueText: "x", valueNum: null },
      { name: "rank", typeId: 2, indexed: true, valueText: "-1", valueNum: -1n },
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
    expect(versions[0]).toMatchObject({ version: 0, fromBlock: 0, toBlock: 16, attributes: base().attributes });
    expect(versions[1]).toMatchObject({ version: 1, fromBlock: 16, expiresAt: 7000n });
  });

  test("the base's attributes are copied, never shared with the versions", () => {
    const given = base();
    const versions = foldEntityVersions(KEY, [op({ blockNumber: 10, operationType: OPERATION_PATCH, attributes: [str("project", "changed")] })], given);
    expect(given.attributes[0]).toEqual({ name: "project", typeId: 8, indexed: true, valueText: "seed", valueNum: null });
    expect(versions[0]!.attributes).not.toBe(given.attributes);
  });
});
