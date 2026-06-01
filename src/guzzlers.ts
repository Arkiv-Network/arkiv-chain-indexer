/**
 * Guzzlers: a database-free view of the most active senders over a set of
 * sliding time windows (see {@link GUZZLER_WINDOWS}).
 *
 * Statistics are aggregated into **one-minute buckets** per sender rather than
 * stored as individual transactions: every transaction folds into the bucket
 * for the minute it landed in, so a sender doing thousands of transactions a
 * minute costs a single bucket instead of thousands of rows. Buckets are
 * retained for {@link DEFAULT_GUZZLER_RETENTION_MS} (24 hours) and mirrored into
 * Redis (see {@link GuzzlerStore}) so the data survives a restart.
 *
 * The near-head scanner is the single writer. Once a minute it sweeps expired
 * buckets and recomputes the per-window leaderboards (the top
 * {@link GUZZLER_CACHE_LIMIT} senders), storing that response in Redis. The
 * backend server answers `/guzzlers` straight from that cached board — it never
 * rebuilds the leaderboards itself.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Width of a single statistics bucket: one minute. */
export const GUZZLER_BUCKET_MS = MINUTE_MS;

/** A predefined time window the guzzler API ranks senders over. */
export interface GuzzlerWindow {
  /** Stable identifier used in the API and the UI tabs (e.g. "5m", "24h"). */
  label: string;
  /** Window span in milliseconds. */
  ms: number;
}

/**
 * The leaderboards exposed by the API, ordered ascending by span. The largest
 * window doubles as the retention period — a bucket is kept only as long as it
 * can still contribute to some window. Keeping these nested (each window fully
 * contains the smaller ones) lets a single pass fill them all.
 */
export const GUZZLER_WINDOWS: readonly GuzzlerWindow[] = [
  { label: "5m", ms: 5 * MINUTE_MS },
  { label: "20m", ms: 20 * MINUTE_MS },
  { label: "1h", ms: HOUR_MS },
  { label: "6h", ms: 6 * HOUR_MS },
  { label: "24h", ms: 24 * HOUR_MS },
];

/** Retention period for bucket data: the largest tracked window (24 hours). */
export const DEFAULT_GUZZLER_RETENTION_MS = Math.max(...GUZZLER_WINDOWS.map((w) => w.ms));

/** Default number of top senders returned per window. */
export const DEFAULT_GUZZLER_LIMIT = 100;

/**
 * Upper bound on the per-window top-N a caller may request. The cached board is
 * computed at exactly this limit, so a request for more cannot be served and is
 * rejected.
 */
export const MAX_GUZZLER_LIMIT = 250;

/** Top-N senders per window persisted in the cached leaderboard response. */
export const GUZZLER_CACHE_LIMIT = MAX_GUZZLER_LIMIT;

/** Default cadence for the background sweep + cached-leaderboard refresh. */
export const DEFAULT_GUZZLER_SWEEP_INTERVAL_MS = 60 * 1000;

/** The data needed to fold a single transaction into a bucket. */
export interface GuzzlerTransactionInput {
  /** Block timestamp in milliseconds since the Unix epoch. */
  timestampMs: number;
  /** Gas used by the transaction, as a decimal string. */
  gasUsed: string;
  /** Transaction fee in wei, as a decimal string. */
  feeWei: string;
}

/** A transaction as surfaced by the scanner while ingesting a block. */
export interface GuzzlerBlockTransaction {
  from: string | null;
  hash: string;
  gasUsed: string;
  feeWei: string;
}

/**
 * One minute of aggregated activity for a sender. This is the unit stored in
 * Redis (a sender is a JSON array of these).
 */
export interface GuzzlerBucket {
  /** Epoch minute the bucket covers, i.e. `floor(timestampMs / 60000)`. */
  minute: number;
  /** Number of transactions folded into the bucket. */
  transactionCount: number;
  /** Total gas used across the bucket, as a decimal string. */
  totalGasUsed: string;
  /** Total fee in wei across the bucket, as a decimal string. */
  totalFeeWei: string;
  /** Earliest transaction timestamp folded into the bucket, in ms. */
  firstSeenMs: number;
  /** Latest transaction timestamp folded into the bucket, in ms. */
  lastSeenMs: number;
}

