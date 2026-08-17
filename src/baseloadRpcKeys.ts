import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * How a minted key is attached to an RPC request. The Arkiv Hub proxy documents
 * `Authorization: Bearer`; the per-network bouncer additionally accepts an
 * `X-Api-Key` header or the key as the last URL path segment.
 */
export type BaseloadRpcKeyPlacement = "bearer" | "header" | "path";

export const BASELOAD_RPC_KEY_PLACEMENTS: readonly BaseloadRpcKeyPlacement[] = [
  "bearer",
  "header",
  "path",
];

/**
 * Runtime settings for the per-worker RPC key pool. Keys are minted by an
 * Arkiv-Network/api-key-generator instance (`POST /keys`), which drives the Hub's
 * SIWE + captcha flow in a headless browser and returns one key per fresh wallet.
 */
export interface BaseloadRpcKeyRuntimeConfig {
  /** Base URL of the api-key-generator service, e.g. http://arkiv-keys:8787 */
  serviceUrl: string;
  placement: BaseloadRpcKeyPlacement;
  /** Header name used when placement is "header". */
  headerName: string;
  /** Prefix for the key name requested from the generator, per worker. */
  namePrefix: string;
  /** JSON file the minted keys are cached in, so a restart reuses them. */
  storePath: string;
  /** Budget for one mint. The captcha proof-of-work makes this slow. */
  requestTimeoutMs: number;
}

/** A ready-to-use RPC target: the URL to post to plus the headers to send. */
export interface BaseloadRpcEndpoint {
  url: string;
  headers: Record<string, string>;
  /** The key this endpoint carries, when one came from a rotating ring. */
  key?: string;
}

export interface BaseloadRpcKeyRecord {
  key: string;
  name: string;
  wallet?: string;
  privateKey?: string;
  createdAt: string;
}

interface BaseloadRpcKeyStore {
  version: 1;
  keys: Record<string, BaseloadRpcKeyRecord>;
}

export const BASELOAD_RPC_KEY_STORE_VERSION = 1;
export const DEFAULT_RPC_KEY_PLACEMENT: BaseloadRpcKeyPlacement = "bearer";
export const DEFAULT_RPC_KEY_HEADER = "X-Api-Key";
export const DEFAULT_RPC_KEY_NAME_PREFIX = "baseload";
export const DEFAULT_RPC_KEY_STORE_PATH = "baseload-keys/rpc-keys.json";
export const DEFAULT_RPC_KEY_TIMEOUT_SECONDS = 180;

export function parseBaseloadRpcKeyRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BaseloadRpcKeyRuntimeConfig | null {
  const serviceUrl = env.BASELOAD_RPC_KEY_SERVICE_URL?.trim();
  if (!serviceUrl) return null;

  const placement = parsePlacement(env.BASELOAD_RPC_KEY_PLACEMENT);
  const headerName = env.BASELOAD_RPC_KEY_HEADER?.trim() || DEFAULT_RPC_KEY_HEADER;
  const namePrefix = env.BASELOAD_RPC_KEY_NAME_PREFIX?.trim() || DEFAULT_RPC_KEY_NAME_PREFIX;
  const storePath = env.BASELOAD_RPC_KEY_STORE?.trim() || DEFAULT_RPC_KEY_STORE_PATH;
  const timeoutSeconds = parseTimeoutSeconds(env.BASELOAD_RPC_KEY_TIMEOUT_SECONDS);

  return {
    serviceUrl: serviceUrl.replace(/\/+$/, ""),
    placement,
    headerName,
    namePrefix,
    storePath,
    requestTimeoutMs: timeoutSeconds * 1000,
  };
}

function parsePlacement(value: string | undefined): BaseloadRpcKeyPlacement {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return DEFAULT_RPC_KEY_PLACEMENT;
  if (!BASELOAD_RPC_KEY_PLACEMENTS.includes(normalized as BaseloadRpcKeyPlacement)) {
    throw new Error(
      `BASELOAD_RPC_KEY_PLACEMENT must be one of ${BASELOAD_RPC_KEY_PLACEMENTS.join(", ")}`,
    );
  }
  return normalized as BaseloadRpcKeyPlacement;
}

