/**
 * The loop that keeps the experimental entity index folded up to the
 * scanner's head.
 *
 * Progress is a single block number, `projected_through_block`: every
 * operation at or below it has been folded into `entity_versions`. Each tick
 * advances it in chunks sized by operation count, refolding every entity key
 * an operation in the chunk touches. A refold rebuilds the key's whole history
 * from its operations, so the fold is idempotent — folding a chunk twice, or
 * an entity's later operations before its earlier ones arrive, always ends in
 * the same rows.
 *
 * That idempotence is also how operations arriving *below* the fold point are
 * handled. The gap filler and the backfill scanner write old blocks, and a
 * rescan rewrites a block's rows; none of that moves the head. So on a
 * schedule the projector looks for operation rows written since its last look
 * (`scanned_at`, with a generous overlap) that sit at or below the fold point,
 * and refolds their keys.
 *
 * Before any of that comes the chain's genesis. A chain seeded at birth
 * (`entityGenesis.ts`) holds entities no operation ever created; the
 * projector asks the node once whether block 0 holds any, imports them page
 * by page while nothing else folds — a patch folded before its genesis base
 * is in would fold to nothing — and then refolds every genesis entity that
 * also has operations, on top of its base. Only then does the index vouch
 * for block 0. A seed too big for the node's paging is left to
 * `scripts/importGenesisState.ts`, which writes the same rows offline and
 * hands the same repair back to this loop.
 *
 * Every write happens under a transaction-scoped advisory lock, so two
 * backends pointed at one schema cannot fold on top of each other: the second
 * simply finds the lock taken and tries again next tick.
 */
import {
  GENESIS_PAGE_SIZE,
  GenesisEntityError,
  GenesisRpcError,
  GenesisSourceUnavailable,
  MAX_GENESIS_POSITION,
  walkGenesisEntities,
  type GenesisSource,
} from "./entityGenesis";
import type { EntityVersion } from "./entityIndex";
import type { EntityIndexStorage, GenesisImportState, GenesisImportStatus } from "./entityIndexStorage";
import {
  GenesisProgressTracker,
  createGenesisProgressFileWriter,
  type GenesisProgressFileWriter,
  type GenesisProgressPhase,
} from "./genesisProgress";

export interface EntityProjectorGenesisOptions {
  /** The node to import from; without one, only an import the offline importer started is finished here. */
  source?: GenesisSource;
  /** `auto` asks the source once whether block 0 holds entities; `off` never asks. */
  mode?: "auto" | "off";
  /** The largest genesis the RPC walk takes on; beyond it the import waits for the offline importer. */
  rpcLimit?: number;
  /** Entities per write transaction. */
  batchEntities?: number;
  /** Entities per page of the walk. */
  pageSize?: number;
  /** How long after a probe that could not reach the node before the next attempt. */
  probeRetryMs?: number;
  /**
   * Write the import's progress document here (see `genesisProgress.ts`) on
   * every change, so a watcher — arkiv-prefill's dashboard, a script — can
   * follow the walk and the repair without polling `/health`. While the
   * offline importer loads a dump it owns the file; the projector takes over
   * at the repair.
   */
  progressFile?: string;
}

export interface EntityProjectorOptions {
  /** Pause between ticks once caught up. */
  pollMs?: number;
  /** Target operations per fold chunk (a chunk always ends on a block boundary). */
  maxOpsPerChunk?: number;
  /** How often to look for operations written below the fold point. */
  lateScanIntervalMs?: number;
  /** How far before the last watermark the late scan re-examines, to survive in-flight writes. */
  lateScanOverlapMs?: number;
  /** Wall-clock budget per tick; a long initial build yields between ticks. */
  maxTickMs?: number;
  /** Pin the floor instead of detecting the first keyed create. */
  floorBlock?: bigint;
  /** The genesis import; absent, the projector still finishes an import the offline importer started. */
  genesis?: EntityProjectorGenesisOptions;
  /** Least time between two counts of the live entities (a count is never taken by a request). */
  liveCountIntervalMs?: number;
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
}

