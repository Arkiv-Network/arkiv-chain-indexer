import { readFile } from "node:fs/promises";

/**
 * A rotating pool of bouncer API keys shared by the scanner and the Baseload
 * load agents.
 *
 * What rotation buys and what it does not: the bouncer meters two different
 * things. **Quota** is per key — cost units per calendar month — and exhausting
 * it answers every later call with `QUOTA_EXCEEDED` until the month rolls over.
 * **Rate limit** is per *client IP*, in calls per second, shared by every key we
 * hold. So a ring of N keys multiplies our monthly headroom by N and lets us
 * route around a burnt key within one request, but it does not raise
 * throughput — that ceiling is `RATE_LIMIT` on the auth-proxy deployment.
 */
export interface RpcKeyRingOptions {
  keys: string[];
  /** How long a key rests after a rate-limit 429 before the ring offers it again. */
  cooldownMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface RpcKeyState {
  key: string;
  /** Set once the bouncer reports the monthly quota is gone. */
  exhaustedAtMs: number | null;
  /** Set by a 429; the key is skipped while this is in the future. */
  cooldownUntilMs: number;
  uses: number;
  /** Last `Arkiv-Quota-Used-Percent` the edge reported for this key. */
  quotaUsedPercent: number | null;
}

export interface RpcKeyRingStats {
  total: number;
  usable: number;
  exhausted: number;
  coolingDown: number;
  keys: Array<{
    key: string;
    uses: number;
    quotaUsedPercent: number | null;
    exhausted: boolean;
    coolingDown: boolean;
  }>;
}

export const DEFAULT_RPC_KEY_COOLDOWN_MS = 1_000;

/** Splits a comma/whitespace separated key list, dropping blanks and duplicates. */
export function parseRpcKeyList(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const raw of value.split(/[\s,]+/)) {
    const key = raw.trim();
    if (key) seen.add(key);
  }
  return [...seen];
}

/** Reads a `{ "keys": ["ark_live_…"] }` pool file, as written by provision-rpc-keys. */
export function parseRpcKeyPoolFile(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed.filter((k): k is string => typeof k === "string" && !!k);
  if (typeof parsed !== "object" || parsed === null) return [];
  const keys = (parsed as Record<string, unknown>).keys;
  if (!Array.isArray(keys)) return [];
  const seen = new Set<string>();
  for (const entry of keys) {
    if (typeof entry === "string" && entry) seen.add(entry);
    else if (typeof entry === "object" && entry !== null) {
      const key = (entry as Record<string, unknown>).key;
      if (typeof key === "string" && key) seen.add(key);
    }
  }
  return [...seen];
}

/**
 * Resolves the key pool for a service. The pool file wins over the inline list,
 * which wins over the historical single-key variable, so a deployment can move
 * to a pool without touching the old setting.
 */
