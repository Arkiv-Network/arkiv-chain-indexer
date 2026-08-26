import type { CachedResponse } from "./responseCache";

/**
 * Actively precomputed HTTP response: the serialized body lives in memory and
 * requests are served from it with zero storage work. Recomputes are pushed,
 * not pulled — `markDirty()` (wired to the scanner's block-stored NOTIFY)
 * recomputes immediately after a block lands, with bursts coalesced so a
 * backfill storm costs at most one recompute per `minIntervalMs`. A periodic
 * refresh recomputes even without events so time-derived fields (lag, ETA)
 * keep moving when the scanner stalls — which is exactly when they matter.
 *
 * A failed recompute keeps the last good response and reports the error;
 * `get()` returns null until the first successful compute (callers fall back
 * to computing on demand).
 */

export interface PrecomputedResponseOptions {
  /** Coalescing window for markDirty bursts; a recompute runs at most this often. */
  minIntervalMs?: number;
  /** Unconditional recompute period; 0 disables the timer. */
  refreshIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Receives recompute failures (the previous response stays served). */
  onError?: (error: unknown) => void;
}

export class PrecomputedResponse {
  private readonly compute: () => Promise<CachedResponse>;
  private readonly minIntervalMs: number;
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;

  private cached: CachedResponse | null = null;
  private computing = false;
  private pending = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private computes = 0;

  constructor(compute: () => Promise<CachedResponse>, options: PrecomputedResponseOptions = {}) {
    this.compute = compute;
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 5_000;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /** Compute the initial response and start the periodic refresh. */
  async start(): Promise<void> {
    await this.runCompute();
    if (this.refreshIntervalMs > 0 && !this.stopped) {
      this.refreshTimer = setInterval(() => this.markDirty(), this.refreshIntervalMs);
    }
  }

  /** The current precomputed response, or null before the first success. */
  get(): CachedResponse | null {
    return this.cached;
  }

  /**
   * Request a recompute. Runs immediately when the coalescing window has
   * passed; otherwise one trailing recompute is scheduled for the window's
   * end, absorbing any number of calls in between.
   */
  markDirty(): void {
    if (this.stopped) return;
    if (this.computing) {
      this.pending = true;
      return;
    }
    const elapsed = this.now() - this.lastStartedAt;
    if (elapsed >= this.minIntervalMs) {
      void this.runCompute();
      return;
    }
    if (this.delayTimer === null) {
      this.delayTimer = setTimeout(() => {
        this.delayTimer = null;
        this.markDirty();
      }, this.minIntervalMs - elapsed);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.delayTimer !== null) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  stats(): { computes: number; hasValue: boolean } {
    return { computes: this.computes, hasValue: this.cached !== null };
  }

  private async runCompute(): Promise<void> {
    this.computing = true;
    this.lastStartedAt = this.now();
    try {
      const next = await this.compute();
      if (!this.stopped) {
        this.cached = next;
        this.computes += 1;
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.computing = false;
      if (this.pending && !this.stopped) {
        this.pending = false;
        this.markDirty();
      }
    }
  }
}
