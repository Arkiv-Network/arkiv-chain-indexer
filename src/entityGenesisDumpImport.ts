/**
 * The offline genesis import: load a `state.jsonl` dump's entity records into
 * the entity index tables, prove their id order, and hand the import to the
 * backend's projector for the repair phase (refolding the genesis keys that
 * have operations after block 0). `scripts/importGenesisState.ts` drives it.
 *
 * It shares the RPC walk's state row (`genesis_import`) and storage path, so
 * `/health` reports it the same way and the projector keeps its hands off the
 * index while it runs. Batches commit under the fold lock with the resume
 * point (byte offset, line, id ledger) in the row, so an interrupted run —
 * a signal, a lost connection — resumes from its last batch rather than from
 * the first byte, which matters at 100 million entities.
 */

import { createHash, randomUUID } from "node:crypto";
import type { GenesisChain } from "./entityGenesis";
import { GenesisEntityError } from "./entityGenesis";
import {
  GenesisIdLedger,
  decodeEntityRecord,
  readDumpRoot,
  readGenesisDump,
  type DumpSource,
  type GenesisLedgerState,
} from "./entityGenesisDump";
import type { EntityVersion } from "./entityIndex";
import type { EntityIndexStorage, GenesisImportState } from "./entityIndexStorage";
import { GenesisProgressTracker, type GenesisProgressDocument } from "./genesisProgress";
import type { DbQueryable } from "./db";

/** A precondition the import will not proceed past (nothing was written for it). */
export class GenesisImportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenesisImportRefused";
  }
}

/** The import was stopped through its abort signal at a batch boundary; running it again resumes. */
export class GenesisImportStopped extends Error {
  constructor(readonly imported: number) {
    super(`stopped after ${imported} entities; run the import again to resume`);
    this.name = "GenesisImportStopped";
  }
}

export interface GenesisDumpManifest {
  chainId: bigint;
  /** Entities the seeder wrote. */
  count: number;
  stateRoot: string | null;
}

/** Read the `state.jsonl.manifest.json` sidecar `arkiv-cli seed-genesis` writes next to the dump. */
export function parseDumpManifest(raw: unknown): GenesisDumpManifest {
  if (typeof raw !== "object" || raw === null) throw new GenesisImportRefused("the manifest is not a JSON object");
  const manifest = raw as Record<string, unknown>;
  const chainId = manifest.chainId;
  if (!(typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0) && typeof chainId !== "string") {
    throw new GenesisImportRefused("the manifest has no chainId");
  }
  const count = manifest.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new GenesisImportRefused("the manifest has no entity count");
  const stateRoot = manifest.stateRoot;
  if (stateRoot !== undefined && stateRoot !== null && typeof stateRoot !== "string") throw new GenesisImportRefused("the manifest's stateRoot is not a string");
  let parsedChainId: bigint;
  try { parsedChainId = BigInt(chainId); } catch { throw new GenesisImportRefused("the manifest chainId is not an integer"); }
  if (parsedChainId <= 0n) throw new GenesisImportRefused("the manifest chainId must be positive");
  if (typeof stateRoot === "string" && !/^0x[0-9a-fA-F]{64}$/.test(stateRoot)) throw new GenesisImportRefused("the manifest stateRoot is not a 32-byte hash");
  return { chainId: parsedChainId, count, stateRoot: typeof stateRoot === "string" ? stateRoot.toLowerCase() : null };
}

/** What a node said about its genesis (`describe()` + `count()`), to check the dump against. */
export interface GenesisDumpExpectation extends Partial<GenesisChain> {
  count?: number;
}

export type RebuildIndexes = "auto" | "always" | "never";

