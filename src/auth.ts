import { recordResponseBytes } from "./serverMetrics";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthConfig } from "./authConfig";
import type { AuthIdentity, AuthSession, AuthStore, LoginAttempt } from "./authStorage";
import { GoogleOidcProvider, type OidcProvider } from "./googleOidc";

export type AuthRole = "anonymous" | "user" | "admin";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ATTEMPT_TTL = 600_000;
export const randomToken = (): string => randomBytes(32).toString("base64url");
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export function secretEqual(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(tokenHash(a), "hex"), Buffer.from(tokenHash(b), "hex"));
}
export function roleForIdentity(identity: AuthIdentity, adminEmails: ReadonlySet<string>): "user" | "admin" {
  return identity.emailVerified && identity.hostedDomain === "golem.network" &&
    adminEmails.has(identity.email.trim().toLowerCase()) ? "admin" : "user";
}
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://local.invalid");
    // Encoded backslashes/control characters must not change the destination after another decoding layer.
    const decoded = decodeURIComponent(value);
    // Dot segments can also normalise into a protocol-relative "//host" path ("/..//evil"), so check the parsed path too.
    if (url.origin !== "https://local.invalid" || decoded.startsWith("//") || url.pathname.startsWith("//") || /[\\\x00-\x20\x7f]/.test(decoded) || url.pathname.startsWith("/api/")) return "/";
    return url.pathname + url.search + url.hash;
  } catch { return "/"; }
}
export function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.delete("ETag");
  for (const key of [...response.headers.keys()]) if (key.startsWith("access-control-")) response.headers.delete(key);
  return response;
}
function authJson(body: unknown, init: ResponseInit = {}): Response {
  const json = JSON.stringify(body);
  return recordResponseBytes(new Response(json,{...init,headers:{"Content-Type":"application/json"}}),Buffer.byteLength(json));
}
export function authError(status: number, error: string): Response {
  return privateResponse(authJson({ error }, { status }));
}
export function anonymousSession(loginAvailable = false, tokenLoginAvailable = false): Response {
  return privateResponse(authJson({ role:"anonymous",user:null,csrfToken:null,expiresAt:null,loginAvailable,tokenLoginAvailable }));
}

