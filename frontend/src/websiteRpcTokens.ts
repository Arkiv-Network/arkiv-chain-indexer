/**
 * Unauthorized automated RPC use violates the service's terms of use. Website
 * RPC is reserved for supported browser interactions and explicitly authorized
 * clients. This handshake deters casual reuse; it is not proof of browser use.
 * Never store administrator or upstream credentials here.
 */
const STORAGE_KEY = "arkiv.website-rpc.v1";
const TOKEN_PATH = "/api/website-rpc/token";
const REFRESH_MS = 60_000;
const RPC_PATHS = new Set(["/api/entity-explorer/rpc", "/api/shadow-rpc/experimental"]);
type Access = { token: string; expiresAt: number };
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class WebsiteRpcTokenManager {
  private access: Access | undefined;
  private pending: Promise<Access> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly deps: {
    fetch: Fetch;
    origin: string;
    storage?: () => Pick<Storage, "getItem" | "setItem">;
    now?: () => number;
  }) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private read(): Access | undefined {
    try {
      const stored: unknown = JSON.parse(this.deps.storage?.().getItem(STORAGE_KEY) ?? "null");
      if (this.valid(stored) && (!this.access || stored.expiresAt > this.access.expiresAt)) this.access = stored;
    } catch { /* Storage can be disabled or contain stale/malformed data. */ }
    return this.access;
  }
  private valid(value: unknown): value is Access {
    if (!value || typeof value !== "object") return false;
    const a = value as Access;
    return typeof a.token === "string" && a.token.startsWith("wrpc.") && a.token.length <= 1024 &&
      Number.isSafeInteger(a.expiresAt) && a.expiresAt > this.now() && a.expiresAt <= this.now() + 120_000;
  }
  async get(force = false): Promise<Access> {
    if (this.pending) return this.pending;
    const current = this.read();
    if (!force && current && current.expiresAt > this.now() + REFRESH_MS) return current;
    this.pending = (async () => {
      const response = await this.deps.fetch(TOKEN_PATH, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Website RPC session refresh failed (HTTP ${response.status})`);
      const body = await response.json() as { token?: unknown; expiresInMs?: unknown };
      // Server and browser clocks need not agree. The server owns hard expiry;
      // schedule browser refresh using the remaining lifetime, not its timestamp.
      if (typeof body.expiresInMs !== "number" || !Number.isSafeInteger(body.expiresInMs) ||
          body.expiresInMs <= 0 || body.expiresInMs > 120_000) throw new Error("Invalid website RPC token lifetime");
      const access = { token: body.token, expiresAt: this.now() + body.expiresInMs };
      if (!this.valid(access)) throw new Error("Invalid website RPC token response");
      this.access = access;
      try { this.deps.storage?.().setItem(STORAGE_KEY, JSON.stringify(access)); } catch { /* In-memory fallback. */ }
      return access;
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  start(): () => void {
    if (!this.timer) {
      void this.get().catch(() => {});
      this.timer = setInterval(() => { void this.get(true).catch(() => {}); }, REFRESH_MS);
    }
    return () => { clearInterval(this.timer); this.timer = undefined; };
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, this.deps.origin);
    // An overridden/custom node must never receive website cookies or tokens.
    if (url.origin !== this.deps.origin || !RPC_PATHS.has(url.pathname)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("authorization");
      headers.delete("x-csrf-token");
      return this.deps.fetch(input, { ...init, headers, credentials: "omit" });
    }
    const access = await this.get();
    const send = (token: string) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("authorization", `Bearer ${token}`);
      return this.deps.fetch(input instanceof Request ? input.clone() : input, {
        ...init, headers, credentials: "same-origin", cache: "no-store", redirect: "error",
      });
    };
    const response = await send(access.token);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    // One recovery handles server restarts, an expired token, or simultaneous
    // first visits in two tabs establishing different binding cookies.
    const refreshed = this.access && this.access.token !== access.token && this.valid(this.access)
      ? this.access : await this.get(true);
    return send(refreshed.token);
  }
}

let manager: WebsiteRpcTokenManager | undefined;
function browserManager(): WebsiteRpcTokenManager {
  return manager ??= new WebsiteRpcTokenManager({
    fetch: (input, init) => fetch(input, init), origin: window.location.origin,
    storage: () => window.localStorage,
  });
}
export function websiteRpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return browserManager().fetch(input, init);
}
export function startWebsiteRpcTokens(): () => void { return browserManager().start(); }
