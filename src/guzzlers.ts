import Denque from "denque";

/**
 * Guzzlers: an in-memory, database-free view of the most active senders over a
 * set of sliding time windows (see {@link GUZZLER_WINDOWS}).
 *
 * Unlike the Postgres-backed `sender_stats` aggregation, guzzler statistics are
 * computed entirely from in-memory per-sender deques (one {@link Denque} per
 * address). The cache retains transactions for as long as the largest window
 * ({@link DEFAULT_GUZZLER_WINDOW_MS}); a single pass over a sender's retained
 * transactions then aggregates them into every window at once. The deques are
 * mirrored into Redis (see {@link GuzzlerStore}) so the data survives a restart.
 *
 * The near-head scanner is the single writer; the backend server reads the
 * persisted state to answer the `/guzzlers` API.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A predefined time window the guzzler API ranks senders over. */
export interface GuzzlerWindow {
  /** Stable identifier used in the API and the UI tabs (e.g. "5m", "24h"). */
  label: string;
  /** Window span in milliseconds. */
  ms: number;
}

/**
 * The leaderboards exposed by the API, ordered ascending by span. The largest
 * window doubles as the cache retention period — a transaction is kept only as
 * long as it can still contribute to some window. Keeping these nested (each
 * window fully contains the smaller ones) lets a single pass fill them all.
 */
export const GUZZLER_WINDOWS: readonly GuzzlerWindow[] = [
  { label: "5m", ms: 5 * MINUTE_MS },
  { label: "20m", ms: 20 * MINUTE_MS },
  { label: "1h", ms: HOUR_MS },
  { label: "6h", ms: 6 * HOUR_MS },
  { label: "24h", ms: 24 * HOUR_MS },
];

/** Default retention window: the largest tracked window. */
export const DEFAULT_GUZZLER_WINDOW_MS = Math.max(...GUZZLER_WINDOWS.map((w) => w.ms));

/** Default number of top senders returned per window. */
export const DEFAULT_GUZZLER_LIMIT = 100;

/** Upper bound on the per-window top-N a caller may request. */
export const MAX_GUZZLER_LIMIT = 1000;

/** Default cadence for the background sweep that evicts expired transactions. */
export const DEFAULT_GUZZLER_SWEEP_INTERVAL_MS = 60 * 1000;

/** A single transaction retained for a sender. */
export interface GuzzlerTransaction {
  hash: string;
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

/** Aggregated statistics for a single guzzler over the active window. */
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
  /** How long transactions are retained — equal to the largest window. */
  retentionMs: number;
  /** The top-N cut applied to each window. */
  limit: number;
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
  /** Load every persisted sender and its retained transactions. */
  loadAll(): Promise<Map<string, GuzzlerTransaction[]>>;
  /** Persist the full retained transaction list for a sender. */
  putSender(address: string, txs: GuzzlerTransaction[]): Promise<void>;
  /** Drop senders that no longer have any transactions in the window. */
  removeSenders(addresses: string[]): Promise<void>;
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

/**
 * In-memory tracker maintaining one {@link Denque} of recent transactions per
 * sender. Transactions older than the window are evicted from the front of each
 * deque; senders whose deque becomes empty are dropped entirely.
 */
export class GuzzlerTracker {
  private readonly senders = new Map<string, Denque<GuzzlerTransaction>>();

  constructor(private readonly windowMs: number = DEFAULT_GUZZLER_WINDOW_MS) {}

  get windowMilliseconds(): number {
    return this.windowMs;
  }

  /** Number of senders currently retaining at least one transaction. */
  get senderCount(): number {
    return this.senders.size;
  }

  private cutoff(nowMs: number): number {
    return nowMs - this.windowMs;
  }

  private evictExpired(deque: Denque<GuzzlerTransaction>, nowMs: number): void {
    const cutoff = this.cutoff(nowMs);
    while (!deque.isEmpty()) {
      const front = deque.peekFront();
      if (front !== undefined && front.timestampMs <= cutoff) {
        deque.shift();
      } else {
        break;
      }
    }
  }

  /** Record a transaction for a sender, evicting anything now out of window. */
  record(address: string, tx: GuzzlerTransaction, nowMs: number): void {
    const key = normalizeAddress(address);
    let deque = this.senders.get(key);
    if (!deque) {
      deque = new Denque<GuzzlerTransaction>();
      this.senders.set(key, deque);
    }
    deque.push(tx);
    this.evictExpired(deque, nowMs);
    if (deque.isEmpty()) {
      this.senders.delete(key);
    }
  }