/** Aggregated statistics for a single guzzler over a window. */
export interface GuzzlerStat {
  address: string;
  transactionCount: number;
  totalGasUsed: string;
  totalFeeWei: string;
  /** ISO timestamp of the oldest retained transaction. */
  firstSeen: string;
  /** ISO timestamp of the newest retained transaction. */
  lastSeen: string;
}

/** One minute of a single sender's activity, shaped for a timeseries chart. */
export interface GuzzlerHistoryPoint {
  /** Epoch minute the point covers, i.e. `floor(timestampMs / 60000)`. */
  minute: number;
  /** Start of the minute bucket, as an ISO timestamp. */
  startTime: string;
  transactionCount: number;
  totalGasUsed: string;
  totalFeeWei: string;
  /** ISO timestamp of the earliest transaction in the minute. */
  firstSeen: string;
  /** ISO timestamp of the latest transaction in the minute. */
  lastSeen: string;
}

/** A single sender's per-minute history over the retention window. */
export interface GuzzlerHistory {
  address: string;
  generatedAt: string;
  /** How long buckets are retained — equal to the largest window. */
  retentionMs: number;
  /** Width of each point, in milliseconds (one minute). */
  bucketMs: number;
  /** Number of populated minutes returned. */
  count: number;
  /** Points ordered oldest-first, ready to plot. */
  points: GuzzlerHistoryPoint[];
}

/** Health metadata for the persisted guzzler bucket cache. */
export interface GuzzlerCacheSummary {
  /** Total number of one-minute buckets currently represented in the cache. */
  bucketCount: number;
  /** ISO timestamp for the oldest cached bucket start, or null when empty. */
  oldestBucket: string | null;
  /** ISO timestamp for the newest cached bucket start, or null when empty. */
  newestBucket: string | null;
}

/** The full guzzler statistics payload for a single window. */
export interface GuzzlerStatistics {
  windowMs: number;
  generatedAt: string;
  count: number;
  guzzlers: GuzzlerStat[];
}

/** The ranked senders for one window. */
export interface GuzzlerWindowLeaderboard {
  /** The window's stable identifier, e.g. "5m". */
  label: string;
  windowMs: number;
  /** Total senders active in this window, before the top-N cut. */
  count: number;
  /** The top-N senders for this window, by gas used descending. */
  guzzlers: GuzzlerStat[];
}

/** The full multi-window payload returned by the `/guzzlers` API. */
export interface GuzzlerLeaderboards {
  generatedAt: string;
  /** How long buckets are retained — equal to the largest window. */
  retentionMs: number;
  /** The top-N cut applied to each window. */
  limit: number;
  /** Metadata about the bucket cache at the time this board was generated. */
  cache: GuzzlerCacheSummary;
  windows: GuzzlerWindowLeaderboard[];
}

/** Size metrics for the persisted guzzler cache, surfaced via /health. */
export interface GuzzlerStoreStats {
  /** Number of senders currently held in the cache. */
  entryCount: number;
  /** Approximate total size of the cached entries, in bytes. */
  totalBytes: number;
}

/** Persistence boundary so the tracker can be backed by Redis (or a fake). */
export interface GuzzlerStore {
  /** Load every persisted sender and its retained buckets. */
  loadAll(): Promise<Map<string, GuzzlerBucket[]>>;
  /** Load a single sender's retained buckets, or null if none are cached. */
  loadSender(address: string): Promise<GuzzlerBucket[] | null>;
  /** Persist the full retained bucket list for a sender. */
  putSender(address: string, buckets: GuzzlerBucket[]): Promise<void>;
  /** Drop senders that no longer have any buckets in the window. */
  removeSenders(addresses: string[]): Promise<void>;
  /** Store the precomputed leaderboard response served to clients. */
  saveLeaderboards(board: GuzzlerLeaderboards): Promise<void>;
  /** Read the precomputed leaderboard response, or null if none is cached. */
  loadLeaderboards(): Promise<GuzzlerLeaderboards | null>;
  /** Report how many entries the cache holds and roughly how large it is. */
  stats(): Promise<GuzzlerStoreStats>;
  /** Release any underlying resources (connections, timers). */
  close(): Promise<void>;
}

/** The write-side contract the scanner depends on. */
export interface GuzzlerRecorder {
  recordBlock(
    blockTimestampMs: number,
    transactions: Iterable<GuzzlerBlockTransaction>,
  ): Promise<void>;
}

