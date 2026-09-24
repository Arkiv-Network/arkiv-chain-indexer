import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatisticsConfig } from "./collectStatistics";
import { openDb, type Db } from "./db";
import { EntityIndexStorage } from "./entityIndexStorage";
import type { EntityVersion } from "./entityIndex";
import { gatherIndexerStatistics, scannedPercent } from "./indexerStatistics";
import { STATISTICS_PERIODS, type IndexerStatistics } from "./indexerStatisticsTypes";
import { foldStatisticsActivity, foldStatisticsWindows, statisticsWindowBounds } from "./statisticsWindows";
import { StatisticsFileReader, writeStatisticsFile } from "./statisticsFile";
import { createBlockServer } from "./server";
import type { ScannerStorage } from "./storage";
import { closeTestPools, createIsolatedStorage, hasPostgresForTests, TEST_DATABASE_URL } from "./testPostgres";
import { computeBlockMetrics } from "./metrics";
import { inspectBlockFromRpc } from "./blockInspector";
import type { ArkivOperation, TransactionArkivOperations } from "./arkivOperations";
import type { RpcBlock, RpcReceipt } from "./types";

describe("statistics coverage and worker config", () => {
  test("excludes ten tip blocks, preserves older gaps and handles short chains and large counts", () => {
    expect(scannedPercent("1", "10")).toBe(100);
    expect(scannedPercent("0", "10")).toBe(0);
    expect(scannedPercent("3", "19")).toBe(30);
    expect(scannedPercent("0", "0")).toBeNull();
    expect(scannedPercent("0", "9")).toBeNull();
    expect(scannedPercent("0", null)).toBeNull();
    expect(scannedPercent("9007199254740992", "9007199254741002")).toBe(99.9999);
  });
  test("validates timing and supports one-shot output", () => {
    const config = parseStatisticsConfig(["--once", "--output", "/tmp/test-stats.json"], { DATABASE_URL: "postgres://test" });
    expect(config).toMatchObject({ intervalMs: 300_000, once: true, output: "/tmp/test-stats.json" });
    expect(() => parseStatisticsConfig([], {})).toThrow("DATABASE_URL");
    expect(() => parseStatisticsConfig(["--interval-ms", "0"], { DATABASE_URL: "postgres://test" })).toThrow();
    expect(() => parseStatisticsConfig(["--statement-timeout-ms", "-1"], { DATABASE_URL: "postgres://test" })).toThrow();
  });
  test("window durations use exact UTC hours across DST and zero stored activity stays distinct from unavailable state", () => {
    const cutoff = "2026-10-25T03:00:00.123Z";
    const bounds = statisticsWindowBounds(cutoff);
    expect(bounds[0]).toEqual({ fromInclusiveUtc: "2026-10-25T02:00:00.123Z", toExclusiveUtc: cutoff });
    expect(bounds[7]).toEqual({ fromInclusiveUtc: "2026-10-18T03:00:00.123Z", toExclusiveUtc: cutoff });
    expect(bounds[8]).toEqual({ fromInclusiveUtc: null, toExclusiveUtc: null });
    const allTime = foldStatisticsActivity([], [], []);
    const windows = foldStatisticsWindows(cutoff, [], [], [], allTime);
    expect(Object.keys(windows)).toEqual(["1h", "2h", "6h", "12h", "24h", "48h", "72h", "7d", "all"]);
    for (const window of Object.values(windows)) {
      expect(window.blocks.indexed).toBe("0");
      expect(window.transactions.maxInputBytes).toBe("0");
      expect(window.operations.byType).toHaveLength(6);
      expect(window.operations.byType.every((row) => row.successful === "0" && row.reverted === "0" && row.unknownStatus === "0")).toBe(true);
      expect("entities" in window).toBe(false);
    }
  });
});