  /**
   * Evict expired transactions across every sender.
   * @returns the addresses whose deque shrank (`updated`) or emptied (`removed`).
   */
  sweep(nowMs: number): { updated: string[]; removed: string[] } {
    const updated: string[] = [];
    const removed: string[] = [];
    for (const [address, deque] of this.senders) {
      const before = deque.length;
      this.evictExpired(deque, nowMs);
      if (deque.isEmpty()) {
        this.senders.delete(address);
        removed.push(address);
      } else if (deque.length !== before) {
        updated.push(address);
      }
    }
    return { updated, removed };
  }

  /** Restore a sender's retained transactions (e.g. from persistence). */
  loadSender(address: string, txs: GuzzlerTransaction[]): void {
    if (txs.length === 0) {
      return;
    }
    const ordered = txs.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    this.senders.set(normalizeAddress(address), new Denque<GuzzlerTransaction>(ordered));
  }

  /** The retained transactions for a sender, or undefined if it has none. */
  getSenderTransactions(address: string): GuzzlerTransaction[] | undefined {
    return this.senders.get(normalizeAddress(address))?.toArray();
  }

  /**
   * Compute statistics for every sender with at least one transaction in the
   * window, sorted by gas used descending (the biggest guzzlers first).
   */
  getStatistics(nowMs: number): GuzzlerStatistics {
    const cutoff = this.cutoff(nowMs);
    const guzzlers: GuzzlerStat[] = [];

    for (const [address, deque] of this.senders) {
      const txs = deque.toArray().filter((tx) => tx.timestampMs > cutoff);
      if (txs.length === 0) {
        continue;
      }

      let totalGas = 0n;
      let totalFee = 0n;
      let firstSeen = Number.POSITIVE_INFINITY;
      let lastSeen = Number.NEGATIVE_INFINITY;
      for (const tx of txs) {
        totalGas += toBigInt(tx.gasUsed);
        totalFee += toBigInt(tx.feeWei);
        if (tx.timestampMs < firstSeen) firstSeen = tx.timestampMs;
        if (tx.timestampMs > lastSeen) lastSeen = tx.timestampMs;
      }

      guzzlers.push({
        address,
        transactionCount: txs.length,
        totalGasUsed: totalGas.toString(),
        totalFeeWei: totalFee.toString(),
        firstSeen: new Date(firstSeen).toISOString(),
        lastSeen: new Date(lastSeen).toISOString(),
      });
    }

    guzzlers.sort(
      (a, b) =>
        compareBigIntDesc(a.totalGasUsed, b.totalGasUsed) ||
        b.transactionCount - a.transactionCount ||
        a.address.localeCompare(b.address),
    );

    return {
      windowMs: this.windowMs,
      generatedAt: new Date(nowMs).toISOString(),
      count: guzzlers.length,
      guzzlers,
    };
  }