export interface ImportGenesisDumpOptions {
  storage: EntityIndexStorage;
  source: DumpSource;
  /** For the progress document only. */
  dumpPath: string;
  /** A loader lets the CLI verify the manifest before parsing, under the import lease. */
  manifest: GenesisDumpManifest | (() => Promise<GenesisDumpManifest>);
  /** Trusted digest of the exact dump bytes. Without one, the computed digest still binds resumes. */
  sha256?: string;
  expected?: GenesisDumpExpectation;
  /** Entities per transaction (default 5,000). */
  batchEntities?: number;
  /**
   * Drop the secondary indexes for the load and rebuild them after it:
   * `auto` (default) does so on an empty index, `always` regardless, `never` not at all.
   */
  rebuildIndexes?: RebuildIndexes;
  /** Updated in place as the import goes; a fresh one is made when absent. */
  progress?: GenesisProgressTracker;
  /** Called on every phase change and, at most every `progressIntervalMs`, on progress. */
  onProgress?: (event: "phase" | "progress", doc: GenesisProgressDocument) => void;
  progressIntervalMs?: number;
  /** Stops the import at the next line boundary after committing what is in hand. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait between attempts on the fold lock (default 250 ms). */
  lockRetryMs?: number;
  now?: () => number;
}

export interface ImportGenesisDumpResult {
  /** Entities in the index after this run (all of them, once handed off). */
  imported: number;
  /** Entities an earlier run had written before this one started. */
  resumedFrom: number;
  total: number;
  /** The state row as handed to the projector. */
  state: GenesisImportState;
}

interface ResumeCursor {
  v: 1;
  /** Byte offset of the next line to read. */
  offset: number;
  /** Its 1-based line number. */
  line: number;
  ledger: GenesisLedgerState;
  indexes: "kept" | "dropped";
}

function parseResume(cursor: string): ResumeCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    throw new GenesisImportRefused("the import's stored resume point is not JSON");
  }
  const resume = parsed as Partial<ResumeCursor>;
  if (
    resume.v !== 1 ||
    typeof resume.offset !== "number" || !Number.isSafeInteger(resume.offset) || resume.offset < 0 ||
    typeof resume.line !== "number" || !Number.isSafeInteger(resume.line) || resume.line < 1 ||
    typeof resume.ledger !== "object" ||
    resume.ledger === null ||
    (resume.indexes !== "kept" && resume.indexes !== "dropped")
  ) {
    throw new GenesisImportRefused("the import's stored resume point has an unknown shape");
  }
  return resume as ResumeCursor;
}

const sameHash = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function importGenesisDump(options: ImportGenesisDumpOptions): Promise<ImportGenesisDumpResult> {
  return options.storage.withImportLock(() => importGenesisDumpLocked(options));
}

export class GenesisVerificationError extends GenesisEntityError {
  constructor(message: string) { super(undefined, message); }
}

/** Hash bytes before any entity decoding; a cursor is valid only for these exact bytes. */
export async function dumpSha256(source: DumpSource, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const reader = source.stream(0).getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new GenesisImportStopped(0);
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
    }
    return hash.digest("hex");
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function assertIdentity(state: GenesisImportState, expected: GenesisDumpExpectation): void {
  if (expected.chainId !== undefined && state.chainId !== expected.chainId.toString()) throw new GenesisImportRefused("the stored import belongs to a different chain id; reset is required");
  if (expected.genesisHash && (!state.genesisHash || !sameHash(state.genesisHash, expected.genesisHash))) throw new GenesisImportRefused("the stored import belongs to a different or unknown genesis hash; reset is required");
}