/** Lowercase an address so senders are tracked case-insensitively. */
export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Epoch minute a timestamp falls in. */
function minuteOf(timestampMs: number): number {
  return Math.floor(timestampMs / MINUTE_MS);
}

/**
 * Whether a parsed value is a well-formed {@link GuzzlerBucket}. Used to reject
 * malformed entries before they reach the tracker, where a missing `firstSeenMs`
 * would surface as an `Invalid Date`.
 */
export function isValidBucket(value: unknown): value is GuzzlerBucket {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const bucket = value as Record<string, unknown>;
  return (
    Number.isFinite(bucket.minute) &&
    Number.isFinite(bucket.transactionCount) &&
    typeof bucket.totalGasUsed === "string" &&
    typeof bucket.totalFeeWei === "string" &&
    Number.isFinite(bucket.firstSeenMs) &&
    Number.isFinite(bucket.lastSeenMs)
  );
}

/** Mutable in-memory form of a bucket; bigints avoid repeated string parsing. */
interface MutableBucket {
  minute: number;
  count: number;
  gas: bigint;
  fee: bigint;
  firstMs: number;
  lastMs: number;
}

function serializeBucket(bucket: MutableBucket): GuzzlerBucket {
  return {
    minute: bucket.minute,
    transactionCount: bucket.count,
    totalGasUsed: bucket.gas.toString(),
    totalFeeWei: bucket.fee.toString(),
    firstSeenMs: bucket.firstMs,
    lastSeenMs: bucket.lastMs,
  };
}

/**
 * In-memory tracker maintaining one-minute buckets per sender. Buckets whose
 * newest transaction has aged past the retention period are evicted; senders
 * whose bucket set becomes empty are dropped entirely.
 */
export class GuzzlerTracker {
  private readonly senders = new Map<string, Map<number, MutableBucket>>();

  constructor(private readonly retentionMs: number = DEFAULT_GUZZLER_RETENTION_MS) {}

  get retentionMilliseconds(): number {
    return this.retentionMs;
  }

  /** Number of senders currently retaining at least one bucket. */
  get senderCount(): number {
    return this.senders.size;
  }

  /** A bucket is expired once its newest transaction is out of retention. */
  private evictExpired(buckets: Map<number, MutableBucket>, nowMs: number): boolean {
    const cutoff = nowMs - this.retentionMs;
    let changed = false;
    for (const [minute, bucket] of buckets) {
      if (bucket.lastMs <= cutoff) {
        buckets.delete(minute);
        changed = true;
      }
    }
    return changed;
  }

  /** Fold a transaction into its sender's minute bucket, evicting expired ones. */
  record(address: string, tx: GuzzlerTransactionInput, nowMs: number): void {
    const key = normalizeAddress(address);
    let buckets = this.senders.get(key);
    if (!buckets) {
      buckets = new Map<number, MutableBucket>();
      this.senders.set(key, buckets);
    }

    const minute = minuteOf(tx.timestampMs);
    let bucket = buckets.get(minute);
    if (!bucket) {
      bucket = { minute, count: 0, gas: 0n, fee: 0n, firstMs: tx.timestampMs, lastMs: tx.timestampMs };
      buckets.set(minute, bucket);
    }
    bucket.count += 1;
    bucket.gas += toBigInt(tx.gasUsed);
    bucket.fee += toBigInt(tx.feeWei);
    if (tx.timestampMs < bucket.firstMs) bucket.firstMs = tx.timestampMs;
    if (tx.timestampMs > bucket.lastMs) bucket.lastMs = tx.timestampMs;

    this.evictExpired(buckets, nowMs);
    if (buckets.size === 0) {
      this.senders.delete(key);
    }
  }