export interface EntityProjectorTick {
  /** The scanner head the tick saw, or undefined on an empty database. */
  head: bigint | undefined;
  /** Where the fold stands after the tick. */
  projectedThroughBlock: bigint | undefined;
  chunksFolded: number;
  entitiesRefolded: number;
  lateKeysRefolded: number;
  /** True when another projector held the lock and this tick stood down. */
  lockHeldElsewhere: boolean;
  /** The genesis import's status after the tick; undefined when no import was ever considered. */
  genesisStatus: GenesisImportStatus | undefined;
  /** Genesis entities written this tick. */
  genesisEntitiesImported: number;
  /** Genesis entities refolded with their later operations this tick. */
  genesisKeysRepaired: number;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_OPS_PER_CHUNK = 20_000;
const DEFAULT_LATE_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_LATE_SCAN_OVERLAP_MS = 120_000;
const DEFAULT_MAX_TICK_MS = 30_000;
const DEFAULT_LIVE_COUNT_INTERVAL_MS = 60_000;
/** Longest wait between two attempts once ticks keep failing. */
const MAX_RETRY_MS = 60_000;
/** A count that took `t` waits at least this many `t` before the next: a slow count stays rare. */
const LIVE_COUNT_DUTY_FACTOR = 20;
export const DEFAULT_GENESIS_RPC_LIMIT = 1_000_000;
const DEFAULT_GENESIS_BATCH_ENTITIES = 5_000;
const DEFAULT_GENESIS_PROBE_RETRY_MS = 60_000;

interface GenesisStageOutcome {
  status: GenesisImportStatus | undefined;
  imported: number;
  repaired: number;
  /** True while the import owns the index: nothing else folds this tick. */
  blocked: boolean;
  lockHeldElsewhere: boolean;
}

const GENESIS_IDLE: GenesisStageOutcome = { status: undefined, imported: 0, repaired: 0, blocked: false, lockHeldElsewhere: false };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long to wait before the attempt that follows `failures` consecutive
 * failed ticks: the poll interval, doubled per failure and capped. A tick that
 * fails on something transient retries at the poll interval, while one that
 * cannot succeed — a chunk whose fold the database refuses — backs off instead
 * of replaying the same work every poll.
 */
export function retryDelayMs(failures: number, pollMs: number, capMs: number = MAX_RETRY_MS): number {
  if (failures <= 0) return pollMs;
  return Math.min(pollMs * 2 ** (failures - 1), capMs);
}

export class EntityProjector {
  private readonly pollMs: number;
  private readonly maxOpsPerChunk: number;
  private readonly lateScanIntervalMs: number;
  private readonly lateScanOverlapMs: number;
  private readonly maxTickMs: number;
  private readonly floorOverride: bigint | undefined;
  private readonly genesis: Required<Omit<EntityProjectorGenesisOptions, "source" | "progressFile">> & {
    source: GenesisSource | undefined;
    progressFile: string | undefined;
  };
  private readonly progressWriter: GenesisProgressFileWriter | undefined;
  private progressTracker: GenesisProgressTracker | undefined;
  /** `startedAt` of the import the tracker describes; a new import gets a new tracker. */
  private progressTrackedImport: string | undefined;
  private progressPages = 0;
  private progressAttributes = 0;
  private progressRepairBatches = 0;
  private progressRepaired = 0;
  private readonly liveCountIntervalMs: number;
  private readonly log: (message: string) => void;
  private readonly onError: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<EntityProjectorTick> | undefined;
  private stopped = false;
  private lastLateScanAt = 0;
  private lastProbeAt = 0;
  private lastLiveCountAt = 0;
  private lastLiveCountMs = 0;
  private warnedOnce = new Set<string>();