function fileFixture(): IndexerStatistics {
  return {
    version: 1, gatheredAtUtc: "2026-09-21T10:00:00.000Z", completedAtUtc: "2026-09-21T10:00:00.100Z",
    durationMs: 100, refreshIntervalMs: 300_000,
    chain: { id: null, observedHead: null, observedAtUtc: null, headObservationAgeSeconds: null, headObservationStale: true, blocksThroughObservedHead: null, indexedBlocksThroughObservedHead: null, coverageThroughBlock: null, coverageBlocks: null, indexedCoverageBlocks: null, scannedPercent: null },
    blocks: { indexed: "9007199254740993", first: "0", last: null, missingWithinStoredRange: "0", transactions: "0", inputBytes: "0", compressedInputBytes: "0" },
    transactions: { indexed: "0", withInput: "0", inputBytes: "0", compressedInputBytes: "0", maxInputBytes: "0" },
    operations: { byType: [], successfulCreatesWithoutKey: "0", successfulPayloadWrites: "0", successfulPayloadBytes: "0", successfulReferenceWrites: "0", referencedPayloadBytes: "0", referencesWithoutSize: "0" },
    entities: { status: "unavailable", floorBlock: null, asOfBlock: null, lagBehindObservedHead: null, lastFoldAtUtc: null, genesisStatus: null, known: null, active: null, expired: null, deleted: null, activeWithPayload: null, activeRecordedPayloadBytes: null, maxActiveRecordedPayloadBytes: null, activeAttributes: null, activeWithAttributes: null, maxAttributesPerActiveEntity: null, attributeTypes: [], topContentTypes: [] },
    limitations: [],
  };
}