async function importGenesisDumpLocked(options: ImportGenesisDumpOptions): Promise<ImportGenesisDumpResult> {
  const { storage, source, expected } = options;
  let manifest: GenesisDumpManifest;
  let ownedImport: string | undefined;
  const attemptId = randomUUID();
  const batchEntities = options.batchEntities ?? 5000;
  const rebuild = options.rebuildIndexes ?? "auto";
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const intervalMs = options.progressIntervalMs ?? 2000;
  const tracker = options.progress ?? new GenesisProgressTracker({ writer: "import-script", source: "dump", now });
  const doc = tracker.doc;
  doc.source = "dump";

  doc.dump = {
    path: options.dumpPath,
    bytes_total: source.size,
    bytes_read: 0,
    bytes_per_s: null,
    eta_s: null,
    lines: 0,
    records: 0,
    system_account: { seen: false, ids: 0, entity_count: null },
    verification: "pending",
  };
  doc.database = { schema: storage.schema, batch_size: batchEntities, batches: 0, last_batch_ms: null, indexes: "kept", index_rebuild_s: null };
  let lastEmit = 0;
  const emit = (event: "phase" | "progress"): void => {
    lastEmit = now();
    options.onProgress?.(event, tracker.snapshot());
  };
  const setPhase = (phase: GenesisProgressDocument["phase"]): void => {
    tracker.setPhase(phase);
    emit("phase");
  };
  const fail = (error: unknown): never => {
    doc.error = error instanceof Error ? error.message : String(error);
    tracker.setPhase(error instanceof GenesisImportStopped ? "stopped" : "failed");
    emit("phase");
    throw error;
  };

  /** Run `fn` under the fold lock, waiting while the backend holds it. */
  const withLock = async <T>(fn: (client: DbQueryable) => Promise<T>): Promise<T> => {
    let waiting = false;
    for (;;) {
      const held = await storage.withFoldLock(async (client) => ({ value: await fn(client) }));
      if (held !== undefined) return held.value;
      if (!waiting) {
        waiting = true;
        log("waiting for the entity index's fold lock (the backend is folding)");
      }
      await sleep(options.lockRetryMs ?? 250);
    }
  };

  try {
    setPhase("checking");
    const previous = await storage.getGenesisImport();
    // A completed import needs no dump access or mutation. The managed caller
    // supplies live-node identity, including the execution block hash.
    if (previous && (previous.status === "done" || (previous.status === "running" && previous.phase === "repair"))) {
      const metadata = typeof options.manifest === "function" ? undefined : options.manifest;
      const chainId = expected?.chainId ?? metadata?.chainId ?? await storage.getScannerChainId();
      const genesisHash = expected?.genesisHash ?? await storage.getStoredBlockHash(0n);
      if (chainId === undefined || !genesisHash) throw new GenesisImportRefused("cannot prove the completed import's chain identity; supply --rpc or trusted identity");
      assertIdentity(previous, { chainId, genesisHash });
      doc.status = previous.status;
      doc.entities.total = previous.total;
      doc.entities.imported = previous.imported;
      setPhase(previous.status === "done" ? "done" : "repairing");
      return { imported: previous.imported, resumedFrom: previous.imported, total: previous.total, state: previous };
    }
    if (previous?.status === "failed") throw new GenesisImportRefused(`a previous genesis import failed (${previous.error ?? "no reason recorded"}); reset the entity index to import again`);
    if (previous?.status === "running" && previous.source !== "dump") throw new GenesisImportRefused("the backend is importing genesis from the node; disable auto import before a managed run");
    if (previous?.status === "running") {
      const fallbackManifest = typeof options.manifest === "function" ? undefined : options.manifest;
      const chainId = expected?.chainId ?? fallbackManifest?.chainId ?? await storage.getScannerChainId();
      const genesisHash = expected?.genesisHash ?? await storage.getStoredBlockHash(0n);
      if (previous.chainId !== null) assertIdentity(previous, { ...(chainId !== undefined ? { chainId } : {}), ...(genesisHash ? { genesisHash } : {}) });
      else if (previous.imported > 0 || previous.cursor !== null) throw new GenesisImportRefused("the running import has no chain identity; reset is required");
      if (options.sha256 && previous.artifactSha256 && options.sha256.toLowerCase() !== previous.artifactSha256) throw new GenesisImportRefused("the resume belongs to a different dump checksum; reset is required");
      if (previous.imported > 0 && !previous.artifactSha256) throw new GenesisImportRefused("the legacy resume has no dump checksum; reset is required");
    }
    // Claim the invocation before verification, so bad bytes produce a durable
    // failed state. The session lease excludes other importers and resets.
    const opened = await withLock(async (client) => {
      const current = await storage.getGenesisImport(client);
      if (JSON.stringify(current) !== JSON.stringify(previous)) throw new GenesisImportRefused("the import changed while starting; retry");
      const state: GenesisImportState = current?.status === "running" ? { ...current, importId: current.importId ?? randomUUID(), attemptId } : {
        status: "running", phase: "walk", source: "dump", importId: randomUUID(), attemptId,
        ...(options.sha256 ? { artifactSha256: options.sha256.toLowerCase() } : {}),
        chainId: expected?.chainId?.toString() ?? null, genesisHash: expected?.genesisHash ?? null,
        total: expected?.count ?? 0, imported: 0, cursor: null, repairAfterKey: null,
        startedAt: new Date(now()).toISOString(), finishedAt: null, error: null,
      };
      ownedImport = state.importId;
      await storage.setGenesisImport(state, client);
      return { state, resume: state.cursor === null ? null : parseResume(state.cursor) };
    });
    try {
      manifest = typeof options.manifest === "function" ? await options.manifest() : options.manifest;
    } catch (error) {
      if (error instanceof GenesisImportStopped) throw error;
      throw new GenesisVerificationError(error instanceof Error ? error.message : String(error));
    }
    doc.chain_id = Number(manifest.chainId);
    doc.state_root = manifest.stateRoot;
    doc.entities.total = manifest.count;
    const scannerChainId = await storage.getScannerChainId();
    if (scannerChainId !== undefined && scannerChainId !== manifest.chainId) throw new GenesisVerificationError(`the database follows chain ${scannerChainId}, the dump is for chain ${manifest.chainId}`);
    if (expected?.chainId !== undefined && expected.chainId !== manifest.chainId) throw new GenesisVerificationError(`the node is chain ${expected.chainId}, the dump is for chain ${manifest.chainId}`);
    if (expected?.count !== undefined && expected.count !== manifest.count) throw new GenesisVerificationError(`the node holds ${expected.count} entities at block 0, the dump ${manifest.count}`);
    if (expected?.stateRoot && manifest.stateRoot && !sameHash(expected.stateRoot, manifest.stateRoot)) throw new GenesisVerificationError("the node's block-0 state root differs from the dump's");
    // Persist metadata before the potentially long checksum pass, so even a
    // signal before the first entity batch remains resumable for manual runs.
    const storedHash = await storage.getStoredBlockHash(0n);
    if (expected?.genesisHash && storedHash && !sameHash(expected.genesisHash, storedHash)) throw new GenesisVerificationError("the node's genesis hash differs from the block-0 hash the scanner stored");
    const genesisHash = expected?.genesisHash ?? storedHash ?? null;
    if (previous?.status === "running" && previous.chainId !== null) assertIdentity(previous, { chainId: manifest.chainId, ...(genesisHash ? { genesisHash } : {}) });
    if (previous?.status === "running" && previous.total !== manifest.count && (previous.cursor !== null || previous.artifactBytes !== undefined)) throw new GenesisVerificationError("the manifest count differs from the running import");
    await withLock(async (client) => {
      const current = await storage.getGenesisImport(client);
      if (!current || current.importId !== ownedImport || current.attemptId !== attemptId) throw new GenesisImportRefused("the import changed while checking metadata");
      await storage.setGenesisImport({ ...current, chainId: manifest.chainId.toString(), genesisHash, total: manifest.count }, client);
    });
    if (source.size === 0) throw new GenesisVerificationError("the dump is empty or missing");
    const digest = await dumpSha256(source, options.signal);
    if (options.sha256 && digest !== options.sha256.toLowerCase()) throw new GenesisVerificationError("the downloaded dump's SHA-256 does not match the trusted reference");
    if (opened.state.artifactSha256 && opened.state.artifactSha256 !== digest) throw new GenesisVerificationError("the downloaded dump differs from the committed resume checksum");
    const root = (await readDumpRoot(source)).toLowerCase();
    if (manifest.stateRoot && !sameHash(root, manifest.stateRoot)) throw new GenesisVerificationError("the dump's state root differs from the manifest's");
    if (expected?.stateRoot && !sameHash(root, expected.stateRoot)) throw new GenesisVerificationError("the dump's state root differs from the node's block-0 state root");
    doc.state_root = root;
    doc.genesis_hash = genesisHash;
    await withLock(async (client) => {
      const current = await storage.getGenesisImport(client);
      if (!current || current.importId !== ownedImport || current.attemptId !== attemptId || current.status !== "running" || current.phase !== "walk") throw new GenesisImportRefused("the import changed while verifying");
      await storage.setGenesisImport({ ...current, chainId: manifest.chainId.toString(), genesisHash, total: manifest.count, artifactSha256: digest, artifactBytes: source.size, stateRoot: root }, client);
    });
    const { resume } = opened;
    if (resume && resume.offset > source.size) throw new GenesisVerificationError("the resume offset exceeds the dump size");
    const resumedFrom = opened.state.imported;
    doc.status = "running";
    doc.entities.skipped = resumedFrom;
    doc.entities.imported = resumedFrom;
    if (resume && resume.ledger.records !== opened.state.imported) throw new GenesisVerificationError("the import resume count does not match");
    if (resume) log(`resuming at byte ${resume.offset.toLocaleString("en-US")} (line ${resume.line}), ${resumedFrom.toLocaleString("en-US")} entities already in`);

    let indexes: "kept" | "dropped" = opened.state.indexes ?? resume?.indexes ?? "kept";
    if (!resume) {
      if (indexes === "dropped" || rebuild === "always" || (rebuild === "auto" && (await storage.isEmpty()))) {
        indexes = "dropped";
        await withLock(async (client) => {
          const current = await storage.getGenesisImport(client);
          if (!current || current.importId !== ownedImport || current.attemptId !== attemptId) throw new GenesisImportRefused("the import changed");
          await storage.setGenesisImport({ ...current, indexes }, client);
        });
        await storage.dropSecondaryIndexes();
      }
    } else if (indexes === "dropped") {
      await storage.dropSecondaryIndexes(); // idempotent; the first run may have died between dropping and its first commit
    }
    doc.database.indexes = indexes;
    if (indexes === "dropped") log("secondary indexes dropped for the load; they are rebuilt afterwards");

    setPhase("loading");
    const ledger = new GenesisIdLedger(resume?.ledger);
    let imported = resumedFrom;
    let batch: EntityVersion[] = [];
    const commit = async (offset: number, line: number): Promise<void> => {
      const versions = batch;
      batch = [];
      const cursor: ResumeCursor = { v: 1, offset, line, ledger: ledger.state(), indexes };
      const startedAt = now();
      await withLock(async (client) => {
        const current = await storage.getGenesisImport(client);
        if (!current || current.status !== "running" || current.phase !== "walk" || current.source !== "dump" || current.imported !== imported || current.importId !== ownedImport || current.attemptId !== attemptId) {
          throw new GenesisImportRefused("the import's state row changed underneath this run (another importer, or a reset)");
        }
        await storage.insertGenesisVersions(versions, client);
        await storage.setGenesisImport({ ...current, imported: imported + versions.length, cursor: JSON.stringify(cursor) }, client);
      });
      imported += versions.length;
      doc.entities.imported = imported;
      doc.database!.batches += 1;
      doc.database!.last_batch_ms = Math.round(now() - startedAt);
      tracker.sample();
      emit("progress");
    };
    const syncDump = (line: number, end: number): void => {
      doc.dump!.lines = line;
      doc.dump!.bytes_read = end;
      const state = ledger.state();
      doc.dump!.records = state.records;
      doc.dump!.system_account = { seen: state.systemSeen, ids: state.ids, entity_count: state.entityCount === null ? null : Number(state.entityCount) };
    };

    let lastOffset = resume?.offset ?? 0;
    let lastLine = resume?.line ?? 1;
    for await (const event of readGenesisDump(source, resume?.offset ?? 0, resume?.line ?? 1)) {
      switch (event.type) {
        case "root":
          if (!sameHash(event.root, root)) throw new GenesisEntityError(undefined, "the dump changed while it was being read");
          break;
        case "record": {
          const version = decodeEntityRecord(event.code, ledger.state().records);
          ledger.addRecord(version.entityKey);
          batch.push(version);
          doc.entities.attributes += version.attributes.length;
          doc.entities.payload_bytes += version.payloadSize;
          if (batch.length >= batchEntities) await commit(event.end, event.line + 1);
          break;
        }
        case "slot":
          ledger.addSlot(event.slot, event.value);
          continue; // not a line boundary
        case "system":
          ledger.markSystemSeen();
          break;
        case "other":
          break;
      }
      lastOffset = event.end;
      lastLine = event.line + 1;
      syncDump(event.line, event.end);
      if (options.signal?.aborted) {
        if (batch.length > 0) await commit(lastOffset, lastLine);
        throw new GenesisImportStopped(imported);
      }
      if (now() - lastEmit >= intervalMs) {
        tracker.sample();
        emit("progress");
      }
    }

    setPhase("verifying");
    ledger.verify(manifest.count);
    if (imported + batch.length !== manifest.count) {
      throw new GenesisEntityError(undefined, `${imported + batch.length} entities decoded, ${manifest.count} expected`);
    }
    doc.dump.verification = "passed";
    await commit(lastOffset, lastLine);

    if (indexes === "dropped") {
      setPhase("indexing");
      const startedAt = now();
      await storage.ensureIndexes();
      doc.database.indexes = "rebuilt";
      doc.database.index_rebuild_s = Math.round((now() - startedAt) / 100) / 10;
    }

    const handed = await withLock(async (client) => {
      const current = await storage.getGenesisImport(client);
      if (!current || current.status !== "running" || current.phase !== "walk" || current.source !== "dump" || current.imported !== imported || current.importId !== ownedImport || current.attemptId !== attemptId) {
        throw new GenesisImportRefused("the import's state row changed underneath this run (another importer, or a reset)");
      }
      const next: GenesisImportState = { ...current, phase: "repair", cursor: null, indexes: "kept" };
      await storage.setGenesisImport(next, client);
      return next;
    });
    setPhase("repairing");
    return { imported, resumedFrom, total: manifest.count, state: handed };
  } catch (error) {
    if (error instanceof GenesisEntityError) {
      doc.dump!.verification = "failed";
      await withLock(async (client) => {
        const current = await storage.getGenesisImport(client);
        if (!current || current.importId !== ownedImport || current.attemptId !== attemptId || current.status !== "running" || current.source !== "dump" || current.phase !== "walk") return;
        await storage.setGenesisImport(
          { ...current, status: "failed", phase: null, finishedAt: new Date(now()).toISOString(), error: error.message },
          client,
        );
        doc.status = "failed";
      }).catch((inner: unknown) => log(`could not record the failure: ${inner instanceof Error ? inner.message : String(inner)}`));
    }
    return fail(error);
  }
}

