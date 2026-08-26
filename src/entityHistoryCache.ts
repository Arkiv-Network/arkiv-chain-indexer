/**
 * Bounded in-memory cache for serialized `/entity/:entityKey` responses.
 *
 * Bounded three ways so it can never grow past its configured memory budget:
 * an entry-count cap, a total-bytes cap over the cached body strings, and a
 * TTL. Recency is tracked LRU-style (a Map ordered by last touch); inserting
 * past either cap evicts the least recently used entries first.
 *
 * The TTL is a correctness backstop, not the primary freshness mechanism:
 * the server evicts entries the moment a scanner commits new operations for
 * a key (Postgres LISTEN/NOTIFY), so entries only age out when that push
 * channel is unavailable or a notification was missed.
 *
 * `load()` is single-flight per key: concurrent misses for the same key share
 * one loader call. An invalidation that arrives while a load is in flight
 * marks that load stale so its (possibly outdated) result is served to the
 * waiting requests but never cached.
 */

export interface EntityHistoryCacheOptions {
  /** Maximum number of cached entries; 0 disables caching. */
  maxEntries?: number;
  /** Maximum total size of cached bodies in bytes; 0 disables caching. */
  maxBytes?: number;
  /** Entry lifetime in milliseconds; 0 disables caching. */
  ttlMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** A cacheable HTTP result: the status plus the serialized JSON body. */
export interface CachedEntityResponse {
  status: number;
  body: string;
}

interface CacheEntry extends CachedEntityResponse {
  bytes: number;
  expiresAt: number;
}

export interface EntityHistoryCacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  coalesced: number;
  invalidations: number;
  evictions: number;
  expirations: number;
}

export const DEFAULT_ENTITY_CACHE_MAX_ENTRIES = 10_000;
export const DEFAULT_ENTITY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ENTITY_CACHE_TTL_MS = 5 * 60 * 1000;

export class EntityHistoryCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** Insertion order doubles as recency order: reads re-insert their entry. */
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<
    string,
    { promise: Promise<CachedEntityResponse>; stale: boolean }
  >();
  private totalBytes = 0;

  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private invalidations = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: EntityHistoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_ENTITY_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_ENTITY_CACHE_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_ENTITY_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.maxEntries > 0 && this.maxBytes > 0 && this.ttlMs > 0;
  }

  /** Cached response for the key, or null on a miss/expiry. Refreshes recency. */
  get(key: string): CachedEntityResponse | null {
    const normalized = key.toLowerCase();
    const entry = this.entries.get(normalized);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(normalized);
      this.totalBytes -= entry.bytes;
      this.expirations += 1;
      return null;
    }
    this.entries.delete(normalized);
    this.entries.set(normalized, entry);
    return { status: entry.status, body: entry.body };
  }

  /**
   * Serve the key from cache, or run `loader` once (shared by concurrent
   * callers) and cache its result — unless an invalidation raced the load.
   */
  async load(
    key: string,
    loader: () => Promise<CachedEntityResponse>,
  ): Promise<CachedEntityResponse> {
    const normalized = key.toLowerCase();
    const cached = this.get(normalized);
    if (cached) {
      this.hits += 1;
      return cached;
    }

    const running = this.inflight.get(normalized);
    if (running) {
      this.coalesced += 1;
      return running.promise;
    }

    this.misses += 1;
    const marker = { stale: false } as { promise: Promise<CachedEntityResponse>; stale: boolean };
    marker.promise = (async () => {
      try {
        const result = await loader();
        if (!marker.stale) {
          this.set(normalized, result);
        }
        return result;
      } finally {
        this.inflight.delete(normalized);
      }
    })();
    this.inflight.set(normalized, marker);
    return marker.promise;
  }

  /**
   * Drop the key (new operations were stored for it) and poison any load in
   * flight so a read started before the write cannot re-fill the cache with
   * pre-write data.
   */
  invalidate(key: string): void {
    const normalized = key.toLowerCase();
    this.invalidations += 1;
    const entry = this.entries.get(normalized);
    if (entry) {
      this.entries.delete(normalized);
      this.totalBytes -= entry.bytes;
    }
    const running = this.inflight.get(normalized);
    if (running) {
      running.stale = true;
    }
  }

  /** Drop everything (e.g. the invalidation listener had to reconnect). */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): EntityHistoryCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      invalidations: this.invalidations,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  private set(key: string, response: CachedEntityResponse): void {
    if (!this.enabled) return;
    // Body strings are ASCII JSON, so string length equals byte length.
    const bytes = response.body.length;
    if (bytes > this.maxBytes) return;

    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes -= existing.bytes;
    }
    while (
      this.entries.size >= this.maxEntries ||
      (this.entries.size > 0 && this.totalBytes + bytes > this.maxBytes)
    ) {
      const oldest = this.entries.keys().next().value as string;
      const evicted = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.totalBytes -= evicted.bytes;
      this.evictions += 1;
    }
    this.entries.set(key, {
      status: response.status,
      body: response.body,
      bytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.totalBytes += bytes;
  }
}
