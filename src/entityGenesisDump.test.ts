import { describe, expect, test } from "bun:test";
import { hexToBytes, toHex } from "viem";
import { GenesisEntityError } from "./entityGenesis";
import {
  ENTITY_COUNT_SLOT,
  GenesisIdLedger,
  decodeEntityRecord,
  idToKeySlot,
  isEntityRecordCode,
  keyToIdSlot,
  readGenesisDump,
  type DumpEvent,
} from "./entityGenesisDump";
import { DUMP_OWNER, buildDump, buildEntityRecord, dumpKey, encodeAttributeValue, memoryDumpSource, seederSystemStorage } from "./testGenesisDump";

const KEY = "0xdae9aecdfc7d802a4e88d70c5940ceea017a93e43e855e763ce8112f59a59ef6" as const;

describe("storage slots", () => {
  // Anchors taken from a real seed-genesis dump (the Sourcify run): its first
  // entity's key2id slot, the id2key slot of id 0, and the entity_count slot.
  test("match the node's derivations", () => {
    expect(keyToIdSlot(hexToBytes(KEY))).toBe("0x1834ed68b2e713c790f915fa914a41e91227e94b41d6f4a174731da43132edd0");
    expect(idToKeySlot(0)).toBe("0xc81b54e2a1c134cf078f692d0ef551bceb275d55834b0da2467790bf34e5fcd6");
    expect(idToKeySlot(1n)).toBe("0x39a38930c5a5c0fce4213ecc706c7296eefb5d77918e0cd3807938a69fff4c8c");
    expect(ENTITY_COUNT_SLOT).toBe("0xb3f1f98b9713db1233d930e27cc61fdc717c1310d11ad145e0ad1ab45579cfbe");
  });
});

