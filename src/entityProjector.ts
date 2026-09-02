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
 * Every write happens under a transaction-scoped advisory lock, so two
 * backends pointed at one schema cannot fold on top of each other: the second
 * simply finds the lock taken and tries again next tick.
 */
import type { EntityIndexStorage } from "./entityIndexStorage";

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
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_OPS_PER_CHUNK = 20_000;
const DEFAULT_LATE_SCAN_INTERVAL_MS = 60_000;
const DEFAULT_LATE_SCAN_OVERLAP_MS = 120_000;
const DEFAULT_MAX_TICK_MS = 30_000;

export class EntityProjector {
  private readonly pollMs: number;
  private readonly maxOpsPerChunk: number;
  private readonly lateScanIntervalMs: number;
  private readonly lateScanOverlapMs: number;
  private readonly maxTickMs: number;
  private readonly floorOverride: bigint | undefined;
  private readonly log: (message: string) => void;
  private readonly onError: (error: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<EntityProjectorTick> | undefined;
  private stopped = false;
  private lastLateScanAt = 0;

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
    this.log = options.log ?? ((message) => console.log(message));
    this.onError = options.onError ?? ((error) => console.error("entity index: fold failed:", error));
  }

  /** Fold on a loop until {@link stop}. */
  start(): void {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (error) {
        this.onError(error);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollMs);
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

  /** One tick: late arrivals first, then as many forward chunks as the budget allows. */
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
    };
    const head = await this.storage.getIndexedHead();
    result.head = head;
    if (head === undefined) return result;

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
      const folded = await this.storage.withFoldLock(async (client) => {
        const refold = await this.storage.refoldEntities(keys, chunkEnd, client);
        await this.storage.setProgress(
          { projectedThroughBlock: chunkEnd, lastFoldAt: new Date().toISOString() },
          client,
        );
        return refold;
      });
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
    return result;
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
}
