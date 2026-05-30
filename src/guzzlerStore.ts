import { RedisClient } from "bun";
import type { GuzzlerStore, GuzzlerTransaction } from "./guzzlers";

/**
 * {@link GuzzlerStore} backed by a single Redis hash, keyed by sender address,
 * whose values are JSON-encoded arrays of the sender's retained transactions.
 *
 * A hash keeps the whole dataset under one key so the read side can fetch every
 * active sender in a single `HGETALL`, while the writer updates or removes
 * individual senders with `HSET` / `HDEL`.
 */
export class RedisGuzzlerStore implements GuzzlerStore {
  static readonly DEFAULT_KEY = "guzzlers:senders";

  private constructor(
    private readonly client: RedisClient,
    private readonly key: string,
  ) {}

  /** Connect to Redis and return a ready store. */
  static async open(url: string, key: string = RedisGuzzlerStore.DEFAULT_KEY): Promise<RedisGuzzlerStore> {
    const client = new RedisClient(url);
    await client.connect();
    return new RedisGuzzlerStore(client, key);
  }

  async loadAll(): Promise<Map<string, GuzzlerTransaction[]>> {
    const raw = await this.client.hgetall(this.key);
    const result = new Map<string, GuzzlerTransaction[]>();
    for (const [address, json] of Object.entries(raw ?? {})) {
      const txs = parseTransactions(json);
      if (txs.length > 0) {
        result.set(address, txs);
      }
    }
    return result;
  }

  async putSender(address: string, txs: GuzzlerTransaction[]): Promise<void> {
    await this.client.hset(this.key, address, JSON.stringify(txs));
  }

  async removeSenders(addresses: string[]): Promise<void> {
    if (addresses.length === 0) {
      return;
    }
    const [first, ...rest] = addresses;
    await this.client.hdel(this.key, first as string, ...rest);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}

function parseTransactions(json: string): GuzzlerTransaction[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as GuzzlerTransaction[]) : [];
  } catch {
    return [];
  }
}
