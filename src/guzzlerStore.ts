import { RedisClient } from "bun";
import {
  DEFAULT_GUZZLER_RETENTION_MS,
  isValidBucket,
  normalizeAddress,
  type GuzzlerBucket,
  type GuzzlerLeaderboards,
  type GuzzlerStore,
  type GuzzlerStoreStats,
} from "./guzzlers";

/**
 * {@link GuzzlerStore} backed by Redis.
 *
 * Per-sender bucket data lives in a single hash keyed by sender address, whose
 * values are JSON-encoded arrays of the sender's retained one-minute buckets.
 * The hash keeps the whole dataset under one key so the writer can load every
 * active sender in a single `HGETALL`, while updating or removing individual
 * senders with `HSET` / `HDEL`.
 *
 * The precomputed leaderboard response — refreshed once a minute by the writer
 * and served verbatim by the API — lives under a separate string key with a
 * short TTL, so a stalled writer's board eventually disappears instead of being
 * served forever.
 */
export class RedisGuzzlerStore implements GuzzlerStore {
  static readonly DEFAULT_KEY = "guzzlers:senders";
  static readonly DEFAULT_LEADERBOARD_KEY = "guzzlers:leaderboards";

  /**
   * How long the cached leaderboard survives without a refresh. Comfortably
   * above the once-a-minute refresh cadence so a healthy writer always keeps it
   * fresh, but bounded so a dead writer's board self-expires.
   */
  private readonly leaderboardTtlSeconds = Math.ceil(DEFAULT_GUZZLER_RETENTION_MS / 1000);

  private constructor(
    private readonly client: RedisClient,
    private readonly key: string,
    private readonly leaderboardKey: string,
  ) {}

  /** Connect to Redis and return a ready store. */
  static async open(
    url: string,
    key: string = RedisGuzzlerStore.DEFAULT_KEY,
    leaderboardKey: string = RedisGuzzlerStore.DEFAULT_LEADERBOARD_KEY,
  ): Promise<RedisGuzzlerStore> {
    const client = new RedisClient(url);
    await client.connect();
    return new RedisGuzzlerStore(client, key, leaderboardKey);
  }

  async loadAll(): Promise<Map<string, GuzzlerBucket[]>> {
    const raw = await this.client.hgetall(this.key);
    const result = new Map<string, GuzzlerBucket[]>();
    // Opportunistically drop fields that no longer parse to valid buckets — e.g.
    // data written by the previous per-transaction schema — so a deploy over an
    // existing cache self-heals instead of carrying garbage forward.
    const stale: string[] = [];
    for (const [address, json] of Object.entries(raw ?? {})) {
      const buckets = parseBuckets(json);
      if (buckets.length > 0) {
        result.set(address, buckets);
      } else {
        stale.push(address);
      }
    }
    if (stale.length > 0) {
      await this.removeSenders(stale);
    }
    return result;
  }

  async loadSender(address: string): Promise<GuzzlerBucket[] | null> {
    const json = await this.client.hget(this.key, normalizeAddress(address));
    if (!json) {
      return null;
    }
    const buckets = parseBuckets(json);
    return buckets.length > 0 ? buckets : null;
  }

  async putSender(address: string, buckets: GuzzlerBucket[]): Promise<void> {
    await this.client.hset(this.key, address, JSON.stringify(buckets));
  }

  async removeSenders(addresses: string[]): Promise<void> {
    if (addresses.length === 0) {
      return;
    }
    const [first, ...rest] = addresses;
    await this.client.hdel(this.key, first as string, ...rest);
  }

  async saveLeaderboards(board: GuzzlerLeaderboards): Promise<void> {
    await this.client.send("SET", [
      this.leaderboardKey,
      JSON.stringify(board),
      "EX",
      this.leaderboardTtlSeconds.toString(),
    ]);
  }

  async loadLeaderboards(): Promise<GuzzlerLeaderboards | null> {
    const json = await this.client.get(this.leaderboardKey);
    if (!json) {
      return null;
    }
    try {
      return JSON.parse(json) as GuzzlerLeaderboards;
    } catch {
      return null;
    }
  }

  async stats(): Promise<GuzzlerStoreStats> {
    // HLEN is O(1); MEMORY USAGE is an efficient, sampled estimate of the hash's
    // total RAM footprint (key + values + overhead) — both keep /health cheap
    // even when many senders are cached.
    const [entryCount, usage] = await Promise.all([
      this.client.hlen(this.key),
      this.client.send("MEMORY", ["USAGE", this.key]),
    ]);
    const totalBytes = Number(usage);
    return {
      entryCount: entryCount ?? 0,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
    };
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

function parseBuckets(json: string): GuzzlerBucket[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isValidBucket) : [];
  } catch {
    return [];
  }
}