  /**
   * Rank senders for every window in {@link GUZZLER_WINDOWS} in a single pass.
   *
   * Because the windows are nested (ascending by span), each transaction is
   * added to the smallest window that still contains it and every larger one,
   * so one walk of a sender's deque fills all windows. Each window is then
   * sorted by gas used descending and cut to `limit`.
   */
  getLeaderboards(
    nowMs: number,
    limit: number = DEFAULT_GUZZLER_LIMIT,
    windows: readonly GuzzlerWindow[] = GUZZLER_WINDOWS,
  ): GuzzlerLeaderboards {
    const safeLimit = Math.max(0, Math.floor(limit));
    const buckets: GuzzlerStat[][] = windows.map(() => []);

    for (const [address, deque] of this.senders) {
      const acc = windows.map(() => ({
        count: 0,
        gas: 0n,
        fee: 0n,
        first: Number.POSITIVE_INFINITY,
        last: Number.NEGATIVE_INFINITY,
      }));

      for (const tx of deque.toArray()) {
        const age = nowMs - tx.timestampMs;
        // Skip the leading windows too small to contain this transaction; once
        // a window includes it, every larger window does too.
        let start = 0;
        while (start < windows.length && windows[start]!.ms <= age) {
          start += 1;
        }
        if (start >= windows.length) {
          continue; // older than the largest window
        }
        const gas = toBigInt(tx.gasUsed);
        const fee = toBigInt(tx.feeWei);
        for (let j = start; j < windows.length; j += 1) {
          const a = acc[j]!;
          a.count += 1;
          a.gas += gas;
          a.fee += fee;
          if (tx.timestampMs < a.first) a.first = tx.timestampMs;
          if (tx.timestampMs > a.last) a.last = tx.timestampMs;
        }
      }

      for (let j = 0; j < windows.length; j += 1) {
        const a = acc[j]!;
        if (a.count === 0) {
          continue;
        }
        buckets[j]!.push({
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
      retentionMs: this.windowMs,
      limit: safeLimit,
      windows: windows.map((window, j) => {
        const bucket = buckets[j]!;
        bucket.sort(
          (a, b) =>
            compareBigIntDesc(a.totalGasUsed, b.totalGasUsed) ||
            b.transactionCount - a.transactionCount ||
            a.address.localeCompare(b.address),
        );
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

function compareBigIntDesc(a: string, b: string): number {
  const left = toBigInt(a);
  const right = toBigInt(b);
  if (left < right) return 1;
  if (left > right) return -1;
  return 0;
}

/**
 * Read-side helper used by the API: rebuild a tracker from persisted state,
 * drop anything that has aged out, and return the per-window leaderboards. This
 * never mutates Redis — cleanup of the persisted set is the writer's
 * responsibility.
 */
export async function readGuzzlerLeaderboards(
  store: GuzzlerStore,
  nowMs: number,
  limit: number = DEFAULT_GUZZLER_LIMIT,
  windows: readonly GuzzlerWindow[] = GUZZLER_WINDOWS,
  retentionMs: number = DEFAULT_GUZZLER_WINDOW_MS,
): Promise<GuzzlerLeaderboards> {
  const all = await store.loadAll();
  const tracker = new GuzzlerTracker(retentionMs);
  for (const [address, txs] of all) {
    tracker.loadSender(address, txs);
  }
  tracker.sweep(nowMs);
  return tracker.getLeaderboards(nowMs, limit, windows);
}

/** Default lifetime of a cached leaderboard before it is recomputed. */
export const DEFAULT_GUZZLER_CACHE_TTL_MS = 5000;

/** Return a copy of `board` with each window cut to the requested top-N. */
function sliceLeaderboards(board: GuzzlerLeaderboards, limit: number): GuzzlerLeaderboards {
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    generatedAt: board.generatedAt,
    retentionMs: board.retentionMs,
    limit: safeLimit,
    windows: board.windows.map((window) => ({
      label: window.label,
      windowMs: window.windowMs,
      count: window.count,
      guzzlers: window.guzzlers.slice(0, safeLimit),
    })),
  };
}

export interface GuzzlerLeaderboardCacheOptions {
  /** How long a computed board is reused before recomputing. */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  windows?: readonly GuzzlerWindow[];
  retentionMs?: number;
}

/**
 * Server-side cache for the guzzler leaderboards.
 *
 * Recomputing a leaderboard means pulling the entire persisted dataset out of
 * Redis (a full `HGETALL` of up to {@link DEFAULT_GUZZLER_WINDOW_MS} of senders)
 * and rebuilding a tracker from scratch — far too costly to repeat on every
 * request. This caches the fully ranked board (computed at
 * {@link MAX_GUZZLER_LIMIT}) for a short TTL and answers each request with a
 * re-sliced view, so bursts of traffic collapse onto a single rebuild.
 * Concurrent misses share one in-flight rebuild to avoid a stampede.
 */
export class GuzzlerLeaderboardCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly windows: readonly GuzzlerWindow[];
  private readonly retentionMs: number;
  private cached: { board: GuzzlerLeaderboards; computedAtMs: number } | null = null;
  private inFlight: Promise<GuzzlerLeaderboards> | null = null;

  constructor(
    private readonly store: GuzzlerStore,
    options: GuzzlerLeaderboardCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_GUZZLER_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.windows = options.windows ?? GUZZLER_WINDOWS;
    this.retentionMs = options.retentionMs ?? DEFAULT_GUZZLER_WINDOW_MS;
  }

  /** The leaderboards cut to `limit`, recomputing from the store only if stale. */
  async get(limit: number = DEFAULT_GUZZLER_LIMIT): Promise<GuzzlerLeaderboards> {
    return sliceLeaderboards(await this.fullBoard(), limit);
  }

  private async fullBoard(): Promise<GuzzlerLeaderboards> {
    const nowMs = this.now();
    if (this.cached && nowMs - this.cached.computedAtMs < this.ttlMs) {
      return this.cached.board;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    // Compute at the maximum top-N so any per-request limit can be served by
    // slicing the cached board without another rebuild.
    const rebuild = readGuzzlerLeaderboards(
      this.store,
      nowMs,
      MAX_GUZZLER_LIMIT,
      this.windows,
      this.retentionMs,
    )
      .then((board) => {
        this.cached = { board, computedAtMs: nowMs };
        return board;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = rebuild;
    return rebuild;
  }
}
