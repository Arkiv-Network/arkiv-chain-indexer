import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { openDb, type Db } from "./db";
import { AuthStorage } from "./authStorage";
import { EntityIndexStorage } from "./entityIndexStorage";
import { EntityProjector } from "./entityProjector";
import { importGenesisDump, GenesisImportStopped } from "./entityGenesisDumpImport";
import { createArkivIndexMethods } from "./arkivJsonRpc";
import { createIsolatedStorage, TEST_DATABASE_URL, closeTestPools } from "./testPostgres";
import { buildDump, dumpKey, DUMP_OWNER, DUMP_ROOT, memoryDumpSource } from "./testGenesisDump";
import { handleRequest } from "./server";
import { computeBlockMetrics } from "./metrics";
import { inspectBlockFromRpc } from "./blockInspector";
import type { RpcBlock, RpcReceipt } from "./types";
import { ResponseCache } from "./responseCache";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const HASH = `0x${"ab".repeat(32)}`;
const text = buildDump([1, 2].map((n) => ({ key: dumpKey(n), owner: DUMP_OWNER })));
const SHA = createHash("sha256").update(text).digest("hex");
const expected = { chainId: 77n, genesisHash: HASH, stateRoot: DUMP_ROOT, count: 2 };
const manifest = { chainId: 77n, count: 2, stateRoot: DUMP_ROOT };

describeDb("managed genesis (isolated Postgres)", () => {
  let db: Db; let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => { await db?.close(); await cleanup?.(); await closeTestPools(); });
  async function setup() {
    const isolated = await createIsolatedStorage("managed_genesis"); cleanup = isolated.cleanup;
    db = openDb(TEST_DATABASE_URL!, { max: 4 });
    const index = await EntityIndexStorage.fromDb(db, { schema: isolated.schema, managedGenesis: true });
    await isolated.storage.saveChainId(77n);
    const options = { storage: index, source: memoryDumpSource(text, 64), dumpPath: "memory", manifest, expected, sha256: SHA, batchEntities: 1 };
    return { ...isolated, index, options };
  }
  test("managed pending never probes RPC; partial/repair queries are gated and no-head repair completes", async () => {
    const { storage, index, options } = await setup();
    expect((await index.getProgress()).readiness?.ready).toBe(false);
    const projector = new EntityProjector(index, { genesis: { mode: "managed", source: { describe: () => { throw new Error("must not probe"); } } as never }, log: () => {} });
    expect((await projector.runOnce()).genesisStatus).toBe("waiting");
    const health = await handleRequest(new Request("http://localhost/health"), storage, { entityIndex: index });
    expect(health.status).toBe(200);
    expect((await health.json() as { features: { entityQueryIndex: unknown } }).features.entityQueryIndex).toMatchObject({ ready: false, readiness: "genesis-pending", genesis: { status: "waiting" } });
    expect((await handleRequest(new Request("http://localhost/blocks"), storage, { entityIndex: index })).status).toBe(200);
    const methods = createArkivIndexMethods(index, storage);
    await expect(methods.arkiv_getEntityCount([])).rejects.toThrow("incomplete");
    await importGenesisDump(options);
    expect((await index.getGenesisImport())?.phase).toBe("repair");
    await expect(methods.arkiv_query(["*"])).rejects.toThrow("incomplete");
    expect((await projector.runOnce()).genesisStatus).toBe("done");
    expect((await index.getProgress()).readiness?.ready).toBe(true);
    expect(await methods.arkiv_getEntityCount([])).toBe(2);
  });
  test("restart leaves bulk indexes absent until resumed import rebuilds them", async () => {
    const { index, schema, options } = await setup();
    const abort = new AbortController();
    await expect(importGenesisDump({ ...options, signal: abort.signal, onProgress: (_event, doc) => { if (doc.database?.batches === 1) abort.abort(); } })).rejects.toThrow(GenesisImportStopped);
    const exists = async () => (await db.query<{ name: string | null }>("SELECT to_regclass($1)::text AS name", [`${schema}.entity_versions_live_expiry_idx`])).rows[0]!.name;
    expect(await exists()).toBeNull();
    const reopened = await EntityIndexStorage.fromDb(db, { schema, managedGenesis: true });
    expect(await exists()).toBeNull();
    expect((await importGenesisDump({ ...options, storage: reopened })).resumedFrom).toBe(1);
    expect(await exists()).not.toBeNull();
    expect((await index.getGenesisImport())?.phase).toBe("repair");
  });
  test("import lease excludes reset; explicit reset preserves scanner state and authentication", async () => {
    const { index, schema, storage, options } = await setup();
    const auth = new AuthStorage(db, schema); await auth.initialize();
    await auth.createSession({ sub: "fixture", email: "test@example.org", emailVerified: true, hostedDomain: null, name: "Test", picture: null }, "token-hash", "csrf", Date.now() + 60000, null);
    const block: RpcBlock = { number: "0x1", timestamp: "0x1", gasLimit: "0x100000", gasUsed: "0x5208", transactions: [{ hash: dumpKey(9), from: DUMP_OWNER, to: DUMP_OWNER, gas: "0x5208", gasPrice: "0x1" }] };
    const receipts: RpcReceipt[] = [{ transactionHash: dumpKey(9), gasUsed: "0x5208", effectiveGasPrice: "0x1", status: "0x1", logs: [] }];
    await storage.saveBlockMetrics(computeBlockMetrics(block, receipts), undefined, inspectBlockFromRpc(block, receipts).transactions);
    await importGenesisDump(options);
    await index.withImportLock(async () => { await expect(index.reset()).rejects.toThrow("another genesis importer"); });
    const counts = async () => (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${schema}.auth_sessions`)).rows[0]!.n;
    expect(await counts()).toBe("1");
    await index.reset();
    expect(await index.isEmpty()).toBe(true);
    expect(await index.getGenesisImport()).toBeUndefined();
    expect(await storage.getChainId()).toBe(77n);
    expect(await storage.getLastSuccessfulBlock()).toBe(1n);
    expect((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${schema}.transactions`)).rows[0]!.n).toBe("1");
    expect((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${schema}.blocks`)).rows[0]!.n).toBe("1");
    expect(await counts()).toBe("1");
    expect((await index.getProgress()).readiness?.ready).toBe(false);
  });
  test("REST gates partial data before cache access and completion evicts earlier misses", async () => {
    const { storage, index, options } = await setup();
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 10000, ttlMs: 60000 });
    // Mimic a prior deployment's cached miss. The first complete generation must discard it.
    await cache.load(dumpKey(1), async () => ({ status: 404, body: "stale" }));
    const request = () => handleRequest(new Request(`http://localhost/entity/${dumpKey(1)}`), storage, { entityIndex: index, entityHistoryCache: cache });
    expect((await request()).status).toBe(503);
    await importGenesisDump(options);
    expect((await request()).status).toBe(503);
    await new EntityProjector(index, { genesis: { mode: "managed" }, log: () => {} }).runOnce();
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json() as { genesis?: unknown }).genesis).toBeDefined();
    await index.reset();
    expect((await request()).status).toBe(503);
  });
});