/** Persist a verified invocation's download failure without replacing another chain/import. */
export async function recordGenesisVerificationFailure(
  storage: EntityIndexStorage,
  identity: { chainId: bigint; genesisHash: string; sha256: string },
  message: string,
): Promise<void> {
  await storage.withImportLock(async () => {
    const result = await storage.withFoldLock(async (client) => {
      const current = await storage.getGenesisImport(client);
      if (current && current.chainId !== null) assertIdentity(current, identity);
      if (current?.status === "done" || current?.status === "failed" || (current?.status === "running" && current.phase === "repair")) return true;
      if (current?.status === "running" && (current.source !== "dump" || (current.artifactSha256 && current.artifactSha256 !== identity.sha256.toLowerCase()))) throw new GenesisImportRefused("another import owns the database");
      const now = new Date().toISOString();
      await storage.setGenesisImport({
        ...current, importId: current?.importId ?? randomUUID(), status: "failed", phase: null, source: "dump",
        chainId: identity.chainId.toString(), genesisHash: identity.genesisHash, artifactSha256: identity.sha256.toLowerCase(),
        total: current?.total ?? 0, imported: current?.imported ?? 0, cursor: current?.cursor ?? null,
        repairAfterKey: null, startedAt: current?.startedAt ?? now, finishedAt: now, error: message,
      }, client);
      return true;
    });
    if (!result) throw new GenesisImportRefused("the projector is busy; retry recording the verification failure");
  });
}