function parseTimeoutSeconds(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return DEFAULT_RPC_KEY_TIMEOUT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("BASELOAD_RPC_KEY_TIMEOUT_SECONDS must be a positive number");
  }
  return parsed;
}

/** The endpoint used when no key pool is configured: the bare configured URL. */
export function bareRpcEndpoint(rpcUrl: string): BaseloadRpcEndpoint {
  return { url: rpcUrl, headers: {} };
}

/**
 * Attaches `key` to `rpcUrl` the way `placement` asks for. Pure, so the three
 * placements stay testable without a network or a generator service.
 */
export function applyRpcKey(
  rpcUrl: string,
  key: string,
  config: Pick<BaseloadRpcKeyRuntimeConfig, "placement" | "headerName">,
): BaseloadRpcEndpoint {
  switch (config.placement) {
    case "bearer":
      return { url: rpcUrl, headers: { Authorization: `Bearer ${key}` } };
    case "header":
      return { url: rpcUrl, headers: { [config.headerName]: key } };
    case "path":
      return { url: `${rpcUrl.replace(/\/+$/, "")}/${key}`, headers: {} };
  }
}

/** The subset of the generator's `POST /keys` response this pool cares about. */
export function parseGeneratedKey(body: unknown, workerId: string): BaseloadRpcKeyRecord {
  if (typeof body !== "object" || body === null) {
    throw new Error(`key generator returned a non-object response for worker ${workerId}`);
  }
  const record = body as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== "string" || key.length === 0) {
    const error = typeof record.error === "string" ? `: ${record.error}` : "";
    throw new Error(`key generator returned no key for worker ${workerId}${error}`);
  }
  return {
    key,
    name: typeof record.name === "string" ? record.name : workerId,
    ...(typeof record.wallet === "string" ? { wallet: record.wallet } : {}),
    ...(typeof record.privateKey === "string" ? { privateKey: record.privateKey } : {}),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
  };
}

export function parseRpcKeyStore(raw: string): BaseloadRpcKeyStore {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return emptyStore();
  const store = parsed as Record<string, unknown>;
  if (store.version !== BASELOAD_RPC_KEY_STORE_VERSION) return emptyStore();
  if (typeof store.keys !== "object" || store.keys === null) return emptyStore();

  const keys: Record<string, BaseloadRpcKeyRecord> = {};
  for (const [workerId, value] of Object.entries(store.keys as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.length === 0) continue;
    keys[workerId] = {
      key: record.key,
      name: typeof record.name === "string" ? record.name : workerId,
      ...(typeof record.wallet === "string" ? { wallet: record.wallet } : {}),
      ...(typeof record.privateKey === "string" ? { privateKey: record.privateKey } : {}),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    };
  }
  return { version: BASELOAD_RPC_KEY_STORE_VERSION, keys };
}

function emptyStore(): BaseloadRpcKeyStore {
  return { version: BASELOAD_RPC_KEY_STORE_VERSION, keys: {} };
}

export interface BaseloadRpcKeyPoolDeps {
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, contents: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Hands every Baseload worker its own RPC key so the workers stop sharing one
 * key's rate-limit bucket — the ceiling that caps how hard the fleet can hammer
 * a network. Keys are minted lazily on first use, persisted to disk so a restart
 * reuses them (minting costs a captcha solve), and minted one at a time because
 * the generator shares a single browser across requests.
 */
export class BaseloadRpcKeyPool {
  private readonly cache = new Map<string, BaseloadRpcKeyRecord>();
  private readonly pending = new Map<string, Promise<BaseloadRpcKeyRecord>>();
  private loaded = false;
  /** Serializes mints; every new mint chains onto the previous one. */
  private mintChain: Promise<unknown> = Promise.resolve();

  private readonly fetchImpl: typeof fetch;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly writeFileImpl: (path: string, contents: string) => Promise<void>;
  private readonly log: (message: string) => void;

