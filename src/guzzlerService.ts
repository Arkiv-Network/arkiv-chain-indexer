import {
  DEFAULT_GUZZLER_SWEEP_INTERVAL_MS,
  DEFAULT_GUZZLER_WINDOW_MS,
  GuzzlerTracker,
  normalizeAddress,
  type GuzzlerBlockTransaction,
  type GuzzlerRecorder,
  type GuzzlerStatistics,
  type GuzzlerStore,
} from "./guzzlers";

export interface GuzzlerServiceOptions {
  windowMs?: number;
  sweepIntervalMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Write-side owner of the guzzler tracker, used by the near-head scanner.
 *
 * It loads persisted state on {@link start}, records each block's transactions
 * into the in-memory deques while mirroring changes to the {@link GuzzlerStore},
 * and runs a background sweep so transactions and empty senders are evicted even
 * when no new blocks arrive.
 */
export class GuzzlerService implements GuzzlerRecorder {
  private readonly tracker: GuzzlerTracker;
  private readonly windowMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly store: GuzzlerStore,
    options: GuzzlerServiceOptions = {},
  ) {
    this.windowMs = options.windowMs ?? DEFAULT_GUZZLER_WINDOW_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_GUZZLER_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.tracker = new GuzzlerTracker(this.windowMs);
  }

  /** Load persisted senders, drop anything already expired, and start sweeping. */
  async start(): Promise<void> {
    const all = await this.store.loadAll();
    for (const [address, txs] of all) {
      this.tracker.loadSender(address, txs);
    }
    const { updated, removed } = this.tracker.sweep(this.now());
    await this.persist(updated, removed);
    this.log(`Guzzler tracker loaded ${this.tracker.senderCount.toString()} active sender(s)`);

    if (this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        void this.sweep();
      }, this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  async recordBlock(
    blockTimestampMs: number,
    transactions: Iterable<GuzzlerBlockTransaction>,
  ): Promise<void> {
    const now = this.now();
    // Blocks older than the window can never contribute to the last-hour view
    // (e.g. historical backfill) — skip them entirely instead of writing churn.
    if (blockTimestampMs <= now - this.windowMs) {
      return;
    }

    const touched = new Set<string>();
    for (const tx of transactions) {
      if (!tx.from) {
        continue;
      }
      this.tracker.record(
        tx.from,
        { hash: tx.hash, timestampMs: blockTimestampMs, gasUsed: tx.gasUsed, feeWei: tx.feeWei },
        now,
      );
      touched.add(normalizeAddress(tx.from));
    }

    if (touched.size === 0) {
      return;
    }

    const updated: string[] = [];
    const removed: string[] = [];
    for (const address of touched) {
      const current = this.tracker.getSenderTransactions(address);
      if (current && current.length > 0) {
        updated.push(address);
      } else {
        removed.push(address);
      }
    }
    await this.persist(updated, removed);
  }

  /** Current in-memory statistics (primarily for diagnostics/tests). */
  getStatistics(nowMs: number = this.now()): GuzzlerStatistics {
    return this.tracker.getStatistics(nowMs);
  }

  /** Evict expired transactions and remove now-empty senders from the cache. */
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

  private async persist(updated: string[], removed: string[]): Promise<void> {
    await Promise.all(
      updated.map((address) =>
        this.store.putSender(address, this.tracker.getSenderTransactions(address) ?? []),
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