test("serves worker snapshots through the real HTTP server without accessing storage, retains stale snapshots on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "indexer-statistics-"));
  const path = join(directory, "snapshot.json");
  const fixture = fileFixture();
  let now = Date.parse(fixture.gatheredAtUtc) + 100;
  const reader = new StatisticsFileReader(path, () => now);
  const storage = new Proxy({} as ScannerStorage, { get() { throw new Error("Statistics must never access scanner storage"); } });
  const server = createBlockServer(storage, { hostname: "127.0.0.1", statisticsProvider: reader });
  try {
    const unavailable = await fetch(`http://127.0.0.1:${server.port}/statistics`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("Retry-After")).toBe("30");
    await writeStatisticsFile(path, fixture);
    now += 1100;
    const response = await fetch(`http://127.0.0.1:${server.port}/statistics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toMatchObject({ blocks: { indexed: "9007199254740993" }, stale: false });
    // A rolling upgrade must serve old files unchanged, then expose windows without touching storage.
    fixture.windows = foldStatisticsWindows(fixture.gatheredAtUtc, [], [], [], fixture);
    await writeStatisticsFile(path, fixture);
    now += 1100;
    const windowResponse = await fetch(`http://127.0.0.1:${server.port}/statistics`);
    expect(await windowResponse.json()).toMatchObject({ windows: {
      "1h": { fromInclusiveUtc: "2026-09-21T09:00:00.000Z", toExclusiveUtc: fixture.gatheredAtUtc, blocks: { indexed: "0" } },
      all: { fromInclusiveUtc: null, toExclusiveUtc: null, blocks: fixture.blocks },
    } });
    await writeFile(path, "invalid JSON");
    now += 601_000;
    expect(await reader.get()).toMatchObject({ blocks: fixture.blocks, stale: true });
    await rm(path);
    now += 1100;
    expect((await reader.get())?.stale).toBe(true);
    await writeStatisticsFile(path, { ...fixture, gatheredAtUtc: new Date(now).toISOString() });
    now += 1100;
    expect((await reader.get())?.stale).toBe(false);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(closeTestPools);
describe.skipIf(!hasPostgresForTests())("statistics PostgreSQL snapshot", () => {
  test("empty DB has unknown coverage and entity totals; gathering creates no tables", async () => {
    const { schema, cleanup } = await createIsolatedStorage("statistics_empty");
    const db = openDb(TEST_DATABASE_URL!, { max: 1 });
    try {
      const tables = () => db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [schema]);
      const before = await tables();
      const stats = await gatherIndexerStatistics(db, { schema });
      expect(stats.chain.scannedPercent).toBeNull();
      expect(stats.blocks.indexed).toBe("0");
      expect(stats.transactions.indexed).toBe("0");
      expect(stats.entities).toMatchObject({ status: "unavailable", known: null, active: null });
      expect(stats.windows?.["1h"].blocks.indexed).toBe("0");
      expect(stats.windows?.all.operations).toEqual(stats.operations);
      expect((await tables()).rows).toEqual(before.rows);
    } finally { await db.close(); await cleanup(); }
  });

  test("all eight windows have inclusive starts/exclusive shared cutoff, nest exactly, and preserve all-time and orphan operations", async () => {
    const { storage, schema, cleanup } = await createIsolatedStorage("statistics_windows");
    const db = openDb(TEST_DATABASE_URL!, { max: 1 });
    const cutoff = "2026-09-24T12:00:00.123Z";
    const cutoffMs = Date.parse(cutoff);
    const offsets = [
      ...STATISTICS_PERIODS.flatMap(({ hours }) => hours === null ? [] : [-hours * 3_600_000 - 1, -hours * 3_600_000, -hours * 3_600_000 + 1]),
      -1, 0, 1, 3_600_000, -8 * 86_400_000,
    ];
    const fixtures = offsets.map((offset, i) => ({
      date: new Date(cutoffMs + offset).toISOString(),
      // The most recent operation deliberately has no transaction row.
      status: i === 24 || i % 3 === 2 ? null : i % 3 === 0 ? "1" : "0",
      orphan: i === 24,
      inputBytes: i === 24 ? "9007199254740993" : String(i + 1),
      reference: i % 2 === 0,
      referenceSize: i === 0 ? null : "9007199254740993",
      type: i === 23 ? 99 : 2,
    }));
    const historyQueries: string[] = [];
    // Keep the real read-only transaction and queries, but give boundary fixtures a deterministic cutoff.
    const fixedClockDb: Db = { ...db, transaction: (fn) => db.transaction((tx) => fn({
      query: async <R>(sql: string, params?: unknown[]) => {
        if (sql.includes("transaction_timestamp()")) return { rows: [{ at: cutoff }] as R[], rowCount: 1 };
        if (sql.includes(`FROM "${schema}".blocks`) || sql.includes(`FROM "${schema}".transactions`) || sql.includes(`FROM "${schema}".transaction_operations`)) historyQueries.push(sql);
        return tx.query<R>(sql, params);
      },
    })) };
    try {
      for (const [i, fixture] of fixtures.entries()) {
        const hash = `0x${(i + 1).toString(16).padStart(64, "0")}` as const;
        const block: RpcBlock = {
          number: `0x${i.toString(16)}`, timestamp: "0x1", gasUsed: "0x1", gasLimit: "0x100000",
          transactions: [{ hash, from: "0xaa", to: "0xbb", input: "0xab" }],
        };
        const receipt: RpcReceipt = { transactionHash: hash, gasUsed: "0x1", ...(fixture.status === null ? {} : { status: fixture.status === "1" ? "0x1" as const : "0x0" as const }) };
        const metrics = computeBlockMetrics(block, [receipt]);
        metrics.blockDate = fixture.date;
        metrics.totalInputDataSizeBytes = fixture.inputBytes;
        const transactions = inspectBlockFromRpc(block, [receipt]).transactions;
        transactions[0]!.inputDataSizeBytes = fixture.inputBytes;
        const operation: ArkivOperation = {
          opIndex: 0, operationType: fixture.type, operation: "update", entityKey: "same-entity",
          contentType: "text/plain", payloadSizeBytes: 7, attributes: [], expiresAtBlocks: 10,
          newOwner: null, isReference: fixture.reference, payloadReference: null,
          referenceVerification: null, referenceError: null,
        };
        await storage.saveBlockMetrics(metrics, { kind: "lastSuccessfulBlock" }, transactions, [], [{ position: 0, hash, operations: [operation] }]);
        if (fixture.referenceSize !== null) await db.query(`UPDATE "${schema}".transaction_operations SET payload_reference = $1::jsonb WHERE block_number = $2`, [{ sizeBytes: fixture.referenceSize }, i]);
        if (fixture.orphan) await db.query(`DELETE FROM "${schema}".transactions WHERE block_number = $1`, [i]);
      }
      const stats = await gatherIndexerStatistics(fixedClockDb, { schema });
      expect(stats.gatheredAtUtc).toBe(cutoff);
      expect(historyQueries).toHaveLength(3);
      expect(stats.blocks).toMatchObject({ indexed: String(fixtures.length), first: "0", last: String(fixtures.length - 1), missingWithinStoredRange: "0" });
      expect(stats.windows!.all.blocks).toMatchObject({ indexed: stats.blocks.indexed, inputBytes: stats.blocks.inputBytes });
      expect(stats.windows!.all.transactions).toEqual(stats.transactions);
      expect(stats.windows!.all.operations).toEqual(stats.operations);
      let previousCount = 0n;
      for (const { id, hours } of STATISTICS_PERIODS) {
        const selected = fixtures.filter(({ date }) => hours === null || (Date.parse(date) >= cutoffMs - hours * 3_600_000 && Date.parse(date) < cutoffMs));
        const window = stats.windows![id];
        const successful = selected.filter((row) => row.status === "1");
        const sum = (rows: typeof selected, key: "inputBytes" | "referenceSize") => rows.reduce((total, row) => total + BigInt(row[key] ?? "0"), 0n).toString();
        expect(window.blocks).toMatchObject({ indexed: String(selected.length), transactions: String(selected.length), inputBytes: sum(selected, "inputBytes") });
        expect(window.transactions).toMatchObject({ indexed: String(selected.filter((row) => !row.orphan).length), inputBytes: sum(selected.filter((row) => !row.orphan), "inputBytes") });
        expect(window.operations).toMatchObject({
          successfulPayloadWrites: String(successful.length), successfulPayloadBytes: String(successful.length * 7),
          successfulReferenceWrites: String(successful.filter((row) => row.reference).length),
          referencedPayloadBytes: sum(successful.filter((row) => row.reference), "referenceSize"),
          referencesWithoutSize: String(successful.filter((row) => row.reference && row.referenceSize === null).length),
        });
        for (const type of [2, 99]) {
          const rows = selected.filter((row) => row.type === type);
          const actual = window.operations.byType.find((row) => row.type === type);
          if (rows.length || type === 2) expect(actual).toMatchObject({
            successful: String(rows.filter((row) => row.status === "1").length),
            reverted: String(rows.filter((row) => row.status === "0").length),
            unknownStatus: String(rows.filter((row) => row.status === null).length),
          });
        }
        expect(BigInt(window.blocks.indexed)).toBeGreaterThanOrEqual(previousCount);
        previousCount = BigInt(window.blocks.indexed);
        expect(window.toExclusiveUtc).toBe(hours === null ? null : cutoff);
        expect("entities" in window).toBe(false);
      }
      expect(stats.windows!["1h"].blocks.indexed).toBe("3"); // exact lower bound, 1 ms later, 1 ms before cutoff
      expect(stats.windows!["7d"].blocks.indexed).toBe("24");
      expect(stats.entities.active).toBeNull();
    } finally { await db.close(); await cleanup(); }
  });

  test("counts gaps, receipt outcomes, payload bytes and active version state without double counting history", async () => {
    const { storage, schema, cleanup } = await createIsolatedStorage("statistics_counts");
    const db = openDb(TEST_DATABASE_URL!, { max: 1 });
    const index = await EntityIndexStorage.open(TEST_DATABASE_URL!, { schema });
    const baseVersion: EntityVersion = {
      entityKey: "a", version: 0, fromBlock: 0, fromPosition: 0, fromOpIndex: 0, toBlock: null,
      deleted: false, owner: "alice", creator: "alice", createdAt: 0, createdPosition: 0, createdOpIndex: 0,
      updatedAt: 0, expiresAt: 100n, creationFlags: null, contentType: "text/plain", payloadSize: 10,
      attributes: [{ name: "name", typeId: 8, valueText: "a", valueNum: null }],
    };
    try {
      for (const height of [0, 2, 19, 25]) {
        const block: RpcBlock = { number: `0x${height.toString(16)}`, timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x100000", transactions: [] };
        const receipts: RpcReceipt[] = [];
        const ops: TransactionArkivOperations[] = [];
        if (height === 2) {
          for (let i = 0; i < 4; i++) {
            const hash = `0x${(i + 1).toString(16).padStart(64, "0")}` as const;
            block.transactions.push({ hash, from: "0xaa", to: "0xbb", input: "0xabcdef" });
            receipts.push({ transactionHash: hash, gasUsed: "0x1", ...(i < 3 ? { status: i === 2 ? "0x0" as const : "0x1" as const } : {}) });
            const op: ArkivOperation = {
              opIndex: 0, operationType: i === 0 ? 1 : 2, operation: i === 0 ? "create" : "update",
              entityKey: i === 0 ? null : "a", contentType: "text/plain", payloadSizeBytes: 7,
              attributes: [], expiresAtBlocks: 10, newOwner: null, isReference: i === 1,
              payloadReference: null, referenceVerification: null, referenceError: null,
            };
            ops.push({ position: i, hash, operations: [op] });
          }
        }
        const metrics = computeBlockMetrics(block, receipts);
        if (height === 25) metrics.totalInputDataSizeBytes = "9007199254740993";
        await storage.saveBlockMetrics(metrics, { kind: "lastSuccessfulBlock" }, inspectBlockFromRpc(block, receipts).transactions, [], ops);
      }
      await storage.saveChainProgress(20n, 20n, new Date(Date.now() - 120_000));
      await storage.saveChainId(123n);
      await db.query(`UPDATE "${schema}".transaction_operations SET payload_reference = $1::jsonb WHERE position = 1`, [{ sizeBytes: "9007199254740993" }]);
      await index.insertGenesisVersions([
        { ...baseVersion, toBlock: 10, payloadSize: 9999 },
        { ...baseVersion, version: 1, fromBlock: 10, toBlock: 30, payloadSize: 20 },
        { ...baseVersion, version: 2, fromBlock: 30, payloadSize: 8888 },
        { ...baseVersion, entityKey: "b", expiresAt: 20n },
        { ...baseVersion, entityKey: "c", deleted: true },
        { ...baseVersion, entityKey: "d", expiresAt: 18446744073709551615n, payloadSize: 0, attributes: [] },
        { ...baseVersion, entityKey: "future", fromBlock: 30 },
      ]);
      await index.setProgress({ floorBlock: 0n, projectedThroughBlock: 20n });
      const stats = await gatherIndexerStatistics(db, { schema });
      expect(stats.chain).toMatchObject({ id: "123", scannedPercent: 18.1818, indexedBlocksThroughObservedHead: "3", coverageThroughBlock: "10", coverageBlocks: "11", indexedCoverageBlocks: "2", headObservationStale: true });
      expect(stats.blocks).toMatchObject({ indexed: "4", missingWithinStoredRange: "22", transactions: "4", inputBytes: "9007199254741005" });
      expect(stats.transactions).toMatchObject({ indexed: "4", inputBytes: "12", withInput: "4", maxInputBytes: "3" });
      expect(stats.operations.byType.find((r) => r.type === 2)).toMatchObject({ successful: "1", reverted: "1", unknownStatus: "1" });
      expect(stats.operations).toMatchObject({ successfulCreatesWithoutKey: "1", successfulPayloadBytes: "14", successfulReferenceWrites: "1", referencedPayloadBytes: "9007199254740993", referencesWithoutSize: "0" });
      expect(stats.entities).toMatchObject({ status: "available", known: "4", active: "2", expired: "1", deleted: "1", activeRecordedPayloadBytes: "20", activeAttributes: "1", maxAttributesPerActiveEntity: "1", activeWithAttributes: "1" });
      expect(stats.entities.attributeTypes).toEqual([{ typeId: 8, name: "str", count: "1" }]);
      expect(stats.entities.topContentTypes).toEqual([{ contentType: "text/plain", entities: "2", recordedPayloadBytes: "20" }]);
      // Filling the older gaps reaches 100% even though nine of the newest ten blocks are absent.
      for (const height of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
        const block: RpcBlock = { number: `0x${height.toString(16)}`, timestamp: "0x1", gasUsed: "0x0", gasLimit: "0x100000", transactions: [] };
        await storage.saveBlockMetrics(computeBlockMetrics(block, []));
      }
      expect((await gatherIndexerStatistics(db, { schema })).chain).toMatchObject({
        scannedPercent: 100, coverageBlocks: "11", indexedCoverageBlocks: "11", indexedBlocksThroughObservedHead: "12",
      });
      await storage.saveChainProgress(9n, 9n);
      expect((await gatherIndexerStatistics(db, { schema })).chain).toMatchObject({
        scannedPercent: null, coverageThroughBlock: null, coverageBlocks: "0", indexedCoverageBlocks: "0",
      });
      await storage.saveChainProgress(20n, 20n);
      // Expiry changes with the projection block, without any new operations.
      await index.setProgress({ projectedThroughBlock: 100n });
      expect((await gatherIndexerStatistics(db, { schema })).entities.active).toBe("1");
      // A partially imported genesis must not look like a complete zero or entity total.
      await db.query(`INSERT INTO "${schema}".entity_index_state (key, value) VALUES ('genesis_import', $1)`, [JSON.stringify({ status: "running" })]);
      expect((await gatherIndexerStatistics(db, { schema })).entities).toMatchObject({ status: "importing", known: null, active: null });
    } finally { await index.close(); await db.close(); await cleanup(); }
  });
});