describe("decodeEntityRecord", () => {
  const full = {
    key: KEY,
    owner: DUMP_OWNER,
    creator: "0x1111111111111111111111111111111111111111" as const,
    expiresAt: 2_903_242n,
    contentType: "application/json",
    payload: new Uint8Array([0, 1, 2, 127, 128, 200, 255, 0]),
    creationFlags: 3,
    attributes: [
      { name: "flag", type: "bool" as const, value: encodeAttributeValue("bool", true) },
      { name: "temp", type: "i32" as const, value: encodeAttributeValue("i32", -40) },
      { name: "big", type: "u64" as const, value: encodeAttributeValue("u64", (1n << 64n) - 1n) },
      { name: "huge", type: "u256" as const, value: encodeAttributeValue("u256", (1n << 255n) + 7n) },
      { name: "price", type: "dec" as const, value: encodeAttributeValue("dec", -1_500_000_000_000_000_000n) },
      { name: "ref", type: "key" as const, value: encodeAttributeValue("key", dumpKey(9)) },
      { name: "hash", type: "bytes32" as const, value: encodeAttributeValue("bytes32", "0x" + "ab".repeat(32)) },
      { name: "who", type: "addr" as const, value: encodeAttributeValue("addr", "0xABCDEF0123456789ABCDEF0123456789ABCDEF01") },
      { name: "name", type: "str" as const, value: encodeAttributeValue("str", "zażółć 🐘") },
    ],
  };

  test("decodes every field of a v1 record into the genesis version", () => {
    const version = decodeEntityRecord(buildEntityRecord(full), 41);
    expect(version).toMatchObject({
      entityKey: KEY,
      version: 0,
      fromBlock: 0,
      fromPosition: 41,
      createdAt: 0,
      createdPosition: 41,
      updatedAt: 0,
      toBlock: null,
      deleted: false,
      owner: DUMP_OWNER,
      creator: full.creator,
      expiresAt: 2_903_242n,
      creationFlags: 3,
      contentType: "application/json",
      payloadSize: 8,
    });
    expect(version.attributes.map((a) => [a.name, a.typeId, a.valueText, a.valueNum])).toEqual([
      ["big", 3, "18446744073709551615", (1n << 64n) - 1n],
      ["flag", 1, "true", null],
      ["hash", 6, "0x" + "ab".repeat(32), null],
      ["huge", 4, ((1n << 255n) + 7n).toString(), (1n << 255n) + 7n],
      ["name", 8, "zażółć 🐘", null],
      ["price", 5, "-1.5", -1_500_000_000_000_000_000n],
      ["ref", 10, dumpKey(9), null],
      ["temp", 2, "-40", -40n],
      ["who", 9, "0xabcdef0123456789abcdef0123456789abcdef01", null],
    ]);
  });

  test("a v0 record has no flags byte and reports flags 0", () => {
    const version = decodeEntityRecord(buildEntityRecord({ ...full, version: 0 }), 0);
    expect(version.creationFlags).toBe(0);
    expect(version.payloadSize).toBe(8);
  });

  test("byte vectors encoded as RLP strings decode the same", () => {
    const asLists = decodeEntityRecord(buildEntityRecord(full), 5);
    const asStrings = decodeEntityRecord(buildEntityRecord({ ...full, byteStrings: true }), 5);
    expect(asStrings).toEqual(asLists);
  });

  test("an empty payload and no attributes", () => {
    const version = decodeEntityRecord(buildEntityRecord({ key: KEY }), 0);
    expect(version.payloadSize).toBe(0);
    expect(version.attributes).toEqual([]);
    expect(version.expiresAt).toBe((1n << 64n) - 1n);
    expect(version.creationFlags).toBe(0);
  });

  test("recognises entity code by its prefix", () => {
    expect(isEntityRecordCode("0xfe01c0")).toBe(true);
    expect(isEntityRecordCode("0xFE00c0")).toBe(true);
    expect(isEntityRecordCode("0xfe02c0")).toBe(false);
    expect(isEntityRecordCode("0x0100")).toBe(false);
    expect(isEntityRecordCode(new Uint8Array([0xfe, 0x01]))).toBe(true);
    expect(isEntityRecordCode(new Uint8Array([0xfe]))).toBe(false);
  });

  const refuses = (code: Uint8Array, message: string) => {
    expect(() => decodeEntityRecord(code, 0)).toThrow(GenesisEntityError);
    expect(() => decodeEntityRecord(code, 0)).toThrow(message);
  };

  test("refuses what is not a block-0 entity record", () => {
    refuses(new Uint8Array([0x60, 0x00, 0xc0]), "0xFE entity marker");
    refuses(new Uint8Array([0xfe, 0x02, 0xc0]), "unknown entity record version 2");
    refuses(buildEntityRecord({ key: KEY, createdAtBlock: 5n }), "created_at_block is 5");
    refuses(buildEntityRecord({ key: KEY, lastModifiedAtBlock: 9n }), "last_modified_at_block is 9");
    const truncated = buildEntityRecord({ key: KEY });
    refuses(truncated.subarray(0, truncated.length - 3), "truncated RLP");
    refuses(new Uint8Array([...buildEntityRecord({ key: KEY }), 0x01]), "trailing bytes");
    const v0AsV1 = buildEntityRecord({ key: KEY, version: 0 });
    v0AsV1[1] = 1;
    refuses(v0AsV1, "has 9 fields, expected 10");
  });

  test("refuses attribute values that are not what their type says", () => {
    refuses(buildEntityRecord({ key: KEY, attributes: [{ name: "b", type: "bool", value: new Uint8Array([2]) }] }), "bool byte 2");
    refuses(buildEntityRecord({ key: KEY, attributes: [{ name: "n", type: "u64", value: new Uint8Array(4) }] }), "a u64 value is 8 bytes, got 4");
    refuses(buildEntityRecord({ key: KEY, attributes: [{ name: "s", type: "str", value: new Uint8Array([0xff, 0xfe]) }] }), "not valid UTF-8");
    refuses(buildEntityRecord({ key: KEY, attributes: [{ name: "p", type: "bytes", value: new Uint8Array([1]) }] }), "bytes attributes are system-only");
    const unknownType = buildEntityRecord({ key: KEY, attributes: [{ name: "x", type: "bool", value: new Uint8Array([1]) }] });
    // The type id byte sits right before the value list: 0x01 (bool) → 0x0b (unknown).
    const at = unknownType.lastIndexOf(0x01, unknownType.length - 4);
    unknownType[at] = 0x0b;
    refuses(unknownType, "unknown type id 11");
  });

  test("refuses a position the index cannot hold", () => {
    expect(() => decodeEntityRecord(buildEntityRecord({ key: KEY }), 2 ** 31)).toThrow("outside the index's range");
  });
});

