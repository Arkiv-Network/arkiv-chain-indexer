import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OmniSearch, SearchBusyError, SearchInputError, hexPrefixBounds, parseSearchInput, textPrefixUpper } from "./omniSearch";
import { openDb, type Db } from "./db";
import { EntityIndexStorage } from "./entityIndexStorage";
import { handleRequest } from "./server";
import type { ScannerStorage } from "./storage";
import { closeTestPools, createIsolatedStorage, hasPostgresForTests, TEST_DATABASE_URL } from "./testPostgres";
import { routeTemplate } from "./serverMetrics";
import type { BlockMetrics } from "./types";

const input = (q: string, suggest = false, limit = 8) => parseSearchInput(new URLSearchParams({ q, limit: String(limit) }), suggest);
const hash = (value: string) => `0x${value.padEnd(64, "0")}`;
const address = (value: string) => `0x${value.padEnd(40, "0")}`;

describe("omni search input", () => {
  test("parses literal values, prefixes and quotes without wildcard or SQL interpretation", () => {
    expect(input("status=active").attribute).toEqual({ key: "status", value: "active", prefix: false });
    expect(input(" name = Alice* ").attribute).toEqual({ key: "name", value: "Alice", prefix: true });
    expect(input('name="Alice*"').attribute).toEqual({ key: "name", value: "Alice*", prefix: false });
    expect(() => input('name="Alice\\n"')).toThrow(SearchInputError);
  });
  test("rejects malformed, oversized and payload queries", () => {
    for (const q of ["x".repeat(257), "a\0b", "=x", "$payload=x", 'name="unfinished', 'name="a\\u0000b"']) {
      expect(() => input(q)).toThrow(SearchInputError);
    }
    for (const limit of ["0", "31", "-1", "1.5", "NaN"]) {
      expect(() => parseSearchInput(new URLSearchParams({ q: "hello", limit }))).toThrow(SearchInputError);
    }
  });
  test("allows incomplete typeahead and normalizes fixed-width hex bounds", () => {
    expect(input('name="Al', true).attribute).toEqual({ key: "name", value: "Al", prefix: true });
    expect(input("name=", true).attribute).toEqual({ key: "name", value: "", prefix: true });
    expect(hexPrefixBounds("0XABCDEF", 40)).toEqual([address("abcdef"), `0xabcdef${"f".repeat(34)}`]);
    expect(hexPrefixBounds("abcde", 40)).toBeNull();
    expect(hexPrefixBounds(hash("abc"), 40)).toBeNull();
    expect(textPrefixUpper("a%_\\")).toBe("a%_]");
    expect(textPrefixUpper("é")).toBe("ê");
    expect(textPrefixUpper("a\u{10ffff}")).toBe("b");
    expect(textPrefixUpper("")).toBeNull();
  });
});

