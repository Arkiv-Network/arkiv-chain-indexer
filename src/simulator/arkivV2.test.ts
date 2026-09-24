import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fixture from "./fixtures/native-history-v2.json";
import { parseAttribute, parseFeedBlock, parseStatus } from "./wire";
import { parsePredicate, predicateSql, SqlArgs } from "./query";
import { feedDigest } from "./feedDigest";
import { SimulatorStorage } from "./storage";
import { openDb } from "../db";

const u256Max = ((1n << 256n) - 1n).toString();
function resign(block: typeof fixture.blocks[number]) {
  const { feedDigest: _, ...rest } = block;
  return { ...rest, feedDigest: feedDigest(rest) };
}
test("captured Arkiv v2 status and 15 canonical feed blocks preserve only committed metadata", () => {
  expect<unknown>(parseStatus(fixture.status)).toEqual(fixture.status);
  for (const raw of fixture.blocks) expect<unknown>(parseFeedBlock(raw)).toEqual(raw);
  const b = parseFeedBlock(fixture.blocks[2]);
  const row = b.changes.find(c => c.kind === "recordUpsert")!;
  if (row.kind !== "recordUpsert") throw new Error("fixture");
  expect(row.attributes.find(a => a.name === "quantity")?.value).toBe(u256Max);
  expect(row.attributes.find(a => a.name === "price")?.value).toBe("-12.34567890123456789");
  expect(row.fields.find(a => a.name === "$payload")).toEqual({ name: "$payload", type: "bytes", byteLength: "64", digest: "0xee0897942c5146d369cba980329fdc147f024d169ae3a7343d3136eb9c7eef29", reference: null });
  expect(() => parseAttribute({ name: "$payload", type: "str", value: "SECRET" })).toThrow();
  expect(() => parseAttribute({ name: "$creationFlags", type: "u64", value: "1" })).toThrow();
  for (const name of ["payload", "value", "canonicalBytes", "proofBytes"]) {
    const changed = structuredClone(fixture.blocks[2]!);
    const change = changed.changes[0]!;
    if (!("fields" in change)) throw new Error("fixture");
    Object.assign(change.fields[0]!, { [name]: "SECRET" });
    expect(() => parseFeedBlock(resign(changed))).toThrow();
  }
});
test("profile and protocol versions reject mixed or unknown capabilities", () => {
  for (const patch of [{ protocolVersion: 2 }, { projectionVersion: 1 }, { blockFormatVersion: 1 }, { proofProfiles: ["eq-page-v1"] }, { capabilities: { ...fixture.status.capabilities, signatures: true } }, { capabilities: { ...fixture.status.capabilities, payload: "SECRET" } }])
    expect(() => parseStatus({ ...fixture.status, ...patch })).toThrow();
});
test("new scalar types enforce exact integer, fixed decimal, byte width and UTF8 bounds", () => {
  const attr = (type: string, value: unknown, name = "a") => parseAttribute({ name, type, value });
  expect(attr("i32", "-2147483648").value).toBe("-2147483648");
  expect(attr("u256", u256Max).value).toBe(u256Max);
  for (const n of [-(1n << 255n), (1n << 255n) - 1n]) {
    const abs = n < 0n ? -n : n;
    const value = `${n < 0n ? "-" : ""}${abs / 10n ** 18n}.${(abs % 10n ** 18n).toString().padStart(18, "0")}`;
    expect(attr("dec", value).value).toBe(value);
  }
  for (const [type, value] of [["i32", "2147483648"], ["i32", "-2147483649"], ["u256", (1n << 256n).toString()], ["u256", "-1"], ["u256", 12], ["dec", "1e5"], ["dec", "0.0000000000000000001"], ["dec", "-0"], ["dec", "-0.0"], ["dec", u256Max], ["addr", "0x" + "ab".repeat(19)], ["key", "0x01"], ["bytes32", "0x" + "ab".repeat(33)]])
    expect(() => attr(type as string, value)).toThrow();
  expect(attr("str", "é".repeat(64), "n".repeat(32)).value).toBe("é".repeat(64));
  expect(() => attr("str", "é".repeat(65))).toThrow();
  expect(() => attr("str", "ok", "n".repeat(33))).toThrow();
  expect(() => attr("str", "ok", "é")).toThrow();
  expect(() => parseAttribute({ name: "a", type: "u256", value: "1" }, 2)).toThrow();
});
test("numeric ranges and binary scalar equality use exact parameterized SQL", () => {
  for (const type of ["i32", "u256", "dec"]) {
    const args = new SqlArgs();
    const sql = predicateSql(parsePredicate({ op: "gte", attribute: { name: "a", type, value: type === "dec" ? "1.25" : "1" } }), '"sim"', args);
    expect(sql).toContain("a.value_num>=");
    expect(args.values.at(-1)).toBe(type === "dec" ? "1.25" : "1");
  }
  const args = new SqlArgs();
  expect(predicateSql(parsePredicate({ op: "eq", attribute: { name: "$owner", type: "addr", value: "0x" + "ab".repeat(20) } }), '"sim"', args)).toContain("a.value_bytes=");
  expect(args.values.at(-1)).toEqual(Buffer.alloc(20, 0xab));
  expect(() => parsePredicate({ op: "lt", attribute: { name: "a", type: "addr", value: "0x" + "ab".repeat(20) } })).toThrow("UnsupportedQuery");
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Arkiv v2 PostgreSQL projection", () => {
  test("widens old schema and indexes complete live fixture with exact scalar queries, history and no payload", async () => {
    const schema = "sim_v2_" + randomUUID().replaceAll("-", "");
    const id = parseFeedBlock(fixture.blocks[0]);
    let store = await SimulatorStorage.open(url!, id, schema);
    const db = openDb(url!);
    try {
      // Emulate a previously initialized legacy metadata schema; startup must widen it.
      await store.db.query(`ALTER TABLE "${schema}".record_attributes ALTER COLUMN value_num TYPE numeric(20,0)`);
      await store.close();
      store = await SimulatorStorage.open(url!, id, schema);
      await store.observe(parseStatus(fixture.status));
      for (const block of fixture.blocks) await store.ingest(block);
      expect((await store.progress()).height).toBe("14");
      for (const [type, name, value, op] of [["u256", "quantity", u256Max, "eq"], ["dec", "price", "-12.34567890123456789", "eq"], ["dec", "price", "-12", "lt"], ["i32", "counter", "-2147483648", "eq"], ["addr", "$owner", "0x" + "a1".repeat(20), "eq"], ["bytes32", "checksum", "0x" + "42".repeat(32), "eq"], ["key", "reference", "0x" + "77".repeat(32), "eq"]]) {
        const result = await store.page("records", { namespaceId: "1", atHeight: "2", predicate: parsePredicate({ op, attribute: { name, type, value } }) });
        expect(result.rows.length).toBe(5);
      }
      const values = (await db.query<{ value_num: string }>(`SELECT value_num::text FROM "${schema}".record_attributes WHERE name=$1 ORDER BY from_height LIMIT 1`, [Buffer.from("quantity")])).rows;
      expect(values[0]!.value_num).toBe(u256Max);
      const metadata = JSON.stringify((await store.page("records", { namespaceId: "1", atHeight: "2" })).rows);
      expect(metadata).toContain('"name":"$payload"');
      expect(metadata).not.toContain('"payload":');
      expect(metadata).not.toContain('"proofBytes":');
    } finally {
      await store.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  });
});
