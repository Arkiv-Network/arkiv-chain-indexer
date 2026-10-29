import { recordResponseBytes } from "./serverMetrics";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Website RPC access is reserved for supported browser interactions and explicitly
 * authorized clients. Unauthorized automated RPC use violates the service's terms
 * of use. This anonymous handshake deters casual reuse; it does not prove that a
 * request came from the website. Keep the RPC allowlists and rate limits in place.
 */
export const WEBSITE_RPC_TOKEN_PATH = "/website-rpc/token";
export const WEBSITE_RPC_TTL_MS = 120_000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SECURE_COOKIE = "__Host-arkiv_rpc";
const LOCAL_COOKIE = "arkiv_rpc_local";

function tokenResponse(body: unknown, init: ResponseInit = {}): Response {
  const json = JSON.stringify(body);
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return recordResponseBytes(new Response(json, { ...init, headers }), Buffer.byteLength(json));
}

type Claims = { v: 1; kind: "session" | "access"; sid: string; iat: number; exp: number };

export class WebsiteRpcTokens {
  private readonly secret: string;
  constructor(private readonly options: { secret?: string; insecureLocalhost?: boolean; publicOrigin?: string; now?: () => number } = {}) {
    if (options.secret !== undefined && Buffer.byteLength(options.secret) < 32) {
      throw new Error("WEBSITE_RPC_TOKEN_SECRET must contain at least 32 bytes");
    }
    if (options.insecureLocalhost) {
      let origin: URL;
      try { origin = new URL(options.publicOrigin ?? ""); } catch { throw new Error("WEBSITE_RPC_PUBLIC_ORIGIN is required for insecure localhost cookies"); }
      if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) || origin.origin !== options.publicOrigin) {
        throw new Error("Insecure website RPC cookies require an exact HTTP localhost WEBSITE_RPC_PUBLIC_ORIGIN");
      }
    }
    this.secret = options.secret ?? randomBytes(32).toString("hex");
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private sign(claims: Claims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `wrpc.${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  private verify(value: string | undefined, kind: Claims["kind"]): Claims | undefined {
    if (!value || value.length > 1024) return;
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "wrpc") return;
    const body = parts[1]!;
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    const actual = Buffer.from(parts[2]!);
    if (actual.length !== signature.length || !timingSafeEqual(actual, Buffer.from(signature))) return;
    try {
      const c = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
      const now = this.now();
      // Allow small inter-replica clock skew at issuance, never grace after exp.
      if (c.v !== 1 || c.kind !== kind || typeof c.sid !== "string" || !/^[a-f0-9]{64}$/.test(c.sid) ||
          !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) ||
          c.iat > now + 5_000 || c.iat < 0 || c.exp <= now || c.exp <= c.iat ||
          c.exp - c.iat > (kind === "access" ? WEBSITE_RPC_TTL_MS : SESSION_TTL_MS)) return;
      return c;
    } catch { return; }
  }
  private cookieName(request: Request): string {
    // Use an explicitly configured public origin, never an internal proxy Host.
    return this.options.insecureLocalhost && request.headers.get("origin") === this.options.publicOrigin
      ? LOCAL_COOKIE : SECURE_COOKIE;
  }
  private session(request: Request): Claims | undefined {
    const name = this.cookieName(request);
    const matches = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
    if (matches.length !== 1) return;
    return this.verify(matches[0]!.slice(name.length + 1), "session");
  }
  issue(request: Request): Response {
    if (request.method !== "POST") return tokenResponse({ error: "Use POST" }, { status: 405, headers: { "cache-control": "no-store" } });
    const now = this.now();
    const existing = this.session(request);
    const session: Claims = existing ?? { v: 1, kind: "session", sid: randomBytes(32).toString("hex"), iat: now, exp: now + SESSION_TTL_MS };
    const expiresAt = Math.min(now + WEBSITE_RPC_TTL_MS, session.exp);
    const token = this.sign({ ...session, kind: "access", iat: now, exp: expiresAt });
    const headers = new Headers({ "cache-control": "no-store" });
    // Do not rotate a valid binding on refresh: other tabs still use that cookie.
    if (!existing) {
      const name = this.cookieName(request);
      headers.set("set-cookie", `${name}=${this.sign(session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${name === SECURE_COOKIE ? "; Secure" : ""}`);
    }
    return tokenResponse({ token, expiresAt, expiresInMs: expiresAt - now }, { headers });
  }
  accepts(request: Request): boolean {
    const auth = request.headers.get("authorization");
    const access = this.verify(auth?.startsWith("Bearer ") ? auth.slice(7) : undefined, "access");
    const session = this.session(request);
    return !!access && !!session && access.sid === session.sid && access.exp <= session.exp;
  }
}
