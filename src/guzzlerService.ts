import {
  DEFAULT_GUZZLER_RETENTION_MS,
  DEFAULT_GUZZLER_SWEEP_INTERVAL_MS,
  GUZZLER_BUCKET_MS,
  GUZZLER_CACHE_LIMIT,
  GUZZLER_WINDOWS,
  GuzzlerTracker,
  isValidBucket,
  normalizeAddress,
  type GuzzlerBlockTransaction,
  type GuzzlerBucket,
  type GuzzlerRecorder,
  type GuzzlerStatistics,
  type GuzzlerStore,
  type GuzzlerWindow,
} from "./guzzlers";

export interface GuzzlerServiceOptions {
  retentionMs?: number;
  sweepIntervalMs?: number;
  /** Top-N senders per window stored in the cached leaderboard response. */
  cacheLimit?: number;
  windows?: readonly GuzzlerWindow[];
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Write-side owner of the guzzler tracker, used by the near-head scanner.
 *
 * It loads persisted buckets on {@link start}, folds each block's transactions
 * into per-minute buckets while mirroring changes to the {@link GuzzlerStore},
 * and once a minute sweeps expired buckets and recomputes the cached
 * leaderboard response (the top {@link GUZZLER_CACHE_LIMIT} senders per window)
 * that the API serves verbatim.
 */
export class GuzzlerService implements GuzzlerRecorder {
  private readonly tracker: GuzzlerTracker;
  private readonly retentionMs: number;
  private readonly sweepIntervalMs: number;
  private readonly cacheLimit: number;
  private readonly windows: readonly GuzzlerWindow[];
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly store: GuzzlerStore,
    options: GuzzlerServiceOptions = {},
  ) {
    this.retentionMs = options.retentionMs ?? DEFAULT_GUZZLER_RETENTION_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_GUZZLER_SWEEP_INTERVAL_MS;
    this.cacheLimit = options.cacheLimit ?? GUZZLER_CACHE_LIMIT;
    this.windows = options.windows ?? GUZZLER_WINDOWS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.tracker = new GuzzlerTracker(this.retentionMs);
  }

  /**
   * Load persisted buckets, drop anything already expired, publish an initial
   * cached leaderboard, and start the once-a-minute sweep + refresh loop.
   */
  async start(): Promise<void> {
    const all = await this.store.loadAll();
    for (const [address, buckets] of all) {
      this.tracker.loadSender(address, buckets);
    }
    const { updated, removed } = this.tracker.sweep(this.now());
    await this.persist(updated, removed);
    await this.refreshLeaderboards();
    this.log(`Guzzler tracker loaded ${this.tracker.senderCount.toString()} active sender(s)`);

    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.tick();
      }, this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  async recordBlock(
    blockTimestampMs: number,
    transactions: Iterable<GuzzlerBlockTransaction>,
  ): Promise<void> {
    const now = this.now();
    // Blocks older than retention can never contribute to any window (e.g.
    // historical backfill) — skip them entirely instead of writing churn.
    if (blockTimestampMs <= now - this.retentionMs) {
      return;
    }

    const bySender = new Map<string, GuzzlerBlockTransaction[]>();
    for (const tx of transactions) {
      if (!tx.from) {
        continue;
      }
      const address = normalizeAddress(tx.from);
      const senderTransactions = bySender.get(address) ?? [];
      senderTransactions.push(tx);
      bySender.set(address, senderTransactions);
    }

    if (bySender.size === 0) {
      return;
    }

    const updated = [...bySender].map(([address, senderTransactions]) => ({
      address,
      buckets: foldBlockTransactions(
        this.tracker.getSenderBuckets(address) ?? [],
        senderTransactions,
        blockTimestampMs,
        now,
        this.retentionMs,
      ),
    }));

    // Persist first. If Redis fails, the scanner retries the block and the
    // in-memory tracker has not been advanced, so retrying cannot double count.
    await Promise.all(updated.map(({ address, buckets }) => this.store.putSender(address, buckets)));

    for (const { address, buckets } of updated) {
      this.tracker.loadSender(address, buckets);
    }
  }