  /**
   * Evict expired buckets across every sender.
   * @returns the addresses whose bucket set shrank (`updated`) or emptied (`removed`).
   */
  sweep(nowMs: number): { updated: string[]; removed: string[] } {
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [address, buckets] of this.senders) {
      const before = buckets.size;
      this.evictExpired(buckets, nowMs);
      if (buckets.size === 0) {
        this.senders.delete(address);
        removed.push(address);
      } else if (buckets.size !== before) {
        updated.push(address);
      }
    }
    return { updated, removed };
  }

  /** Restore a sender's retained buckets (e.g. from persistence). */
  loadSender(address: string, buckets: GuzzlerBucket[]): void {
    const map = new Map<number, MutableBucket>();
    for (const bucket of buckets) {
      if (!isValidBucket(bucket)) {
        continue;
      }
      map.set(bucket.minute, {
        minute: bucket.minute,
        count: bucket.transactionCount,
        gas: toBigInt(bucket.totalGasUsed),
        fee: toBigInt(bucket.totalFeeWei),
        firstMs: bucket.firstSeenMs,
        lastMs: bucket.lastSeenMs,
      });
    }
    if (map.size === 0) {
      return;
    }
    this.senders.set(normalizeAddress(address), map);
  }

  /** A sender's retained buckets sorted ascending by minute, or undefined. */
  getSenderBuckets(address: string): GuzzlerBucket[] | undefined {
    const buckets = this.senders.get(normalizeAddress(address));
    if (!buckets) {
      return undefined;
    }
    return [...buckets.values()].sort((a, b) => a.minute - b.minute).map(serializeBucket);
  }

  /**
   * Aggregate every sender's buckets over the full retention window, sorted by
   * gas used descending. Primarily for diagnostics and tests.
   */
  getStatistics(nowMs: number): GuzzlerStatistics {
    const cutoff = nowMs - this.retentionMs;
    const guzzlers: GuzzlerStat[] = [];

    for (const [address, buckets] of this.senders) {
      let count = 0;
      let gas = 0n;
      let fee = 0n;
      let firstSeen = Number.POSITIVE_INFINITY;
      let lastSeen = Number.NEGATIVE_INFINITY;
      for (const bucket of buckets.values()) {
        if (bucket.lastMs <= cutoff) {
          continue;
        }
        count += bucket.count;
        gas += bucket.gas;
        fee += bucket.fee;
        if (bucket.firstMs < firstSeen) firstSeen = bucket.firstMs;
        if (bucket.lastMs > lastSeen) lastSeen = bucket.lastMs;
      }
      if (count === 0) {
        continue;
      }

      guzzlers.push({
        address,
        transactionCount: count,
        totalGasUsed: gas.toString(),
        totalFeeWei: fee.toString(),
        firstSeen: new Date(firstSeen).toISOString(),
        lastSeen: new Date(lastSeen).toISOString(),
      });
    }

    guzzlers.sort(compareGuzzlers);

    return {
      windowMs: this.retentionMs,
      generatedAt: new Date(nowMs).toISOString(),
      count: guzzlers.length,
      guzzlers,
    };
  }

  /**
   * Rank senders for every window in {@link GUZZLER_WINDOWS} in a single pass.
   *
   * Because the windows are nested (ascending by span), each bucket is added to
   * the smallest window that still contains it and every larger one, keyed off
   * the bucket's newest transaction. One walk of a sender's buckets fills all
   * windows; each window is then sorted by gas used descending and cut to
   * `limit`.
   */
  getLeaderboards(
    nowMs: number,
    limit: number = DEFAULT_GUZZLER_LIMIT,
    windows: readonly GuzzlerWindow[] = GUZZLER_WINDOWS,
  ): GuzzlerLeaderboards {
    const safeLimit = Math.max(0, Math.floor(limit));
    const ranked: GuzzlerStat[][] = windows.map(() => []);
    let bucketCount = 0;
    let oldestMinute = Number.POSITIVE_INFINITY;
    let newestMinute = Number.NEGATIVE_INFINITY;

    for (const [address, buckets] of this.senders) {
      const acc = windows.map(() => ({
        count: 0,
        gas: 0n,
        fee: 0n,
        first: Number.POSITIVE_INFINITY,
        last: Number.NEGATIVE_INFINITY,
      }));

      for (const bucket of buckets.values()) {
        bucketCount += 1;
        if (bucket.minute < oldestMinute) oldestMinute = bucket.minute;
        if (bucket.minute > newestMinute) newestMinute = bucket.minute;

        const age = nowMs - bucket.lastMs;
        // Skip the leading windows too small to contain this bucket; once a
        // window includes it, every larger window does too.
        let start = 0;
        while (start < windows.length && windows[start]!.ms <= age) {
          start += 1;
        }
        if (start >= windows.length) {
          continue; // older than the largest window
        }
        for (let j = start; j < windows.length; j += 1) {
          const a = acc[j]!;
          a.count += bucket.count;
          a.gas += bucket.gas;
          a.fee += bucket.fee;
          if (bucket.firstMs < a.first) a.first = bucket.firstMs;
          if (bucket.lastMs > a.last) a.last = bucket.lastMs;
        }
      }

      for (let j = 0; j < windows.length; j += 1) {
        const a = acc[j]!;
        if (a.count === 0) {
          continue;
        }
        ranked[j]!.push({
          address,
          transactionCount: a.count,
          totalGasUsed: a.gas.toString(),
          totalFeeWei: a.fee.toString(),
          firstSeen: new Date(a.first).toISOString(),
          lastSeen: new Date(a.last).toISOString(),
        });
      }
    }

    return {
      generatedAt: new Date(nowMs).toISOString(),
      retentionMs: this.retentionMs,
      limit: safeLimit,
      cache: {
        bucketCount,
        oldestBucket:
          bucketCount > 0 ? new Date(oldestMinute * GUZZLER_BUCKET_MS).toISOString() : null,
        newestBucket:
          bucketCount > 0 ? new Date(newestMinute * GUZZLER_BUCKET_MS).toISOString() : null,
      },
      windows: windows.map((window, j) => {
        const bucket = ranked[j]!;
        bucket.sort(compareGuzzlers);
        return {
          label: window.label,
          windowMs: window.ms,
          count: bucket.length,
          guzzlers: bucket.slice(0, safeLimit),
        };
      }),
    };
  }
}