export async function loadRpcKeyPool(
  env: NodeJS.ProcessEnv = process.env,
  readFileImpl: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string[]> {
  const poolFile = env.RPC_KEY_POOL_FILE?.trim();
  if (poolFile) {
    try {
      return parseRpcKeyPoolFile(await readFileImpl(poolFile));
    } catch (error) {
      throw new Error(
        `RPC_KEY_POOL_FILE ${poolFile} could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const inline = parseRpcKeyList(env.SCANNER_RPC_API_KEYS);
  if (inline.length) return inline;
  return parseRpcKeyList(env.SCANNER_RPC_API_KEY);
}

export class RpcKeyRing {
  private readonly states: RpcKeyState[];
  private readonly leases = new Map<string, string>();
  private cursor = 0;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: RpcKeyRingOptions) {
    const seen = new Set<string>();
    this.states = options.keys
      .filter((key) => key && !seen.has(key) && seen.add(key))
      .map((key) => ({
        key,
        exhaustedAtMs: null,
        cooldownUntilMs: 0,
        uses: 0,
        quotaUsedPercent: null,
      }));
    this.cooldownMs = options.cooldownMs ?? DEFAULT_RPC_KEY_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(message));
  }

  get size(): number {
    return this.states.length;
  }

  /**
   * The next key to use, round-robin over the keys that are neither exhausted
   * nor cooling down. Returns null when the ring is empty (no keys configured).
   *
   * When every key is exhausted it still returns one rather than stalling the
   * caller: the request will fail with QUOTA_EXCEEDED and the error surfaces to
   * the operator, which beats a silent hang.
   */
  next(): string | null {
    if (this.states.length === 0) return null;
    const nowMs = this.now();

    for (let offset = 0; offset < this.states.length; offset += 1) {
      const state = this.states[(this.cursor + offset) % this.states.length]!;
      if (state.exhaustedAtMs !== null) continue;
      if (state.cooldownUntilMs > nowMs) continue;
      this.cursor = (this.cursor + offset + 1) % this.states.length;
      state.uses += 1;
      return state.key;
    }

    // Everything is resting or burnt: fall back to the least recently offered
    // key so a transient all-cooling-down moment does not drop the request.
    const fallback = this.states[this.cursor % this.states.length]!;
    this.cursor = (this.cursor + 1) % this.states.length;
    fallback.uses += 1;
    return fallback.key;
  }

  /**
   * Feeds a bouncer response back into the ring. `QUOTA_EXCEEDED` retires the
   * key for the rest of the month; a plain 429 is the per-IP rate limit, which
   * no other key escapes, so it only rests this one briefly.
   */
  noteResponse(key: string, status: number, headers: Headers, bodyText: string): void {
    const state = this.states.find((candidate) => candidate.key === key);
    if (!state) return;

    const percent = Number(headers.get("arkiv-quota-used-percent"));
    if (Number.isFinite(percent)) state.quotaUsedPercent = percent;

    if (status === 401 || status === 403) {
      if (state.exhaustedAtMs === null) {
        state.exhaustedAtMs = this.now();
        this.log(`[rpc-keys] key ${maskRpcKey(key)} rejected (HTTP ${status}); retiring it`);
      }
      return;
    }

    if (status === 429) {
      if (bodyText.includes("QUOTA_EXCEEDED")) {
        if (state.exhaustedAtMs === null) {
          state.exhaustedAtMs = this.now();
          this.log(
            `[rpc-keys] key ${maskRpcKey(key)} exhausted its monthly quota; ` +
              `${this.usableCount()} of ${this.states.length} keys left`,
          );
        }
        return;
      }
      state.cooldownUntilMs = this.now() + this.cooldownMs;
    }
  }

  /**
   * A key held for an owner (a Baseload worker) until it burns out.
   *
   * The load agents build a signing client per key, so rotating on every call
   * would rebuild that client every call. A sticky lease spreads the fleet
   * across the pool, keeps the client cache warm, and still moves the owner onto
   * a fresh key the moment its own key is retired.
   */
  leaseFor(ownerId: string): string | null {
    const current = this.leases.get(ownerId);
    if (current !== undefined) {
      const state = this.states.find((candidate) => candidate.key === current);
      if (state && state.exhaustedAtMs === null) return current;
    }
    const key = this.next();
    if (key === null) this.leases.delete(ownerId);
    else this.leases.set(ownerId, key);
    return key;
  }

  /** Marks a key exhausted without a response, e.g. from a startup quota probe. */
  retire(key: string, reason: string): void {
    const state = this.states.find((candidate) => candidate.key === key);
    if (!state || state.exhaustedAtMs !== null) return;
    state.exhaustedAtMs = this.now();
    this.log(`[rpc-keys] retiring key ${maskRpcKey(key)}: ${reason}`);
  }

  usableCount(): number {
    return this.states.filter((state) => state.exhaustedAtMs === null).length;
  }

  stats(): RpcKeyRingStats {
    const nowMs = this.now();
    return {
      total: this.states.length,
      usable: this.usableCount(),
      exhausted: this.states.filter((state) => state.exhaustedAtMs !== null).length,
      coolingDown: this.states.filter(
        (state) => state.exhaustedAtMs === null && state.cooldownUntilMs > nowMs,
      ).length,
      keys: this.states.map((state) => ({
        key: maskRpcKey(state.key),
        uses: state.uses,
        quotaUsedPercent: state.quotaUsedPercent,
        exhausted: state.exhaustedAtMs !== null,
        coolingDown: state.exhaustedAtMs === null && state.cooldownUntilMs > nowMs,
      })),
    };
  }
}

/** Structural, so this module never imports the RPC client back (no cycle). */
interface KeyRingConsumer {
  setKeyRing(keyRing: RpcKeyRing | null): void;
}

/**
 * Loads the configured key pool and attaches it to an RPC client. A pool of one
 * (or none) is left alone so single-key deployments keep their existing path.
 */
export async function attachRpcKeyRing(
  client: KeyRingConsumer,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RpcKeyRing | null> {
  const keys = await loadRpcKeyPool(env);
  if (keys.length <= 1) return null;
  const ring = new RpcKeyRing({ keys });
  client.setKeyRing(ring);
  console.log(`[rpc-keys] ${label} rotating over ${ring.size} RPC keys`);
  return ring;
}

export function maskRpcKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}
