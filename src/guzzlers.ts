import Denque from "denque";

/**
 * Guzzlers: an in-memory, database-free view of the most active senders over a
 * sliding one-hour window.
 *
 * Unlike the Postgres-backed `sender_stats` aggregation, guzzler statistics are
 * computed entirely from in-memory per-sender deques (one {@link Denque} per
 * address) that only retain transactions seen in the last hour. The deques are
 * mirrored into Redis (see {@link GuzzlerStore}) so the data survives a restart.
 *
 * The near-head scanner is the single writer; the backend server reads the
 * persisted state to answer the `/guzzlers` API.
 */

/** Default retention window: keep transactions seen in the last hour. */
export const DEFAULT_GUZZLER_WINDOW_MS = 60 * 60 * 1000;

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

/** The full guzzler statistics payload returned by the API. */
export interface GuzzlerStatistics {
  windowMs: number;
  generatedAt: string;
  count: number;
  guzzlers: GuzzlerStat[];
}

/** Persistence boundary so the tracker can be backed by Redis (or a fake). */
export interface GuzzlerStore {
  /** Load every persisted sender and its retained transactions. */
  loadAll(): Promise<Map<string, GuzzlerTransaction[]>>;
  /** Persist the full retained transaction list for a sender. */
  putSender(address: string, txs: GuzzlerTransaction[]): Promise<void>;
  /** Drop senders that no longer have any transactions in the window. */
  removeSenders(addresses: string[]): Promise<void>;
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
 * drop anything that has aged out, and return current statistics. This never
 * mutates Redis — cleanup of the persisted set is the writer's responsibility.
 */
export async function readGuzzlerStatistics(
  store: GuzzlerStore,
  nowMs: number,
  windowMs: number = DEFAULT_GUZZLER_WINDOW_MS,
): Promise<GuzzlerStatistics> {
  const all = await store.loadAll();
  const tracker = new GuzzlerTracker(windowMs);
  for (const [address, txs] of all) {
    tracker.loadSender(address, txs);
  }
  tracker.sweep(nowMs);
  return tracker.getStatistics(nowMs);
}