  constructor(
    private readonly storage: EntityIndexStorage,
    options: EntityProjectorOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.maxOpsPerChunk = options.maxOpsPerChunk ?? DEFAULT_MAX_OPS_PER_CHUNK;
    this.lateScanIntervalMs = options.lateScanIntervalMs ?? DEFAULT_LATE_SCAN_INTERVAL_MS;
    this.lateScanOverlapMs = options.lateScanOverlapMs ?? DEFAULT_LATE_SCAN_OVERLAP_MS;
    this.maxTickMs = options.maxTickMs ?? DEFAULT_MAX_TICK_MS;
    this.floorOverride = options.floorBlock;
    this.genesis = {
      source: options.genesis?.source,
      mode: options.genesis?.mode ?? "auto",
      rpcLimit: options.genesis?.rpcLimit ?? DEFAULT_GENESIS_RPC_LIMIT,
      batchEntities: options.genesis?.batchEntities ?? DEFAULT_GENESIS_BATCH_ENTITIES,
      pageSize: options.genesis?.pageSize ?? GENESIS_PAGE_SIZE,
      probeRetryMs: options.genesis?.probeRetryMs ?? DEFAULT_GENESIS_PROBE_RETRY_MS,
      progressFile: options.genesis?.progressFile,
    };
    this.liveCountIntervalMs = options.liveCountIntervalMs ?? DEFAULT_LIVE_COUNT_INTERVAL_MS;
    this.log = options.log ?? ((message) => console.log(message));
    this.onError = options.onError ?? ((error) => console.error("entity index: fold failed:", error));
    this.progressWriter = this.genesis.progressFile ? createGenesisProgressFileWriter(this.genesis.progressFile, this.log) : undefined;
  }