export class AuthService {
  readonly sessionCookie: string;
  readonly attemptCookie: string;
  private readonly provider: OidcProvider | undefined;
  constructor(readonly config: AuthConfig, private readonly store: AuthStore, provider?: OidcProvider,
    private readonly now: () => number = Date.now) {
    this.sessionCookie = config.insecureLocalhost ? "arkiv_dev_session" : "__Host-arkiv_session";
    this.attemptCookie = config.insecureLocalhost ? "arkiv_dev_login" : "__Host-arkiv_login";
    this.provider = config.clientId && config.clientSecret ? provider ?? new GoogleOidcProvider(config) : undefined;
  }
  private readCookie(request: Request, name: string): string | null {
    const matches = (request.headers.get("cookie") ?? "").split(";").map((v) => v.trim())
      .filter((v) => v.startsWith(`${name}=`));
    if (matches.length !== 1) return null;
    const token = matches[0]!.slice(name.length + 1);
    return TOKEN_PATTERN.test(token) ? token : null;
  }
  hasSessionCookie(request: Request): boolean {
    return (request.headers.get("cookie") ?? "").split(";").some((v) => v.trim().startsWith(`${this.sessionCookie}=`));
  }
  private cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.config.insecureLocalhost ? "" : "; Secure"}`;
  }
  private hashFromRequest(request: Request): string | null {
    const token = this.readCookie(request, this.sessionCookie);
    return token ? tokenHash(token) : null;
  }
  private async session(request: Request): Promise<AuthSession | null> {
    const hash = this.hashFromRequest(request);
    const session = hash ? await this.store.getSession(hash, this.now()) : null;
    if (!session || session.user.disabled || session.expiresAt <= this.now()) return null;
    if (session.user.provider === "token" && (!this.config.tokenLoginToken ||
      !session.tokenLoginKeyHash || !secretEqual(session.tokenLoginKeyHash, tokenHash(this.config.tokenLoginToken)))) return null;
    return session;
  }
  private role(identity: AuthIdentity): "user" | "admin" {
    if (identity.provider === "token") return this.config.adminEmails.has(identity.email.trim().toLowerCase()) ? "admin" : "user";
    return roleForIdentity(identity, this.config.adminEmails);
  }
  private checkOrigin(request: Request, required = false): boolean {
    const origin = request.headers.get("origin");
    return origin ? origin === this.config.publicOrigin : !required && request.headers.get("sec-fetch-site") !== "cross-site";
  }
  private checkCsrf(request: Request, session: AuthSession): boolean {
    const token = request.headers.get("X-CSRF-Token");
    return this.checkOrigin(request, true) && !!token && secretEqual(token, session.csrfToken);
  }
  async requireUser(request: Request, admin = false): Promise<Response | null> {
    try {
      if (request.headers.has("authorization")) return authError(401, "Use a login session for this operation");
      const session = await this.session(request);
      if (!session) return authError(401, "Sign in required");
      if (admin && this.role(session.user) !== "admin") return authError(403, "Administrator access required");
      if (!this.checkOrigin(request)) return authError(403, "Request origin is not allowed");
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !this.checkCsrf(request, session)) return authError(403, "Invalid CSRF token or origin");
      if (admin && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const path = new URL(request.url).pathname;
        const action = path === "/shadow-rpc" ? "node_rpc" : path === "/baseload" ? "baseload_update" : "baseload_config_change";
        console.info("auth audit", { userId:session.user.id,action });
      }
      return null;
    } catch { return authError(503, "Authentication is temporarily unavailable"); }
  }
  async requireAdmin(request: Request): Promise<Response | null> { return this.requireUser(request, true); }
  async requireAccessToken(request: Request): Promise<Response | null> {
    if (hasApplicationSessionCookie(request)) return authError(400,"Choose a session or an access token, not both");
    const match = /^Bearer (arkiv_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
    if (!match) return authError(401,"Invalid access token");
    try {
      const token = await this.store.getAccessToken(tokenHash(match[1]!),this.now());
      if (!token || token.revokedAt !== null || token.expiresAt <= this.now() || token.user.disabled) return authError(401,"Invalid or expired access token");
      if (token.user.provider === "token" && (!this.config.tokenLoginToken || !token.tokenLoginKeyHash ||
        !secretEqual(token.tokenLoginKeyHash,tokenHash(this.config.tokenLoginToken)))) return authError(401,"Invalid access token");
      if (this.role(token.user) !== "admin") return authError(403,"Administrator access required");
      // Browser-origin requests must still come from the configured application.
      if (!this.checkOrigin(request)) return authError(403,"Request origin is not allowed");
      console.info("auth audit",{userId:token.user.id,tokenId:token.id,action:"access_token_use"});
      return null;
    } catch { return authError(503,"Authentication is temporarily unavailable"); }
  }
  private async handleAccessTokens(request: Request): Promise<Response> {
    const denied = await this.requireAdmin(request);
    if (denied) return denied;
    const session = await this.session(request);
    if (!session) return authError(401,"Sign in required");
    const path = new URL(request.url).pathname;
    if (path === "/auth/access-tokens" && request.method === "GET") {
      return privateResponse(authJson({tokens:await this.store.listAccessTokens(session.user.id)}));
    }
    if (path === "/auth/access-tokens" && request.method === "POST") {
      const reader = request.body?.getReader();
      if (!reader) return authError(400,"Token name and validity are required");
      const chunks: Uint8Array[]=[]; let size=0;
      try { while(true) { const {done,value}=await reader.read(); if(done) break;
        size+=value.byteLength; if(size>4096) { await reader.cancel(); return authError(413,"Request is too large"); } chunks.push(value);
      } } finally { reader.releaseLock(); }
      let body: unknown;
      try { body=JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return authError(400,"Invalid JSON"); }
      if (!body || typeof body !== "object" || !("name" in body) || !("validityDays" in body) ||
        typeof body.name !== "string" || !body.name.trim() || body.name.trim().length>100 || typeof body.validityDays !== "number" ||
        !Number.isInteger(body.validityDays) || body.validityDays<1 || body.validityDays>30) return authError(400,"Provide a name and validityDays from 1 to 30");
      const createdAt=this.now();
      const metadata={id:crypto.randomUUID(),name:body.name.trim(),createdAt,expiresAt:createdAt+body.validityDays*86400000,revokedAt:null};
      const token="arkiv_"+randomToken();
      await this.store.createAccessToken(session.user.id,tokenHash(token),metadata,session.tokenLoginKeyHash ?? null);
      console.info("auth audit",{userId:session.user.id,tokenId:metadata.id,action:"access_token_create"});
      return privateResponse(authJson({...metadata,token},{status:201}));
    }
    const id=path.slice("/auth/access-tokens/".length);
    if (path.startsWith("/auth/access-tokens/") && request.method === "DELETE" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      await this.store.revokeAccessToken(session.user.id,id,this.now());
      console.info("auth audit",{userId:session.user.id,tokenId:id,action:"access_token_revoke"});
      return privateResponse(new Response(null,{status:204}));
    }
    return authError(405,"Unsupported access token route or method");
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/auth/access-tokens" || url.pathname.startsWith("/auth/access-tokens/")) return await this.handleAccessTokens(request);
      if (url.pathname === "/auth/session" && request.method === "GET") {
        if (!this.checkOrigin(request)) return authError(403, "Request origin is not allowed");
        const session = await this.session(request);
        if (!session) return anonymousSession(!!this.provider, !!this.config.tokenLoginToken);
        const { user } = session;
        return privateResponse(authJson({ role:this.role(user),
          user:{id:user.id,email:user.email,name:user.name,...(user.picture ? {picture:user.picture} : {})},
          csrfToken:session.csrfToken,expiresAt:new Date(session.expiresAt).toISOString(),
          loginAvailable:!!this.provider,tokenLoginAvailable:!!this.config.tokenLoginToken }));
      }
      if (url.pathname === "/auth/token-login") {
        if (!this.config.tokenLoginToken) return authError(404, "Token login is disabled");
        if (request.method !== "POST") return authError(405, "Use POST to sign in");
        if (!this.checkOrigin(request, true)) return authError(403, "Request origin is not allowed");
        if (request.headers.has("authorization")) return authError(400, "Submit the token in the login form");
        if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return authError(415, "Expected JSON");
        if (!await this.store.allowTokenLoginAttempt(this.now())) return authError(429, "Too many login attempts. Please retry later.");
        if (Number(request.headers.get("content-length")) > 4096) return authError(413, "Login request is too large");
        const reader = request.body?.getReader();
        if (!reader) return authError(400, "Email and admin token are required");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) { await reader.cancel(); return authError(413, "Login request is too large"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { return authError(400, "Invalid login request"); }
        if (!body || typeof body !== "object" || !("email" in body) || !("token" in body) ||
          typeof body.email !== "string" || typeof body.token !== "string") return authError(400, "Email and admin token are required");
        const email = body.email.trim().toLowerCase();
        if (email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email)) return authError(400, "Enter a valid email address");
        if (!secretEqual(body.token, this.config.tokenLoginToken)) return authError(401, "Invalid admin token");
        const token = randomToken();
        const user = await this.store.createSession({provider:"token",sub:`token:${tokenHash(email)}`,email,
          emailVerified:false,hostedDomain:null,name:email,picture:null}, tokenHash(token),randomToken(),
          this.now()+this.config.sessionTtlSeconds*1000,this.hashFromRequest(request),tokenHash(this.config.tokenLoginToken));
        if (!user) return authError(403, "This account is disabled");
        console.info("auth audit", {userId:user.id,action:"token_login"});
        return privateResponse(new Response(null,{status:204,headers:{"Set-Cookie":this.cookie(this.sessionCookie,token,this.config.sessionTtlSeconds)}}));
      }
      if (url.pathname === "/auth/google/start" && request.method === "GET") {
        if (!this.provider) return authError(503, "Google login is not configured");
        if (!this.checkOrigin(request)) return authError(403, "Request origin is not allowed");
        const state = randomToken(), binding = randomToken();
        const attempt: LoginAttempt = { stateHash:tokenHash(state),bindingHash:tokenHash(binding),verifier:randomToken(),
          nonce:randomToken(),returnTo:safeReturnPath(url.searchParams.get("returnTo")),expiresAt:this.now()+ATTEMPT_TTL };
        if (!await this.store.createAttempt(attempt, this.now())) return authError(429, "Too many login attempts. Please retry later.");
        let location: string;
        try { location = await this.provider.authorizationUrl(state, attempt); }
        catch { return authError(503, "Google login is temporarily unavailable. Please retry."); }
        return privateResponse(new Response(null,{ status:302,headers:{ Location:location,
          "Set-Cookie":this.cookie(this.attemptCookie,binding,ATTEMPT_TTL/1000) } }));
      }
      if (url.pathname === "/auth/google/callback" && request.method === "GET") {
        if (!this.provider) return authError(503, "Google login is not configured");
        const state = url.searchParams.get("state"), binding = this.readCookie(request,this.attemptCookie);
        if (!state || !TOKEN_PATTERN.test(state) || !binding || url.searchParams.getAll("state").length !== 1) return authError(400,"Login attempt is invalid or expired. Please sign in again.");
        const attempt = await this.store.consumeAttempt(tokenHash(state),tokenHash(binding),this.now());
        if (!attempt) return authError(400,"Login attempt is invalid or expired. Please sign in again.");
        const headers = new Headers({ Location:attempt.returnTo });
        headers.append("Set-Cookie",this.cookie(this.attemptCookie,"",0));
        let identity: AuthIdentity;
        try {
          // Never derive the callback origin or prefix from forwarded/request headers.
          const callback = new URL(`${this.config.publicOrigin}/api/auth/google/callback`);
          callback.search = url.search;
          identity = await this.provider.authenticate(callback,state,attempt);
        } catch {
          const target = new URL(attempt.returnTo,this.config.publicOrigin);
          target.searchParams.set("authError",url.searchParams.get("error") === "access_denied" ? "cancelled" : "failed");
          headers.set("Location",target.pathname+target.search+target.hash);
          console.info("auth audit", {action:"login_failed"});
          return privateResponse(new Response(null,{status:302,headers}));
        }
        const token = randomToken();
        const user = await this.store.createSession(identity,tokenHash(token),randomToken(),
          this.now()+this.config.sessionTtlSeconds*1000,this.hashFromRequest(request));
        if (!user) return authError(403,"This account is disabled");
        headers.append("Set-Cookie",this.cookie(this.sessionCookie,token,this.config.sessionTtlSeconds));
        console.info("auth audit", {userId:user.id,action:"login"});
        return privateResponse(new Response(null,{status:302,headers}));
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        const denied = await this.requireUser(request);
        if (denied) return denied;
        await this.store.revokeSession(this.hashFromRequest(request)!);
        return privateResponse(new Response(null,{status:204,headers:{"Set-Cookie":this.cookie(this.sessionCookie,"",0)}}));
      }
      return authError(405,"Unsupported authentication route or method");
    } catch { return authError(503,"Authentication is temporarily unavailable. Please retry."); }
  }
}

export function hasApplicationSessionCookie(request: Request): boolean {
  return /(?:^|;\s*)(?:__Host-arkiv_session|arkiv_dev_session)=/.test(request.headers.get("cookie") ?? "");
}
export async function requireAdmin(request: Request, auth?: AuthService): Promise<Response | null> {
  if (request.headers.has("authorization")) return auth ? auth.requireAccessToken(request) : authError(401,"Invalid access token");
  return auth ? auth.requireAdmin(request) : authError(503,"Google login is not configured");
}
export async function requireUser(request: Request, auth?: AuthService): Promise<Response | null> {
  return auth ? auth.requireUser(request) : authError(503,"Google login is not configured");
}