/** Rank by gas used desc, breaking ties by transaction count then address. */
function compareGuzzlers(a: GuzzlerStat, b: GuzzlerStat): number {
  return (
    compareBigIntDesc(a.totalGasUsed, b.totalGasUsed) ||
    b.transactionCount - a.transactionCount ||
    a.address.localeCompare(b.address)
  );
}

function compareBigIntDesc(a: string, b: string): number {
  const left = toBigInt(a);
  const right = toBigInt(b);
  if (left < right) return 1;
  if (left > right) return -1;
  return 0;
}

/** Return a copy of `board` with each window cut to the requested top-N. */
export function sliceLeaderboards(board: GuzzlerLeaderboards, limit: number): GuzzlerLeaderboards {
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    generatedAt: board.generatedAt,
    retentionMs: board.retentionMs,
    limit: safeLimit,
    cache: board.cache,
    windows: board.windows.map((window) => ({
      label: window.label,
      windowMs: window.windowMs,
      count: window.count,
      guzzlers: window.guzzlers.slice(0, safeLimit),
    })),
  };
}

/**
 * Build a single sender's per-minute history from its stored buckets: drop
 * anything aged past retention, order oldest-first, and shape each bucket as a
 * chart-ready point.
 */
export function buildGuzzlerHistory(
  address: string,
  buckets: GuzzlerBucket[],
  nowMs: number,
  retentionMs: number = DEFAULT_GUZZLER_RETENTION_MS,
): GuzzlerHistory {
  const cutoff = nowMs - retentionMs;
  const points = buckets
    .filter((bucket) => isValidBucket(bucket) && bucket.lastSeenMs > cutoff)
    .sort((a, b) => a.minute - b.minute)
    .map((bucket) => ({
      minute: bucket.minute,
      startTime: new Date(bucket.minute * GUZZLER_BUCKET_MS).toISOString(),
      transactionCount: bucket.transactionCount,
      totalGasUsed: bucket.totalGasUsed,
      totalFeeWei: bucket.totalFeeWei,
      firstSeen: new Date(bucket.firstSeenMs).toISOString(),
      lastSeen: new Date(bucket.lastSeenMs).toISOString(),
    }));

  return {
    address: normalizeAddress(address),
    generatedAt: new Date(nowMs).toISOString(),
    retentionMs,
    bucketMs: GUZZLER_BUCKET_MS,
    count: points.length,
    points,
  };
}

/** A well-formed, empty leaderboard payload (e.g. before the first refresh). */
export function emptyLeaderboards(
  nowMs: number,
  limit: number = DEFAULT_GUZZLER_LIMIT,
  windows: readonly GuzzlerWindow[] = GUZZLER_WINDOWS,
  retentionMs: number = DEFAULT_GUZZLER_RETENTION_MS,
): GuzzlerLeaderboards {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    retentionMs,
    limit: Math.max(0, Math.floor(limit)),
    cache: {
      bucketCount: 0,
      oldestBucket: null,
      newestBucket: null,
    },
    windows: windows.map((window) => ({
      label: window.label,
      windowMs: window.ms,
      count: 0,
      guzzlers: [],
    })),
  };
}
