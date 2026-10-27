import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { importGenesisDump, GenesisImportStopped, GenesisVerificationError, recordGenesisVerificationFailure } from "./entityGenesisDumpImport";
import { genesisReadiness, type EntityIndexStorage, type GenesisImportState } from "./entityIndexStorage";
import { buildDump, dumpKey, DUMP_OWNER, DUMP_ROOT, memoryDumpSource } from "./testGenesisDump";

const HASH = `0x${"ab".repeat(32)}`;
const OTHER_HASH = `0x${"cd".repeat(32)}`;
const text = buildDump([1, 2].map((n) => ({ key: dumpKey(n), owner: DUMP_OWNER })));
const SHA = createHash("sha256").update(text).digest("hex");
const expected = { chainId: 77n, genesisHash: HASH, stateRoot: DUMP_ROOT, count: 2 };
const manifest = { chainId: 77n, count: 2, stateRoot: DUMP_ROOT };
function state(patch: Partial<GenesisImportState> = {}): GenesisImportState {
  return { status: "running", phase: "walk", source: "dump", importId: "attempt", chainId: "77", genesisHash: HASH,
    artifactSha256: SHA, total: 2, imported: 0, cursor: null, repairAfterKey: null, startedAt: "2026-01-01T00:00:00Z", finishedAt: null, error: null, ...patch };
}
function fake(initial?: GenesisImportState) {
  let current = initial;
  let locked = false;
  const counters = { rows: 0, stateWrites: 0, streams: 0 };
  const storage = {
    schema: "fake", getScannerChainId: async () => 77n, getStoredBlockHash: async () => undefined,
    getGenesisImport: async () => current ? structuredClone(current) : undefined,
    setGenesisImport: async (next: GenesisImportState) => { counters.stateWrites++; current = structuredClone(next); },
    withFoldLock: async (fn: (client: unknown) => unknown) => fn({}),
    withImportLock: async (fn: () => Promise<unknown>) => { if (locked) throw new Error("another genesis importer or reset is running"); locked = true; try { return await fn(); } finally { locked = false; } },
    isEmpty: async () => counters.rows === 0, dropSecondaryIndexes: async () => {}, ensureIndexes: async () => {},
    insertGenesisVersions: async (rows: unknown[]) => { counters.rows += rows.length; },
  } as unknown as EntityIndexStorage;
  const source = memoryDumpSource(text, 64);
  const options = { storage, source: { size: source.size, stream: (offset: number) => { counters.streams++; return source.stream(offset); } }, dumpPath: "memory", manifest, expected, sha256: SHA, batchEntities: 1 };
  return { options, counters, current: () => current };
}

describe("managed genesis import contract", () => {
  test("a wrong SHA fails durably before the dump parser or rows are reached", async () => {
    const f = fake();
    await expect(importGenesisDump({ ...f.options, sha256: "00".repeat(32) })).rejects.toThrow("SHA-256");
    expect(f.counters).toMatchObject({ streams: 1, rows: 0 });
    expect(f.current()).toMatchObject({ status: "failed", phase: null });
    await expect(importGenesisDump(f.options)).rejects.toThrow("previous genesis import failed");
  });
  test("matching done and repair are immutable no-ops without reading a missing artifact", async () => {
    for (const complete of [state({ status: "done", phase: null, imported: 2 }), state({ phase: "repair", imported: 2 })]) {
      const f = fake(complete);
      const result = await importGenesisDump({ ...f.options, manifest: async () => { throw new Error("must not read"); } });
      expect(result.state).toEqual(complete);
      expect(f.counters).toEqual({ streams: 0, rows: 0, stateWrites: 0 });
    }
  });
  test("running/done identity mismatch and a changed reference refuse without mutation", async () => {
    for (const initial of [state(), state({ status: "done", phase: null })]) {
      const f = fake(initial);
      await expect(importGenesisDump({ ...f.options, expected: { ...expected, genesisHash: OTHER_HASH } })).rejects.toThrow("genesis hash");
      expect(f.counters).toEqual({ streams: 0, rows: 0, stateWrites: 0 });
    }
    const f = fake(state());
    await expect(importGenesisDump({ ...f.options, sha256: "00".repeat(32) })).rejects.toThrow("different dump checksum");
    expect(f.current()?.status).toBe("running");
  });
  test("interruption resumes only the exact committed dump", async () => {
    const f = fake(); const abort = new AbortController();
    await expect(importGenesisDump({ ...f.options, signal: abort.signal, onProgress: (_event, doc) => { if (doc.database?.batches === 1) abort.abort(); } })).rejects.toThrow(GenesisImportStopped);
    expect(f.current()).toMatchObject({ status: "running", imported: 1, artifactSha256: SHA });
    const resumed = await importGenesisDump(f.options);
    expect(resumed).toMatchObject({ imported: 2, resumedFrom: 1, state: { phase: "repair" } });
    expect(f.counters.rows).toBe(2);
  });
  test("manifest verification failure persists, and a competing callback cannot replace it", async () => {
    const f = fake();
    await expect(importGenesisDump({ ...f.options, manifest: async () => { throw new GenesisVerificationError("manifest checksum"); } })).rejects.toThrow("manifest checksum");
    expect(f.current()).toMatchObject({ status: "failed" });
    const done = fake(state({ status: "done", phase: null }));
    await recordGenesisVerificationFailure(done.options.storage, { ...expected, sha256: SHA }, "bad download");
    expect(done.counters.stateWrites).toBe(0);
    await expect(recordGenesisVerificationFailure(done.options.storage, { ...expected, genesisHash: OTHER_HASH, sha256: SHA }, "bad download")).rejects.toThrow("genesis hash");
    expect(done.counters.stateWrites).toBe(0);
  });
  test("a stop before manifest metadata is recorded resumes without a false count mismatch", async () => {
    const f = fake();
    await expect(importGenesisDump({ ...f.options, expected: {}, manifest: async () => { throw new GenesisImportStopped(0); } })).rejects.toThrow(GenesisImportStopped);
    expect(f.current()).toMatchObject({ status: "running", total: 0, imported: 0 });
    expect((await importGenesisDump(f.options)).imported).toBe(2);
  });
  test("manifest parser errors are durable but a newer invocation is never marked failed", async () => {
    const f = fake();
    await expect(importGenesisDump({ ...f.options, manifest: async () => { throw new SyntaxError("invalid manifest"); } })).rejects.toThrow("invalid manifest");
    expect(f.current()?.status).toBe("failed");
    const changed = fake();
    await expect(importGenesisDump({ ...changed.options, manifest: async () => {
      await changed.options.storage.setGenesisImport(state({ attemptId: "newer" }));
      throw new SyntaxError("invalid manifest");
    } })).rejects.toThrow("invalid manifest");
    expect(changed.current()).toMatchObject({ status: "running", attemptId: "newer" });
  });
  test("readiness distinguishes pending, failed, complete and ordinary unseeded databases", () => {
    expect(genesisReadiness(undefined, true)).toMatchObject({ ready: false, reason: "genesis-pending" });
    for (const status of ["waiting", "running", "failed", "unavailable"] as const) expect(genesisReadiness(state({ status }), false).ready).toBe(false);
    expect(genesisReadiness(state({ status: "done" }), true).ready).toBe(true);
    expect(genesisReadiness(undefined, false).ready).toBe(true);
    expect(genesisReadiness(state({ status: "none" }), false).ready).toBe(true);
  });
});