  /** Fold on a loop until {@link stop}. */
  start(): void {
    this.stopped = false;
    let failures = 0;
    const tick = async () => {
      if (this.stopped) return;
      let waitMs = this.pollMs;
      try {
        await this.runOnce();
        failures = 0;
      } catch (error) {
        failures += 1;
        waitMs = retryDelayMs(failures, this.pollMs);
        this.onError(
          new Error(
            `${describeError(error)} (${failures} consecutive failures, next attempt in ${waitMs}ms)`,
            { cause: error },
          ),
        );
      }
      if (!this.stopped) this.timer = setTimeout(tick, waitMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) {
      try {
        await this.running;
      } catch {
        // The failure was already reported through onError.
      }
    }
  }

  /** One tick: the genesis import if one is due, late arrivals, then as many forward chunks as the budget allows. */
  runOnce(): Promise<EntityProjectorTick> {
    if (!this.running) {
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async tick(): Promise<EntityProjectorTick> {
    const result: EntityProjectorTick = {
      head: undefined,
      projectedThroughBlock: undefined,
      chunksFolded: 0,
      entitiesRefolded: 0,
      lateKeysRefolded: 0,
      lockHeldElsewhere: false,
      genesisStatus: undefined,
      genesisEntitiesImported: 0,
      genesisKeysRepaired: 0,
    };
    const head = await this.storage.getIndexedHead();
    result.head = head;
    if (head === undefined) return result;

    const genesis = await this.runGenesisStage();
    result.genesisStatus = genesis.status;
    result.genesisEntitiesImported = genesis.imported;
    result.genesisKeysRepaired = genesis.repaired;
    result.projectedThroughBlock = (await this.storage.getProgress()).projectedThroughBlock;
    if (genesis.lockHeldElsewhere) {
      result.lockHeldElsewhere = true;
      return result;
    }
    if (genesis.blocked) return result;

    let progress = await this.storage.getProgress();
    if (progress.floorBlock === undefined) {
      const floor = this.floorOverride ?? (await this.storage.detectFloorBlock());
      if (floor === undefined) return result; // no keyed create stored yet
      await this.storage.setProgress({
        floorBlock: floor,
        projectedThroughBlock: floor - 1n,
        lateScanWatermark: await this.storage.now(),
      });
      this.log(`entity index: starting at block ${floor} (first create with an entity key)`);
      progress = await this.storage.getProgress();
    }
    let through = progress.projectedThroughBlock ?? progress.floorBlock! - 1n;
    result.projectedThroughBlock = through;

    if (Date.now() - this.lastLateScanAt >= this.lateScanIntervalMs) {
      const outcome = await this.refoldLateArrivals(progress.lateScanWatermark, through, progress.floorBlock);
      if (outcome === undefined) {
        result.lockHeldElsewhere = true;
        return result;
      }
      result.lateKeysRefolded = outcome;
      this.lastLateScanAt = Date.now();
    }

    const startedAt = Date.now();
    while (through < head && Date.now() - startedAt < this.maxTickMs) {
      const chunkStart = Date.now();
      const chunkEnd = await this.storage.planChunkEnd(through, head, this.maxOpsPerChunk);
      const keys = await this.storage.keysTouchedBetween(through, chunkEnd);
      const folded = await this.foldChunk(keys, through, chunkEnd);
      if (folded === undefined) {
        result.lockHeldElsewhere = true;
        break;
      }
      result.chunksFolded += 1;
      result.entitiesRefolded += folded.entities;
      this.log(
        `entity index: folded blocks ${through + 1n}..${chunkEnd} (${folded.entities} entities, ` +
          `${folded.versions} versions) in ${Date.now() - chunkStart}ms; ${head - chunkEnd} blocks behind the scanner`,
      );
      through = chunkEnd;
      result.projectedThroughBlock = through;
    }

    await this.maybeRefreshLiveEntities(
      through,
      result.chunksFolded > 0 || result.lateKeysRefolded > 0 || genesis.repaired > 0 || genesis.status === "done",
    );
    return result;
  }

  /**
   * Refold one chunk's keys and record the fold point, both under the lock.
   * Returns undefined when another projector held it.
   *
   * A failure carries the chunk it was folding. The fold point only moves on
   * success, so the same chunk is attempted again on the next tick; its block
   * range and key count are what identify the work that is stuck, and how much
   * of it there is.
   */
  private async foldChunk(
    keys: readonly string[],
    after: bigint,
    chunkEnd: bigint,
  ): Promise<{ entities: number; versions: number } | undefined> {
    try {
      return await this.storage.withFoldLock(async (client) => {
        const refold = await this.storage.refoldEntities(keys, chunkEnd, client);
        await this.storage.setProgress(
          { projectedThroughBlock: chunkEnd, lastFoldAt: new Date().toISOString() },
          client,
        );
        return refold;
      });
    } catch (error) {
      throw new Error(
        `folding blocks ${after + 1n}..${chunkEnd} (${keys.length} entity keys) failed: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Refold the keys of operations written since the watermark that sit at or
   * below the fold point. Returns how many keys were refolded, or undefined
   * when the lock was taken.
   *
   * A backfill walking towards genesis writes keyed creates *below* the
   * floor; those entities are folded like any late arrival, and the floor —
   * the oldest block the index vouches for — follows them down, unless it
   * was pinned by configuration.
   */
  private async refoldLateArrivals(
    watermark: string | undefined,
    through: bigint,
    floor: bigint | undefined,
  ): Promise<number | undefined> {
    const now = await this.storage.now();
    if (watermark === undefined) {
      await this.storage.setProgress({ lateScanWatermark: now });
      return 0;
    }
    const since = new Date(Date.parse(watermark) - this.lateScanOverlapMs).toISOString();
    const keys = await this.storage.keysScannedSince(since, through);
    if (keys.length > 0) {
      const folded = await this.storage.withFoldLock((client) => this.storage.refoldEntities(keys, through, client));
      if (folded === undefined) return undefined;
      this.log(`entity index: refolded ${folded.entities} entities whose operations arrived below block ${through}`);
      if (this.floorOverride === undefined && floor !== undefined) {
        const detected = await this.storage.detectFloorBlock();
        if (detected !== undefined && detected < floor) {
          await this.storage.setProgress({ floorBlock: detected });
          this.log(`entity index: floor lowered to block ${detected} (keyed creates arrived below block ${floor})`);
        }
      }
    }
    await this.storage.setProgress({ lateScanWatermark: now });
    return keys.length;
  }

  /**
   * Count the live entities for `/health` — on this loop's schedule, never a
   * request's: a count over the live rows is instant on a small index and
   * seconds on a big one. Taken once at startup, then only after a tick that
   * changed the index, no more often than the configured interval, and a
   * slow count keeps its distance from the next.
   */
  private async maybeRefreshLiveEntities(through: bigint | undefined, changed: boolean): Promise<void> {
    if (through === undefined) return;
    if (this.lastLiveCountAt !== 0) {
      if (!changed) return;
      const spacing = Math.max(this.liveCountIntervalMs, LIVE_COUNT_DUTY_FACTOR * this.lastLiveCountMs);
      if (Date.now() - this.lastLiveCountAt < spacing) return;
    }
    const reading = await this.storage.refreshLiveEntities(through);
    this.lastLiveCountAt = Date.now();
    this.lastLiveCountMs = reading.ms;
  }

  // -------------------------------------------------------------------------
  // The genesis import

  private warnOnce(key: string, message: string): void {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.log(message);
  }

  private async runGenesisStage(): Promise<GenesisStageOutcome> {
    const state = await this.storage.getGenesisImport();
    if (state === undefined) return this.probeGenesis();
    if (this.progressWriter && this.progressTrackedImport !== state.startedAt) this.publishGenesis(state);
    if (state.status !== "running") return { ...GENESIS_IDLE, status: state.status };
    return state.phase === "repair" ? this.repairGenesis(state) : this.walkGenesis(state);
  }

  /**
   * Render `state` into the progress file. The offline importer owns the file
   * while it loads a dump (`dump`/`walk`), so that state is left alone.
   */
  private publishGenesis(state: GenesisImportState): void {
    if (!this.progressWriter) return;
    if (state.source === "dump" && state.phase === "walk") return;
    if (!this.progressTracker || this.progressTrackedImport !== state.startedAt) {
      this.progressTracker = new GenesisProgressTracker({
        writer: "backend",
        source: state.source,
        startedAt: Date.parse(state.startedAt) || Date.now(),
      });
      this.progressTrackedImport = state.startedAt;
      this.progressPages = 0;
      this.progressAttributes = 0;
      this.progressRepairBatches = 0;
      this.progressRepaired = 0;
    }
    const tracker = this.progressTracker;
    const doc = tracker.doc;
    doc.status = state.status;
    doc.source = state.source;
    doc.chain_id = state.chainId === null ? null : Number(state.chainId);
    doc.genesis_hash = state.genesisHash;
    doc.error = state.error;
    doc.entities.total = state.total;
    doc.entities.imported = state.imported;
    doc.entities.attributes = this.progressAttributes;
    if (state.source === "rpc" && this.genesis.source) {
      doc.rpc = { url: this.genesis.source.url ?? "", pages: this.progressPages, page_size: this.genesis.pageSize };
    }
    if (state.phase === "repair" || state.status === "done") {
      doc.repair = { keys_refolded: this.progressRepaired, batches: this.progressRepairBatches };
    }
    tracker.setPhase(genesisProgressPhase(state));
    tracker.sample();
    void this.progressWriter.write(tracker.snapshot());
  }

  /**
   * Ask the node whether block 0 holds entities, once, and record the answer
   * as the import's starting state. A node that cannot be reached is asked
   * again later; one that answers is never asked again (the row is there).
   */
  private async probeGenesis(): Promise<GenesisStageOutcome> {
    const source = this.genesis.source;
    if (!source || this.genesis.mode === "off") return GENESIS_IDLE;
    if (this.floorOverride !== undefined && this.floorOverride > 0n) {
      this.warnOnce("pinned-floor", `entity index: genesis import skipped; the floor is pinned at block ${this.floorOverride}`);
      return GENESIS_IDLE;
    }
    if (this.lastProbeAt !== 0 && Date.now() - this.lastProbeAt < this.genesis.probeRetryMs) return GENESIS_IDLE;

    const now = new Date().toISOString();
    const blank: GenesisImportState = {
      status: "none",
      phase: null,
      source: null,
      chainId: null,
      genesisHash: null,
      total: 0,
      imported: 0,
      cursor: null,
      repairAfterKey: null,
      startedAt: now,
      finishedAt: null,
      error: null,
    };
    let next: GenesisImportState;
    try {
      const chain = await source.describe();
      const identity = { chainId: chain.chainId.toString(), genesisHash: chain.genesisHash };
      const indexedChainId = await this.storage.getScannerChainId();
      const indexedGenesisHash = await this.storage.getStoredBlockHash(0n);
      if (indexedChainId !== undefined && indexedChainId !== chain.chainId) {
        next = {
          ...blank,
          ...identity,
          status: "failed",
          finishedAt: now,
          error: `the genesis source is chain ${chain.chainId}; the index holds chain ${indexedChainId}`,
        };
      } else if (indexedGenesisHash !== undefined && chain.genesisHash !== null && indexedGenesisHash !== chain.genesisHash) {
        next = {
          ...blank,
          ...identity,
          status: "failed",
          finishedAt: now,
          error: `the genesis source's block 0 is ${chain.genesisHash}; the indexed chain's is ${indexedGenesisHash}`,
        };
      } else {
        const total = await source.count();
        if (total === 0) {
          next = { ...blank, ...identity, status: "none", finishedAt: now };
        } else if (total > MAX_GENESIS_POSITION) {
          next = {
            ...blank,
            ...identity,
            total,
            status: "failed",
            finishedAt: now,
            error: `${total} genesis entities exceed the index's position range`,
          };
        } else if (total > this.genesis.rpcLimit) {
          next = { ...blank, ...identity, total, status: "waiting" };
        } else {
          next = { ...blank, ...identity, total, status: "running", phase: "walk", source: "rpc" };
        }
      }
    } catch (error) {
      if (error instanceof GenesisSourceUnavailable) {
        next = { ...blank, status: "unavailable", finishedAt: now, error: error.message };
      } else {
        this.lastProbeAt = Date.now();
        this.log(
          `entity index: genesis probe could not reach the node; retrying in ${this.genesis.probeRetryMs}ms: ${describeError(error)}`,
        );
        return GENESIS_IDLE;
      }
    }

    const written = await this.storage.withFoldLock(async (client) => {
      if ((await this.storage.getGenesisImport(client)) !== undefined) return false;
      await this.storage.setGenesisImport(next, client);
      return true;
    });
    if (written === undefined) return { ...GENESIS_IDLE, lockHeldElsewhere: true };
    if (!written) return { ...GENESIS_IDLE, blocked: true }; // another backend recorded its probe first; read it next tick
    this.log(describeProbe(next, this.genesis.rpcLimit));
    this.publishGenesis(next);
    if (next.status !== "running") return { ...GENESIS_IDLE, status: next.status };
    return this.walkGenesis(next);
  }

  /** Page the genesis entities in from the node, committing a batch at a time, until the tick's budget is spent. */
  private async walkGenesis(state: GenesisImportState): Promise<GenesisStageOutcome> {
    const blocked: GenesisStageOutcome = { ...GENESIS_IDLE, status: "running", blocked: true };
    if (state.source !== "rpc") return blocked; // the offline importer owns this walk
    const source = this.genesis.source;
    if (!source) {
      this.warnOnce(
        "no-source",
        "entity index: a genesis import from the node is in progress but no node is configured " +
          "(ENTITY_INDEX_GENESIS_RPC or SHADOW_RPC_UPSTREAM); it cannot continue",
      );
      return blocked;
    }
    const startedAt = Date.now();
    let importedNow = 0;
    let expected = { cursor: state.cursor, imported: state.imported };
    let pending: EntityVersion[] = [];
    let pendingCursor = state.cursor;
    let pendingImported = state.imported;

    // Commit what is pending, provided the row still says what this loop last
    // wrote (another backend may have moved it); `finished` hands over to the
    // repair phase in the same transaction as the last rows.
    const commit = async (finished: boolean): Promise<"ok" | "moved" | "lock"> => {
      const rows = pending;
      const cursor = finished ? null : pendingCursor;
      const imported = pendingImported;
      const seen = expected;
      const outcome = await this.storage.withFoldLock(async (client) => {
        const current = await this.storage.getGenesisImport(client);
        if (
          !current ||
          current.status !== "running" ||
          current.phase !== "walk" ||
          current.source !== "rpc" ||
          current.imported !== seen.imported ||
          current.cursor !== seen.cursor
        ) {
          return "moved" as const;
        }
        await this.storage.insertGenesisVersions(rows, client);
        await this.storage.setGenesisImport(
          { ...current, imported, cursor, ...(finished ? { phase: "repair" as const } : {}) },
          client,
        );
        return "ok" as const;
      });
      if (outcome === undefined) return "lock";
      if (outcome === "ok") {
        expected = { cursor, imported };
        importedNow += rows.length;
        pending = [];
      }
      return outcome;
    };

    const walk = walkGenesisEntities(source, {
      cursor: state.cursor,
      imported: state.imported,
      total: state.total,
      pageSize: this.genesis.pageSize,
    });
    try {
      for await (const page of walk) {
        this.progressPages += 1;
        for (const version of page.versions) this.progressAttributes += version.attributes.length;
        pending.push(...page.versions);
        pendingCursor = page.cursor;
        pendingImported = page.imported;
        const last = page.cursor === null;
        if (last && page.imported !== state.total) {
          throw new GenesisEntityError(
            undefined,
            `the walk ended after ${page.imported} of the ${state.total} entities counted at block 0`,
          );
        }
        const outOfTime = Date.now() - startedAt >= this.maxTickMs;
        if (pending.length < this.genesis.batchEntities && !last && !outOfTime) continue;
        const outcome = await commit(last);
        if (outcome === "lock") return { ...blocked, imported: importedNow, lockHeldElsewhere: true };
        if (outcome === "moved") {
          this.log("entity index: the genesis import moved under this projector; reading it again next tick");
          return { ...blocked, imported: importedNow };
        }
        this.log(
          `entity index: imported genesis entities ${pendingImported.toLocaleString("en-US")} / ` +
            `${state.total.toLocaleString("en-US")} (${Date.now() - startedAt}ms into this tick)`,
        );
        this.publishGenesis({ ...state, imported: pendingImported, cursor: last ? null : pendingCursor, ...(last ? { phase: "repair" } : {}) });
        if (last) break;
        if (outOfTime || this.stopped) {
          if (this.stopped) this.log("entity index: stopping; the genesis walk resumes from its cursor on the next start");
          await walk.return();
          return { ...blocked, imported: importedNow };
        }
      }
    } catch (error) {
      if (error instanceof GenesisEntityError || error instanceof GenesisRpcError || error instanceof GenesisSourceUnavailable) {
        await this.failGenesis(error.message);
        return { ...GENESIS_IDLE, status: "failed", imported: importedNow };
      }
      throw error; // a transport failure: reported, and the next tick resumes from the stored cursor
    }
    this.log(`entity index: all ${state.total.toLocaleString("en-US")} genesis entities are in; refolding those with later operations`);
    const handed = await this.storage.getGenesisImport();
    if (!handed || handed.status !== "running" || handed.phase !== "repair") return { ...blocked, imported: importedNow };
    const repair = await this.repairGenesis(handed);
    return { ...repair, imported: importedNow };
  }

  private async failGenesis(message: string): Promise<void> {
    const failed = await this.storage.withFoldLock(async (client) => {
      const current = await this.storage.getGenesisImport(client);
      if (!current || current.status !== "running") return undefined;
      const next: GenesisImportState = { ...current, status: "failed", phase: null, finishedAt: new Date().toISOString(), error: message };
      await this.storage.setGenesisImport(next, client);
      return next;
    });
    this.log(`entity index: genesis import failed: ${message}`);
    if (failed) this.publishGenesis(failed);
  }

  /**
   * Every genesis row is in. Vouch for block 0, then refold the genesis
   * entities that also have operations — on top of their base now — a batch
   * at a time, resuming from the last key on the next tick if the budget runs
   * out. Shared by both importers: the offline one hands over here too.
   */
  private async repairGenesis(state: GenesisImportState): Promise<GenesisStageOutcome> {
    const blocked: GenesisStageOutcome = { ...GENESIS_IDLE, status: "running", blocked: true };
    const startedAt = Date.now();
    const floored = await this.storage.withFoldLock(async (client) => {
      const current = await this.storage.getGenesisImport(client);
      if (!current || current.status !== "running" || current.phase !== "repair") return "moved" as const;
      const progress = await this.storage.getProgress();
      if (progress.floorBlock !== undefined && progress.floorBlock === 0n) return "ok" as const;
      if (progress.floorBlock !== undefined) {
        const keyless = await this.storage.countKeylessCreatesBelow(progress.floorBlock);
        if (keyless > 0) {
          this.log(
            `entity index: warning: ${keyless} create operations below block ${progress.floorBlock} carry no entity key, ` +
              "so those entities stay unknown to the index even though its floor is now block 0",
          );
        }
      }
      await this.storage.setProgress(
        {
          floorBlock: 0n,
          ...(progress.projectedThroughBlock === undefined ? { projectedThroughBlock: 0n } : {}),
          ...(progress.lateScanWatermark === undefined ? { lateScanWatermark: await this.storage.now() } : {}),
        },
        client,
      );
      this.log("entity index: floor set to block 0 (the genesis entities are in)");
      return "ok" as const;
    });
    if (floored === undefined) return { ...blocked, lockHeldElsewhere: true };
    if (floored === "moved") return blocked;

    const through = (await this.storage.getProgress()).projectedThroughBlock ?? 0n;
    let after = state.repairAfterKey;
    let repaired = 0;
    for (;;) {
      const keys = await this.storage.genesisKeysWithOperations(through, after, this.genesis.batchEntities);
      const finished = keys.length < this.genesis.batchEntities;
      const expectedAfter = after;
      const outcome = await this.storage.withFoldLock(async (client) => {
        const current = await this.storage.getGenesisImport(client);
        if (!current || current.status !== "running" || current.phase !== "repair" || current.repairAfterKey !== expectedAfter) {
          return "moved" as const;
        }
        if (keys.length > 0) await this.storage.refoldEntities(keys, through, client);
        await this.storage.setGenesisImport(
          finished
            ? { ...current, status: "done", phase: null, repairAfterKey: null, finishedAt: new Date().toISOString() }
            : { ...current, repairAfterKey: keys[keys.length - 1]! },
          client,
        );
        return "ok" as const;
      });
      if (outcome === undefined) return { ...blocked, repaired, lockHeldElsewhere: true };
      if (outcome === "moved") return { ...blocked, repaired };
      repaired += keys.length;
      this.progressRepaired += keys.length;
      this.progressRepairBatches += 1;
      this.publishGenesis(
        finished
          ? { ...state, status: "done", phase: null, repairAfterKey: null, finishedAt: new Date().toISOString() }
          : { ...state, repairAfterKey: keys[keys.length - 1]! },
      );
      if (finished) {
        this.log(
          `entity index: genesis import done: ${state.total.toLocaleString("en-US")} entities, ` +
            `${repaired} of them refolded with their later operations`,
        );
        return { ...GENESIS_IDLE, status: "done", repaired };
      }
      after = keys[keys.length - 1]!;
      if (this.stopped || Date.now() - startedAt >= this.maxTickMs) return { ...blocked, repaired };
    }
  }
}

function genesisProgressPhase(state: GenesisImportState): GenesisProgressPhase {
  switch (state.status) {
    case "running":
      return state.phase === "repair" ? "repairing" : "walking";
    case "waiting":
      return "waiting";
    case "unavailable":
      return "unavailable";
    case "failed":
      return "failed";
    case "none":
    case "done":
      return "done";
  }
}

function describeProbe(state: GenesisImportState, rpcLimit: number): string {
  const total = state.total.toLocaleString("en-US");
  switch (state.status) {
    case "none":
      return "entity index: the chain holds no genesis entities";
    case "waiting":
      return (
        `entity index: ${total} genesis entities at block 0 are more than the RPC walk takes on ` +
        `(${rpcLimit.toLocaleString("en-US")}); waiting for scripts/importGenesisState.ts`
      );
    case "running":
      return `entity index: importing ${total} genesis entities from the node`;
    case "unavailable":
      return `entity index: genesis entities cannot be imported: ${state.error}`;
    case "failed":
      return `entity index: genesis import failed: ${state.error}`;
    case "done":
      return "entity index: genesis import done";
  }
}
