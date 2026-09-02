/**
 * Forwards a small allowlist of JSON-RPC methods from `/shadow-rpc` to a real
 * node.
 *
 * Everything else on that endpoint is answered from indexed data, which works
 * for reads and not at all for writes: a transaction has to reach a node's
 * mempool, and no amount of stored history can put it there. So the endpoint
 * keeps its read surface and gains one narrow hole — the methods listed here
 * are relayed upstream and their answers returned verbatim.
 *
 * Three rules keep the hole narrow:
 *
 * - **Allowlist only.** Anything not listed is still answered locally or
 *   rejected with `-32601`; this is never an open proxy.
 * - **Nothing about the upstream leaks.** The URL can embed an API key, so
 *   transport failures report a fixed message and the detail goes to the
 *   server log. Only the node's own JSON-RPC `error` object is relayed, since
 *   "nonce too low" / "already known" / "insufficient funds" are the whole
 *   point of forwarding.
 * - **The upstream is metered.** A public endpoint fronting a keyed node is a
 *   way to burn someone else's quota, so forwarded calls are rate limited as a
 *   whole (see {@link DEFAULT_PASSTHROUGH_RATE_LIMIT_PER_MINUTE}).
 */
import { JSON_RPC_SERVER_ERROR, JsonRpcError, type JsonRpcForwarder } from "./jsonRpc";

/** EIP-1474's "request rate exceeded" code, returned when the cap is hit. */
export const JSON_RPC_LIMIT_EXCEEDED = -32005;

/**
 * The Arkiv entity read methods. The index stores operation metadata, never the
 * entity state a node keeps (current attributes, owner, absolute expiry,
 * payload), so on `/shadow-rpc` these are answered upstream. They are read-only
 * and cheap, and the frontend's Data tab queries entities through them. The
 * experimental entity index (`ENTITY_QUERY_INDEX`) answers the same four on
 * `/shadow-rpc/experimental` from a projection of that metadata instead.
 */
export const ARKIV_READ_METHODS: readonly string[] = [
  "arkiv_query",
  "arkiv_getEntity",
  "arkiv_getEntityCount",
  "arkiv_getBlockTiming",
];

/**
 * Forwarded unless the deployment says otherwise. `eth_sendRawTransaction` is
 * how wallets and SDKs actually submit — they sign locally — so it is the only
 * write method worth forwarding by default. `eth_sendTransaction` needs an
 * unlocked account on the node, which a public endpoint has no business relying
 * on; list it explicitly if some deployment's node really does hold keys. The
 * Arkiv read methods ride along because nothing else can answer them.
 */
export const DEFAULT_PASSTHROUGH_METHODS: readonly string[] = [
  "eth_sendRawTransaction",
  ...ARKIV_READ_METHODS,
];

/** Upstream calls are submissions, not queries: they answer fast or not at all. */
export const DEFAULT_PASSTHROUGH_TIMEOUT_MS = 10_000;
/**
 * Forwarded calls allowed per minute across all callers. Generous enough that
 * real submission traffic never notices, low enough that a script pointed at
 * the public endpoint cannot drain the upstream's quota unattended. 0 disables
 * the cap.
 */
export const DEFAULT_PASSTHROUGH_RATE_LIMIT_PER_MINUTE = 600;

export interface JsonRpcPassthroughOptions {
  /** JSON-RPC endpoint of the real node (or of a key-injecting proxy in front of one). */
  url: string;
  /** Sent as `x-api-key` when the upstream wants a header key rather than one baked into the URL. */
  apiKey?: string;
  /** Methods to forward; defaults to {@link DEFAULT_PASSTHROUGH_METHODS}. */
  methods?: readonly string[];
  timeoutMs?: number;
  /** Forwarded calls per minute across all callers; 0 disables the cap. */
  rateLimitPerMinute?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  now?: () => number;
  /** Injected in tests; defaults to `console.warn`. */
  onWarning?: (message: string, detail: unknown) => void;
}

const RATE_LIMIT_WINDOW_MS = 60_000;

export class JsonRpcPassthrough implements JsonRpcForwarder {
  readonly methods: ReadonlySet<string>;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly rateLimitPerMinute: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onWarning: (message: string, detail: unknown) => void;
  private nextId = 1;
  private windowStart = 0;
  private windowCount = 0;

  constructor(options: JsonRpcPassthroughOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.methods = new Set(options.methods ?? DEFAULT_PASSTHROUGH_METHODS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PASSTHROUGH_TIMEOUT_MS;
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_PASSTHROUGH_RATE_LIMIT_PER_MINUTE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.onWarning = options.onWarning ?? ((message, detail) => console.warn(message, detail));
  }

  /** Human-readable summary for startup logs; deliberately omits the URL and key. */
  describe(): string {
    const limit =
      this.rateLimitPerMinute > 0 ? `${this.rateLimitPerMinute}/min` : "unlimited (no rate cap)";
    return `${[...this.methods].join(", ")} (timeout ${this.timeoutMs}ms, ${limit})`;
  }

  async forward(method: string, params: unknown[]): Promise<unknown> {
    this.takeRateLimitSlot(method);

    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The cause can name the upstream host, and the URL may carry a key, so
      // the caller gets none of it — the operator reads it in the log instead.
      this.onWarning(`shadow-rpc passthrough: ${method} could not reach the upstream node:`, error);
      throw new JsonRpcError(
        JSON_RPC_SERVER_ERROR,
        `${method} could not be forwarded to the upstream node`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      this.onWarning(`shadow-rpc passthrough: ${method} upstream returned HTTP ${response.status}:`, text);
      throw new JsonRpcError(
        JSON_RPC_SERVER_ERROR,
        `${method} was rejected by the upstream node (HTTP ${response.status})`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.onWarning(`shadow-rpc passthrough: ${method} upstream returned unparseable JSON:`, text);
      throw new JsonRpcError(
        JSON_RPC_SERVER_ERROR,
        `${method} received a malformed response from the upstream node`,
      );
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new JsonRpcError(
        JSON_RPC_SERVER_ERROR,
        `${method} received a malformed response from the upstream node`,
      );
    }

    const envelope = payload as { result?: unknown; error?: unknown };
    if (envelope.error !== undefined && envelope.error !== null) {
      throw relayedError(envelope.error);
    }
    if (!("result" in envelope)) {
      throw new JsonRpcError(
        JSON_RPC_SERVER_ERROR,
        `${method} received a malformed response from the upstream node`,
      );
    }
    return envelope.result;
  }

  private takeRateLimitSlot(method: string): void {
    if (this.rateLimitPerMinute <= 0) return;
    const now = this.now();
    if (now - this.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.rateLimitPerMinute) {
      throw new JsonRpcError(
        JSON_RPC_LIMIT_EXCEEDED,
        `${method} is rate limited: at most ${this.rateLimitPerMinute} forwarded requests per minute`,
      );
    }
    // Only accepted calls consume the window, so a flood cannot hold it open
    // past the minute it started in.
    this.windowCount += 1;
  }
}

/**
 * Relay the node's own verdict. Codes and messages are the useful part of a
 * failed submission, and they come from the node rather than from our
 * configuration, so they carry nothing about the upstream's address or key.
 */
function relayedError(error: unknown): JsonRpcError {
  if (typeof error !== "object" || error === null) {
    return new JsonRpcError(JSON_RPC_SERVER_ERROR, "The upstream node returned an error");
  }
  const body = error as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof body.code === "number" ? body.code : JSON_RPC_SERVER_ERROR;
  const message = typeof body.message === "string" ? body.message : "The upstream node returned an error";
  return new JsonRpcError(code, message, body.data);
}
