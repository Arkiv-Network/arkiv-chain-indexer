import { AuthService, tokenHash } from "./auth";
import type { AuthConfig } from "./authConfig";
import type { AccessToken, AccessCredential, AuthIdentity, AuthSession, AuthStore, AuthUser, LoginAttempt } from "./authStorage";

export const TEST_AUTH_CONFIG: AuthConfig = {
  clientId:"test-client",clientSecret:"test-secret",publicOrigin:"https://explorer.test",
  adminEmails:new Set(["sieciech.czajka@golem.network"]),sessionTtlSeconds:43_200,insecureLocalhost:false,
};
export const TEST_ADMIN: AuthUser = { id:"00000000-0000-4000-8000-000000000001",sub:"google-sub",email:"sieciech.czajka@golem.network",
  emailVerified:true,hostedDomain:"golem.network",name:"Test Admin",picture:null,disabled:false };
export class MemoryAuthStore implements AuthStore {
  accessTokens = new Map<string,AccessCredential>();
  async createAccessToken(userId: string, hash: string, token: AccessToken, keyHash: string | null): Promise<void> {
    const user = [...this.users.values(), ...[...this.sessions.values()].map(s=>s.user)].find(u=>u.id===userId)!;
    this.accessTokens.set(hash,{...token,user,tokenLoginKeyHash:keyHash});
  }
  async listAccessTokens(userId: string): Promise<AccessToken[]> { return [...this.accessTokens.values()].filter(t=>t.user.id===userId).map(({user,tokenLoginKeyHash,...t})=>t); }
  async revokeAccessToken(userId: string,id: string,now: number): Promise<void> { for(const t of this.accessTokens.values()) if(t.user.id===userId && t.id===id) t.revokedAt=now; }
  async getAccessToken(hash: string,now: number): Promise<AccessCredential|null> {
    const t=this.accessTokens.get(hash); if(!t || t.expiresAt<=now || t.revokedAt!==null) return null;
    return {...t,user:this.users.get(t.user.sub) ?? t.user};
  }
  attempts = new Map<string,LoginAttempt>();
  sessions = new Map<string,AuthSession>();
  users = new Map<string,AuthUser>();
  async allowTokenLoginAttempt(): Promise<boolean> { return true; }
  async createAttempt(attempt: LoginAttempt): Promise<boolean> { this.attempts.set(attempt.stateHash,attempt); return true; }
  async consumeAttempt(stateHash: string,bindingHash: string,now: number): Promise<LoginAttempt|null> {
    const attempt = this.attempts.get(stateHash);
    if (!attempt || attempt.bindingHash !== bindingHash || attempt.expiresAt <= now) return null;
    this.attempts.delete(stateHash); return attempt;
  }
  async createSession(identity: AuthIdentity,tokenHash: string,csrfToken: string,expiresAt: number,replacedHash: string|null,tokenLoginKeyHash?: string): Promise<AuthUser|null> {
    const existing = this.users.get(identity.sub);
    if (existing && (existing.provider ?? "google") !== (identity.provider ?? "google")) return null;
    const user = {...identity,id:existing?.id ?? crypto.randomUUID(),disabled:existing?.disabled ?? false};
    this.users.set(identity.sub,user);
    if (replacedHash) this.sessions.delete(replacedHash);
    if (user.disabled) return null;
    this.sessions.set(tokenHash,{user,csrfToken,expiresAt,tokenLoginKeyHash:tokenLoginKeyHash ?? null}); return user;
  }
  async getSession(hash: string,now: number): Promise<AuthSession|null> {
    const session = this.sessions.get(hash);
    if (!session || session.expiresAt <= now) return null;
    const user = this.users.get(session.user.sub) ?? session.user;
    return user.disabled ? null : {...session,user};
  }
  async revokeSession(hash: string): Promise<void> { this.sessions.delete(hash); }
  async cleanup(now: number): Promise<void> {
    for (const [key,s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(key);
    for (const [key,a] of this.attempts) if (a.expiresAt <= now) this.attempts.delete(key);
  }
}
export const TEST_SESSION_TOKEN = "a".repeat(43);
export const testAdminHeaders = { Cookie:`__Host-arkiv_session=${TEST_SESSION_TOKEN}`,Origin:TEST_AUTH_CONFIG.publicOrigin,"X-CSRF-Token":"test-csrf" };
export function testAuth(user: AuthUser = TEST_ADMIN): AuthService {
  const store = new MemoryAuthStore();
  store.sessions.set(tokenHash(TEST_SESSION_TOKEN),{user,csrfToken:"test-csrf",expiresAt:Date.now()+3_600_000});
  return new AuthService(TEST_AUTH_CONFIG,store);
}