  /** Current in-memory statistics (primarily for diagnostics/tests). */
  getStatistics(nowMs: number = this.now()): GuzzlerStatistics {
    return this.tracker.getStatistics(nowMs);
  }

  /** The once-a-minute job: evict expired buckets, then refresh the cache. */
  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.sweep();
    await this.refreshLeaderboards();
  }

  /** Evict expired buckets and remove now-empty senders from the cache. */
  async sweep(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const { updated, removed } = this.tracker.sweep(this.now());
    if (updated.length === 0 && removed.length === 0) {
      return;
    }
    await this.persist(updated, removed);
    this.log(
      `Guzzler sweep: ${updated.length.toString()} updated, ${removed.length.toString()} removed (${this.tracker.senderCount.toString()} active)`,
    );
  }

  /** Recompute the top-N leaderboards and store them as the cached response. */
  async refreshLeaderboards(): Promise<void> {
    const board = this.tracker.getLeaderboards(this.now(), this.cacheLimit, this.windows);
    await this.store.saveLeaderboards(board);
  }

  private async persist(updated: string[], removed: string[]): Promise<void> {
    await Promise.all(
      updated.map((address) =>
        this.store.putSender(address, this.tracker.getSenderBuckets(address) ?? []),
      ),
    );
    if (removed.length > 0) {
      await this.store.removeSenders(removed);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.store.close();
  }
}

interface MutableBucketDraft {
  minute: number;
  transactionCount: number;
  totalGasUsed: bigint;
  totalFeeWei: bigint;
  firstSeenMs: number;
  lastSeenMs: number;
}

function foldBlockTransactions(
  currentBuckets: GuzzlerBucket[],
  transactions: GuzzlerBlockTransaction[],
  blockTimestampMs: number,
  nowMs: number,
  retentionMs: number,
): GuzzlerBucket[] {
  const cutoff = nowMs - retentionMs;
  const buckets = new Map<number, MutableBucketDraft>();

  for (const bucket of currentBuckets) {
    if (!isValidBucket(bucket) || bucket.lastSeenMs <= cutoff) {
      continue;
    }
    buckets.set(bucket.minute, {
      minute: bucket.minute,
      transactionCount: bucket.transactionCount,
      totalGasUsed: toBigInt(bucket.totalGasUsed),
      totalFeeWei: toBigInt(bucket.totalFeeWei),
      firstSeenMs: bucket.firstSeenMs,
      lastSeenMs: bucket.lastSeenMs,
    });
  }

  const minute = Math.floor(blockTimestampMs / GUZZLER_BUCKET_MS);
  let bucket = buckets.get(minute);
  if (!bucket) {
    bucket = {
      minute,
      transactionCount: 0,
      totalGasUsed: 0n,
      totalFeeWei: 0n,
      firstSeenMs: blockTimestampMs,
      lastSeenMs: blockTimestampMs,
    };
    buckets.set(minute, bucket);
  }

  for (const tx of transactions) {
    bucket.transactionCount += 1;
    bucket.totalGasUsed += toBigInt(tx.gasUsed);
    bucket.totalFeeWei += toBigInt(tx.feeWei);
    if (blockTimestampMs < bucket.firstSeenMs) bucket.firstSeenMs = blockTimestampMs;
    if (blockTimestampMs > bucket.lastSeenMs) bucket.lastSeenMs = blockTimestampMs;
  }

  return [...buckets.values()]
    .sort((a, b) => a.minute - b.minute)
    .map((bucket) => ({
      minute: bucket.minute,
      transactionCount: bucket.transactionCount,
      totalGasUsed: bucket.totalGasUsed.toString(),
      totalFeeWei: bucket.totalFeeWei.toString(),
      firstSeenMs: bucket.firstSeenMs,
      lastSeenMs: bucket.lastSeenMs,
    }));
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
