import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatisticsConfig } from "./collectStatistics";
import { openDb } from "./db";
import { EntityIndexStorage } from "./entityIndexStorage";
import type { EntityVersion } from "./entityIndex";
import { gatherIndexerStatistics, scannedPercent } from "./indexerStatistics";
import type { IndexerStatistics } from "./indexerStatisticsTypes";
import { StatisticsFileReader, writeStatisticsFile } from "./statisticsFile";
import { createBlockServer } from "./server";
import type { ScannerStorage } from "./storage";
import { closeTestPools, createIsolatedStorage, hasPostgresForTests, TEST_DATABASE_URL } from "./testPostgres";
import { computeBlockMetrics } from "./metrics";
import { inspectBlockFromRpc } from "./blockInspector";
import type { ArkivOperation, TransactionArkivOperations } from "./arkivOperations";
import type { RpcBlock, RpcReceipt } from "./types";

describe("statistics coverage and worker config", () => {
  test("uses row count and includes block zero, with precise large numbers", () => {
    expect(scannedPercent("1", "0")).toBe(100);
    expect(scannedPercent("0", "0")).toBe(0);
    expect(scannedPercent("3", "9")).toBe(30);
    expect(scannedPercent("0", null)).toBeNull();
    expect(scannedPercent("9007199254740992", "9007199254740992")).toBe(99.9999);
  });
  test("validates timing and supports one-shot output", () => {
    const config = parseStatisticsConfig(["--once", "--output", "/tmp/test-stats.json"], { DATABASE_URL: "postgres://test" });
    expect(config).toMatchObject({ intervalMs: 300_000, once: true, output: "/tmp/test-stats.json" });
    expect(() => parseStatisticsConfig([], {})).toThrow("DATABASE_URL");
    expect(() => parseStatisticsConfig(["--interval-ms", "0"], { DATABASE_URL: "postgres://test" })).toThrow();
    expect(() => parseStatisticsConfig(["--statement-timeout-ms", "-1"], { DATABASE_URL: "postgres://test" })).toThrow();
  });
});

function fileFixture(): IndexerStatistics {
  return {
    version: 1, gatheredAtUtc: "2026-09-21T10:00:00.000Z", completedAtUtc: "2026-09-21T10:00:00.100Z",
    durationMs: 100, refreshIntervalMs: 300_000,
    chain: { id: null, observedHead: null, observedAtUtc: null, headObservationAgeSeconds: null, headObservationStale: true, blocksThroughObservedHead: null, indexedBlocksThroughObservedHead: null, scannedPercent: null },
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
      expect((await tables()).rows).toEqual(before.rows);
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
      for (const height of [0, 2, 25]) {
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
      expect(stats.chain).toMatchObject({ id: "123", scannedPercent: 9.5238, indexedBlocksThroughObservedHead: "2", headObservationStale: true });
      expect(stats.blocks).toMatchObject({ indexed: "3", missingWithinStoredRange: "23", transactions: "4", inputBytes: "9007199254741005" });
      expect(stats.transactions).toMatchObject({ indexed: "4", inputBytes: "12", withInput: "4", maxInputBytes: "3" });
      expect(stats.operations.byType.find((r) => r.type === 2)).toMatchObject({ successful: "1", reverted: "1", unknownStatus: "1" });
      expect(stats.operations).toMatchObject({ successfulCreatesWithoutKey: "1", successfulPayloadBytes: "14", successfulReferenceWrites: "1", referencedPayloadBytes: "9007199254740993", referencesWithoutSize: "0" });
      expect(stats.entities).toMatchObject({ status: "available", known: "4", active: "2", expired: "1", deleted: "1", activeRecordedPayloadBytes: "20", activeAttributes: "1", maxAttributesPerActiveEntity: "1", activeWithAttributes: "1" });
      expect(stats.entities.attributeTypes).toEqual([{ typeId: 8, name: "str", count: "1" }]);
      expect(stats.entities.topContentTypes).toEqual([{ contentType: "text/plain", entities: "2", recordedPayloadBytes: "20" }]);
      // Expiry changes with the projection block, without any new operations.
      await index.setProgress({ projectedThroughBlock: 100n });
      expect((await gatherIndexerStatistics(db, { schema })).entities.active).toBe("1");
      // A partially imported genesis must not look like a complete zero or entity total.
      await db.query(`INSERT INTO "${schema}".entity_index_state (key, value) VALUES ('genesis_import', $1)`, [JSON.stringify({ status: "running" })]);
      expect((await gatherIndexerStatistics(db, { schema })).entities).toMatchObject({ status: "importing", known: null, active: null });
    } finally { await index.close(); await db.close(); await cleanup(); }
  });
});