  constructor(
    private readonly config: BaseloadRpcKeyRuntimeConfig,
    deps: BaseloadRpcKeyPoolDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.readFileImpl = deps.readFileImpl ?? ((path) => readFile(path, "utf8"));
    this.writeFileImpl =
      deps.writeFileImpl ??
      (async (path, contents) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, "utf8");
      });
    this.log = deps.log ?? ((message) => console.log(message));
  }

  /** The RPC endpoint `workerId` should use, minting its key if it has none yet. */
  async endpointFor(rpcUrl: string, workerId: string): Promise<BaseloadRpcEndpoint> {
    const record = await this.keyFor(workerId);
    return applyRpcKey(rpcUrl, record.key, this.config);
  }

  async keyFor(workerId: string): Promise<BaseloadRpcKeyRecord> {
    await this.load();
    const cached = this.cache.get(workerId);
    if (cached) return cached;

    // Single-flight: a worker loop retries fast, and the balance poller asks for
    // the same key concurrently — without this each retry would burn a mint.
    const inFlight = this.pending.get(workerId);
    if (inFlight) return inFlight;

    const promise = this.enqueueMint(workerId).finally(() => {
      this.pending.delete(workerId);
    });
    this.pending.set(workerId, promise);
    return promise;
  }

  /** Keys minted so far, for status reporting. */
  snapshot(): Record<string, BaseloadRpcKeyRecord> {
    return Object.fromEntries(this.cache);
  }

  private enqueueMint(workerId: string): Promise<BaseloadRpcKeyRecord> {
    const next = this.mintChain.then(
      () => this.mintAndStore(workerId),
      () => this.mintAndStore(workerId),
    );
    // Keep the chain alive after a failed mint so later workers still queue.
    this.mintChain = next.catch(() => undefined);
    return next;
  }

  private async mintAndStore(workerId: string): Promise<BaseloadRpcKeyRecord> {
    // A concurrent mint for the same worker may have landed while we waited in
    // the queue; the single-flight map only covers callers, not the queue.
    const cached = this.cache.get(workerId);
    if (cached) return cached;

    const record = await this.mint(workerId);
    this.cache.set(workerId, record);
    await this.persist();
    this.log(
      `[baseload] minted RPC key for worker ${workerId} (${maskKey(record.key)}` +
        `${record.wallet ? `, wallet ${record.wallet}` : ""})`,
    );
    return record;
  }

  private async mint(workerId: string): Promise<BaseloadRpcKeyRecord> {
    const name = `${this.config.namePrefix}_${workerId}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.serviceUrl}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal,
      });
    } catch (error) {
      throw new Error(
        `key generator at ${this.config.serviceUrl} failed for worker ${workerId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `key generator at ${this.config.serviceUrl} answered HTTP ${response.status} for ` +
          `worker ${workerId}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `key generator returned a non-JSON body for worker ${workerId}: ${text.slice(0, 200)}`,
      );
    }
    return parseGeneratedKey(body, workerId);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await this.readFileImpl(this.config.storePath);
    } catch {
      return; // No store yet (or unreadable): start with an empty pool.
    }
    try {
      for (const [workerId, record] of Object.entries(parseRpcKeyStore(raw).keys)) {
        this.cache.set(workerId, record);
      }
    } catch {
      this.log(`[baseload] ignoring unparsable RPC key store at ${this.config.storePath}`);
    }
  }

  private async persist(): Promise<void> {
    const store: BaseloadRpcKeyStore = {
      version: BASELOAD_RPC_KEY_STORE_VERSION,
      keys: Object.fromEntries(this.cache),
    };
    try {
      await this.writeFileImpl(this.config.storePath, `${JSON.stringify(store, null, 2)}\n`);
    } catch (error) {
      // Losing the store only costs a re-mint on the next restart; never let it
      // take down a worker that already holds a working key.
      this.log(
        `[baseload] failed to persist RPC keys to ${this.config.storePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 4)}…`;
  return `${key.slice(0, 12)}…${key.slice(-4)}`;
}