describe("omni HTTP route", () => {
  test("validates input, honours feature gate, and records bounded route labels", async () => {
    const seen: boolean[] = [];
    const fake = new OmniSearch({ transaction: async () => { throw new Error("Unexpected database access"); } } as unknown as Db);
    const search = { search: async (query: ReturnType<typeof input>, enabled: boolean) => { seen.push(enabled); return fake.search(query, enabled); } };
    const response = await handleRequest(new Request("http://localhost/search?q="), {} as ScannerStorage, { search, transactionDataEnabled: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(seen).toEqual([false]);
    expect((await response.json()).results).toEqual([]);
    expect((await handleRequest(new Request("http://localhost/search?limit=999"), {} as ScannerStorage, { search })).status).toBe(400);
    expect((await handleRequest(new Request("http://localhost/search"), {} as ScannerStorage)).status).toBe(503);
    expect((await handleRequest(new Request("http://localhost/search", { method: "POST" }), {} as ScannerStorage, { search })).status).toBe(405);
    const busy = await handleRequest(new Request("http://localhost/search"), {} as ScannerStorage, { search: { search: async () => { throw new SearchBusyError("busy"); } } });
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("1");
    expect(routeTemplate("/search/suggest")).toBe("/search/suggest");
    expect(routeTemplate("/search")).toBe("/search");
  });

  test("coalesces equal requests, caps distinct in-flight requests, and reports timeouts", async () => {
    const releases: Array<() => void> = [];
    const db = { transaction: async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      throw Object.assign(new Error("query cancelled"), { code: "57014" });
    } } as unknown as Db;
    const search = new OmniSearch(db);
    const first = search.search(input("1"), false);
    const equal = search.search(input("1"), false);
    const second = search.search(input("2"), false);
    await expect(search.search(input("3"), false)).rejects.toBeInstanceOf(SearchBusyError);
    expect(releases.length).toBe(2);
    releases.forEach((release) => release());
    expect((await first).partial).toBe(true);
    expect(await equal).toEqual(await first);
    expect((await second).notes.join(" ")).toContain("incomplete");
  });
});

describe.skipIf(!hasPostgresForTests())("omni search (Postgres)", () => {
  let db: Db;
  let schema: string;
  let cleanup: () => Promise<void>;
  let storage: ScannerStorage;
  let search: OmniSearch;
  let entity: EntityIndexStorage;
  beforeAll(async () => {
    ({ storage, schema, cleanup } = await createIsolatedStorage("search"));
    db = openDb(TEST_DATABASE_URL!, { max: 2 });
    entity = await EntityIndexStorage.fromDb(db, { schema });
    await entity.setProgress({ floorBlock: 1n, projectedThroughBlock: 10000n });
    search = new OmniSearch(db, true, schema);
    await storage.saveBlockMetrics(metrics(), { kind: "none" });
    await storage.saveBlockMetrics({ ...metrics(), blockNumber: 0n, blockHash: hash("123456") }, { kind: "none" });
    // Strongly skewed: 12k transactions/operations for one address/entity.
    // A DISTINCT implementation would repeatedly read the whole run.
    await db.query(`INSERT INTO "${schema}".transactions
      (block_number, block_date, base_block_fee_wei, position, hash, from_address, to_address, value_wei, gas_limit, gas_used, effective_gas_price_wei, priority_fee_wei, transaction_fee_wei)
      SELECT n, '2026-09-09', '1', 0, '0x'||lpad(to_hex(n),64,'0'), $1, $2, '0', '1', '1', '1', '0', '1' FROM generate_series(1,12000) n`, [address("aaaaaa"), address("bbbbbb")]);
    await db.query(`INSERT INTO "${schema}".transaction_operations
      (block_number, position, op_index, hash, block_date, operation_type, operation, entity_key, content_type, attributes)
      SELECT n, 0, 0, '0x'||lpad(to_hex(n),64,'0'), '2026-09-09', 1, 'create', $1, 'application/json',
        '[{"key":"name","valueType":8,"value":"Alice Smith"},{"key":"count","valueType":3,"value":"18446744073709551615"}]'::jsonb
      FROM generate_series(1,12000) n`, [hash("cccccc")]);
    await db.query(`UPDATE "${schema}".transactions SET from_address=$1 WHERE block_number=12000`, [address("aaaaaa1")]);
    await db.query(`UPDATE "${schema}".transaction_operations SET entity_key=$1 WHERE block_number=12000`, [hash("cccccc1")]);
    await db.query(`UPDATE "${schema}".transaction_operations SET attributes='[{"key":"ancient","valueType":8,"value":"historicalOnly"}]'::jsonb WHERE block_number=1`);
    await db.query(`INSERT INTO "${schema}".account_balances VALUES (12000,'2026-09-09',$1,'42')`, [address("dddddd")]);
    await db.query(`INSERT INTO "${schema}".entity_versions
      (entity_key,version,from_block,from_position,from_op_index,owner,creator,created_at,created_position,created_op_index,updated_at,expires_at)
      VALUES ($1,0,1,0,0,$2,$3,1,0,0,1,10)`, [hash("ededed"), address("ededed"), address("fafafa")]);
    await db.query(`INSERT INTO "${schema}".transaction_logs (block_number,position,log_index,hash,address,topic0,data) VALUES (12000,0,0,$1,$2,$3,'0x')`, [hash("eeeeee"), address("bbbbbb"), hash("ffffff")]);
    await db.query(`INSERT INTO "${schema}".entity_version_attributes (entity_key,version,name,type_id,value_text,current)
      SELECT '0x'||lpad(to_hex(n),64,'0'),0,'status',8,'active',true FROM generate_series(1,12000) n`);
    for (const [n, name, type, value, current] of [
      [20000, "status", 8, "active-two", true], [20001, "status", 8, "Active", true],
      [20002, "status", 8, "obsolete", false], [20003, "count", 3, "18446744073709551615", true],
      [20004, "literal", 8, "%_back\\slash", true], [20005, "literal", 8, "other", true],
      [20006, "unicode", 8, "éclair", true], [20007, "unicode", 8, "écouter", true],
    ]) await db.query(`INSERT INTO "${schema}".entity_version_attributes (entity_key,version,name,type_id,value_text,current) VALUES ($1,0,$2,$3,$4,$5)`, [hash(String(n)), name, type, value, current]);
    for (const table of ["transactions", "transaction_operations", "entity_version_attributes"]) await db.query(`ANALYZE "${schema}".${table}`);
  });
  afterAll(async () => { await entity?.close(); await db?.close(); await cleanup?.(); await closeTestPools(); });

  test("looks up blocks without lossy JS integer conversions", async () => {
    const result = await search.search(input("9007199254740993"), false);
    expect(result.results[0]?.label).toBe("Block 9007199254740993");
    expect(result.results[0]?.href).toContain("9007199254740992");
    expect((await search.search(input("0"), false)).results[0]?.href).toBe("/blocks?blockLt=1");
  });
  test("hex prefixes find distinct identifiers, even with heavily repeated accounts", async () => {
    const senders = await search.search(input("0xAAAAAA", true), true);
    expect(senders.results.filter((r) => r.kind === "address").map((r) => r.label)).toEqual([address("aaaaaa"), address("aaaaaa1")]);
    const keys = await search.search(input("cccccc", true), true);
    expect(keys.results.filter((r) => r.kind === "entity").map((r) => r.label)).toEqual([hash("cccccc"), hash("cccccc1")]);
    const balance = await search.search(input(address("dddddd")), true);
    expect(balance.results.some((r) => r.detail === "Balance address")).toBe(true);
    const tx = await search.search(input(`0x${(12000).toString(16).padStart(64, "0")}`), true);
    expect(tx.results.some((r) => r.kind === "transaction")).toBe(true);
    expect((await search.search(input(address("ededed")), true)).results.some((r) => r.kind === "address")).toBe(true);
    expect((await search.search(input(hash("ededed")), true)).results.some((r) => r.kind === "entity")).toBe(true);
    expect((await search.search(input(address("fafafa")), true)).results.some((r) => r.detail === "Entity creator address")).toBe(true);
  });
  test("scoped values use current attributes and distinguish literal case and typed large numbers", async () => {
    const active = await search.search(input("status=active"), true);
    expect(active.coverage.attributeHead).toBe("10000");
    expect(active.results.length).toBe(8);
    expect(active.truncated).toBe(true);
    expect(active.results.every((r) => r.label === "status=active")).toBe(true);
    expect((await search.search(input("status=obsolete"), true)).results).toEqual([]);
    expect((await search.search(input("status=Active"), true)).results[0]?.label).toBe("status=Active");
    expect((await search.search(input("count=18446744073709551615"), true)).results[0]?.scope).toBe("indexed");
  });
  test("value suggestions skip duplicate runs and escape literal pattern characters", async () => {
    const suggestions = await search.search(input("status=act", true), true);
    expect(suggestions.partial).toBe(false);
    expect(suggestions.suggestions.map((s) => s.label)).toEqual(["status=active", "status=active-two"]);
    expect((await search.search(input("literal=%_*"), true)).results[0]?.label).toBe("literal=%_back\\slash");
    const unicode = await search.search(input("unicode=é*"), true);
    expect(unicode.results.length).toBe(2);
    expect(await search.search(input("unicode=é*"), true)).toEqual(unicode);
  });
  test("general text is bounded and advertises recent coverage", async () => {
    const recent = await search.search(input("Alice Smith"), true);
    expect(recent.coverage.recentOperations).toBe(64);
    expect(recent.results.every((r) => r.scope === "recent")).toBe(true);
    expect(recent.truncated).toBe(true);
    expect((await search.search(input("historicalOnly"), true)).results).toEqual([]);
    expect((await search.search(input("na", true), true)).suggestions[0]?.query).toBe("name=");
    const log = await search.search(input(hash("ffffff")), true);
    expect(log.results.some((r) => r.kind === "log")).toBe(true);
  });
  test("disabled transaction data never exposes metadata or attributes", async () => {
    const result = await search.search(input("status=active"), false);
    expect(result.coverage.attributeIndex).toBe(false);
    expect(result.results).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });
  test("concurrent cache misses complete without nested-pool deadlocks", async () => {
    const fresh = new OmniSearch(db, true, schema);
    const responses = await Promise.all([fresh.search(input("Alice"), true), fresh.search(input("Smith"), true)]);
    expect(responses.every((r) => r.results.length > 0 && !r.partial)).toBe(true);
  });
  test("search makes no schema changes and leading attribute predicates are index conditions", async () => {
    const plan = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN SELECT entity_key FROM "${schema}".entity_version_attributes WHERE current AND name='literal' AND type_id=8 AND value_text ~>=~ '%' AND value_text ~<~ '&' LIMIT 9`);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/entity_version_attributes_(live_)?text_idx/);
    expect(text).toContain("Index Cond:");
    expect(text).not.toContain("Seq Scan");
    const tables = await db.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 AND tablename LIKE '%search%'", [schema]);
    expect(tables.rows).toEqual([]);
  });
});

function metrics(): BlockMetrics {
  return { blockNumber: 9007199254740993n, blockHash: hash("abcdef"), blockDate: "2026-09-09", blockTimeSeconds: "2",
    baseBlockFeeWei: "1", totalGasUsed: "1", totalInputDataSizeBytes: "0", totalInputDataCompressedSizeBytes: "0",
    maxGasInBlock: "100", transactionCount: 1, blockRewardWei: "0", burntFeesWei: "0", totalTransactionFeeWei: "0",
    feePriceSumWei: "0", priorityFeeSumWei: "0", priorityFeeWeightedNumeratorWei: "0", priorityFeeGasWeightedNumeratorWei: "0",
    averageFeePriceWei: "0", averageTransactionFeeWei: "0", averageTransactionGasUsed: "0", averageTransactionInputDataSizeBytes: "0",
    averageTransactionInputDataCompressedSizeBytes: "0", averagePriorityFeeWeightedWei: "0", averagePriorityFeeWei: "0" };
}