describe("readGenesisDump", () => {
  const entities = [0, 1, 2].map((n) => ({ key: dumpKey(n + 1), payload: new Uint8Array([n]) }));

  const collect = async (text: string, chunkSize = 7, offset = 0, line = 1): Promise<DumpEvent[]> => {
    const events: DumpEvent[] = [];
    for await (const event of readGenesisDump(memoryDumpSource(text, chunkSize), offset, line)) events.push(event);
    return events;
  };

  test("yields the root, records, the system account's slots, and the rest, with line offsets", async () => {
    const text = buildDump(entities);
    const events = await collect(text);
    expect(events[0]).toMatchObject({ type: "root", line: 1, end: text.indexOf("\n") + 1 });
    const records = events.filter((event) => event.type === "record");
    expect(records.map((event) => event.type === "record" && event.address)).toEqual(entities.map((entity) => entity.key.slice(0, 42)));
    expect(records.map((event) => event.type === "record" && event.line)).toEqual([3, 5, 7]);
    const slots = events.filter((event): event is Extract<DumpEvent, { type: "slot" }> => event.type === "slot");
    expect(slots.map((slot) => [slot.slot, slot.value])).toEqual(seederSystemStorage(entities.map((entity) => entity.key)));
    const system = events.find((event) => event.type === "system");
    expect(system).toMatchObject({ type: "system", line: 8, slots: 7 });
    const last = events[events.length - 1]!;
    expect(last).toMatchObject({ type: "other", line: 9, end: text.length });
    // Every line boundary is where the next event says the line ends.
    const lineEnds = events.filter((event) => event.type !== "slot").map((event) => (event as { end: number }).end);
    expect(lineEnds).toEqual(text.split("\n").slice(0, -1).map((_, i, lines) => lines.slice(0, i + 1).join("\n").length + 1));
  });

  test("an account whose bytecode merely starts with 0xFE is not a record", async () => {
    // 0xFE is also the INVALID opcode; only a known record version byte marks an entity.
    const text = buildDump(entities.slice(0, 1)).replace(
      "\n",
      `\n${JSON.stringify({ address: `0x${"77".repeat(20)}`, nonce: "0x1", balance: "0x0", code: "0xfe02c0" })}\n`,
    );
    const events = await collect(text);
    expect(events[1]).toMatchObject({ type: "other", line: 2 });
    expect(events.filter((event) => event.type === "record")).toHaveLength(1);
  });

  test("the same events whatever the chunk size, and without a trailing newline", async () => {
    const text = buildDump(entities, { trailingNewline: false });
    const small = await collect(text, 3);
    const big = await collect(text, 1 << 20);
    expect(small).toEqual(big);
    expect(small[small.length - 1]).toMatchObject({ type: "other", end: text.length });
    expect(small.filter((event) => event.type === "slot")).toHaveLength(7);
  });

  test("resumes from a line boundary", async () => {
    const text = buildDump(entities);
    const all = await collect(text);
    const second = all.find((event) => event.type === "record" && event.line === 5)!;
    const resumed = await collect(text, 7, (second as { end: number }).end, 6);
    expect(resumed.map((event) => event.type)).toEqual(["other", "record", ...Array(7).fill("slot"), "system", "other"]);
    expect(resumed[1]).toMatchObject({ type: "record", line: 7 });
  });

  test("the system account may come before the records", async () => {
    const events = await collect(buildDump(entities, { systemFirst: true }));
    const types = events.map((event) => event.type);
    expect(types.indexOf("system")).toBeLessThan(types.indexOf("record"));
    expect(events.filter((event) => event.type === "slot")).toHaveLength(7);
  });

  test("refuses a dump that does not start with the root", async () => {
    await expect(collect('{"address":"0x01","balance":"0x0"}\n')).rejects.toThrow("does not start with");
  });
});

describe("GenesisIdLedger", () => {
  const keys = [dumpKey(1), dumpKey(2), dumpKey(3)];
  const run = (recordOrder: readonly `0x${string}`[], storage = seederSystemStorage(keys), systemSeen = true): GenesisIdLedger => {
    const ledger = new GenesisIdLedger();
    for (const key of recordOrder) ledger.addRecord(key);
    for (const [slot, value] of storage) ledger.addSlot(slot, value);
    if (systemSeen) ledger.markSystemSeen();
    return ledger;
  };

  test("accepts records in id order and reports the counts", () => {
    const ledger = run(keys);
    expect(() => ledger.verify(3)).not.toThrow();
    expect(ledger.state()).toMatchObject({ records: 3, ids: 3, systemSeen: true, entityCount: "3" });
    expect(ledger.state().recordChain).toBe(ledger.state().idChain);
  });

  test("survives a round trip through its state", () => {
    const first = new GenesisIdLedger();
    first.addRecord(keys[0]!);
    first.addRecord(keys[1]!);
    const resumed = new GenesisIdLedger(first.state());
    resumed.addRecord(keys[2]!);
    for (const [slot, value] of seederSystemStorage(keys)) resumed.addSlot(slot, value);
    resumed.markSystemSeen();
    expect(() => resumed.verify(3)).not.toThrow();
  });

  test("names what does not add up", () => {
    expect(() => run([keys[1]!, keys[0]!, keys[2]!]).verify(3)).toThrow("not in entity-id order");
    expect(() => run(keys).verify(4)).toThrow("holds 3 entity records but the manifest counts 4");
    expect(() => run(keys, seederSystemStorage(keys), false).verify(3)).toThrow("never appeared");
    expect(() => run(keys, seederSystemStorage(keys, 5)).verify(3)).toThrow("counts 5 entities, the manifest 3");
    const sorted = [...seederSystemStorage(keys)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(() => run(keys, sorted).verify(3)).toThrow(/not in insertion order|not in entity-id order/);
    expect(() => run(keys, seederSystemStorage(keys).filter(([slot]) => slot !== ENTITY_COUNT_SLOT)).verify(3)).toThrow("no arkiv.entity_count slot");
  });

  test("ignores key2id pairs, nonces, and case", () => {
    const ledger = new GenesisIdLedger();
    ledger.addRecord(keys[0]!);
    ledger.addSlot(toHex(123n, { size: 32 }), toHex(1n, { size: 32 })); // an owner nonce
    ledger.addSlot(idToKeySlot(0).toUpperCase().replace("0X", "0x"), keys[0]!);
    ledger.addSlot(ENTITY_COUNT_SLOT, "0x1");
    ledger.markSystemSeen();
    expect(() => ledger.verify(1)).not.toThrow();
  });
});
