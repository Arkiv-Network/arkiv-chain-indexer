/**
 * Bounded in-memory cache for small computed values — a row count, an
 * aggregate — keyed by caller-chosen strings. The scalar sibling of
 * {@link ResponseCache}: same LRU/TTL/single-flight semantics, but no
 * byte accounting, because the values it holds are a few bytes each and the
 * entry cap alone bounds it.
 *
 * Like the response cache, the TTL is a correctness backstop rather than the
 * primary freshness mechanism: the server clears this cache when a writer
 * commits data that could change the values (Postgres LISTEN/NOTIFY), so
 * entries only age out when that push channel is unavailable.
 *
 * `load()` is single-flight per key, which is the point of this cache under
 * load: when N concurrent requests need the same expensive count, one query
 * runs and the rest wait on it. An invalidation arriving mid-load marks that
 * load stale, so its result is returned to the waiters but never cached.
 */

export interface ValueCacheOptions {
  /** Maximum number of cached entries; 0 disables caching. */
  maxEntries?: number;
  /** Entry lifetime in milliseconds; 0 disables caching. */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface ValueCacheStats {
  entries: number;
  hits: number;
  misses: number;
  coalesced: number;
  invalidations: number;
  evictions: number;
  expirations: number;
}

export const DEFAULT_VALUE_CACHE_MAX_ENTRIES = 500;
export const DEFAULT_VALUE_CACHE_TTL_MS = 5_000;

interface ValueCacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ValueCache<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** Insertion order doubles as recency order: reads re-insert their entry. */
  private readonly entries = new Map<string, ValueCacheEntry<T>>();
  private readonly inflight = new Map<string, { promise: Promise<T>; stale: boolean }>();

  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private invalidations = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: ValueCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_VALUE_CACHE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_VALUE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0;
  }

  /**
   * Cached value for the key, or null on a miss/expiry. Refreshes recency.
   * Returns a wrapper so that a legitimately cached `undefined`/`0` value is
   * distinguishable from a miss.
   */
  get(key: string): { value: T } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.expirations += 1;
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value };
  }

  /**
   * Serve the key from cache, or run `loader` once (shared by concurrent
   * callers) and cache its result — unless an invalidation raced the load.
   */
  async load(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached) {
      this.hits += 1;
      return cached.value;
    }

    const running = this.inflight.get(key);
    if (running) {
      this.coalesced += 1;
      return running.promise;
    }

    this.misses += 1;
    const marker = { stale: false } as { promise: Promise<T>; stale: boolean };
    marker.promise = (async () => {
      try {
        const value = await loader();
        if (!marker.stale) {
          this.set(key, value);
        }
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, marker);
    return marker.promise;
  }

  /**
   * Drop the key (fresh data was committed for it) and poison any load in
   * flight so a read started before the write cannot re-fill the cache with
   * pre-write data.
   */
  invalidate(key: string): void {
    this.invalidations += 1;
    this.entries.delete(key);
    const running = this.inflight.get(key);
    if (running) {
      running.stale = true;
    }
  }

  /**
   * Drop every entry and poison every load in flight — for events that make
   * all keys stale at once (a new block landed, the listener reconnected).
   */
  clear(): void {
    this.entries.clear();
    for (const running of this.inflight.values()) {
      running.stale = true;
    }
  }

  stats(): ValueCacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      invalidations: this.invalidations,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  private set(key: string, value: T): void {
    if (!this.enabled) return;

    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}
