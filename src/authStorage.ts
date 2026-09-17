import { openDb, type Db, type DbQueryable } from "./db";

export interface AuthIdentity {
  provider?: "google" | "token";
  sub: string;
  email: string;
  emailVerified: boolean;
  hostedDomain: string | null;
  name: string;
  picture: string | null;
}
export interface AuthUser extends AuthIdentity { id: string; disabled: boolean }
export interface AuthSession { user: AuthUser; csrfToken: string; expiresAt: number; tokenLoginKeyHash?: string | null }
export interface LoginAttempt {
  stateHash: string;
  bindingHash: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}
export interface AccessToken { id: string; name: string; createdAt: number; expiresAt: number; revokedAt: number | null }
export interface AccessCredential extends AccessToken { user: AuthUser; tokenLoginKeyHash: string | null }
export interface AuthStore {
  createAccessToken(userId: string, hash: string, token: AccessToken, tokenLoginKeyHash: string | null): Promise<void>;
  listAccessTokens(userId: string): Promise<AccessToken[]>;
  revokeAccessToken(userId: string, id: string, now: number): Promise<void>;
  getAccessToken(hash: string, now: number): Promise<AccessCredential | null>;
  allowTokenLoginAttempt(now: number): Promise<boolean>;
  createAttempt(attempt: LoginAttempt, now: number): Promise<boolean>;
  consumeAttempt(stateHash: string, bindingHash: string, now: number): Promise<LoginAttempt | null>;
  createSession(identity: AuthIdentity, tokenHash: string, csrfToken: string, expiresAt: number, replacedHash: string | null, tokenLoginKeyHash?: string): Promise<AuthUser | null>;
  getSession(tokenHash: string, now: number): Promise<AuthSession | null>;
  revokeSession(tokenHash: string): Promise<void>;
  cleanup(now: number): Promise<void>;
}

/** Authentication is deliberately independent of scanner block transactions. */
export class AuthStorage implements AuthStore {
  private readonly prefix: string;
  constructor(private readonly db: Db, schema = "public") {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error("Invalid auth schema");
    this.prefix = `"${schema}".`;
  }
  static async open(url: string): Promise<AuthStorage> {
    const store = new AuthStorage(openDb(url, { max: 4 }));
    try { await store.initialize(); return store; } catch (error) { await store.close(); throw error; }
  }
  async initialize(): Promise<void> {
    const p = this.prefix;
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${p}auth_users (
      id uuid PRIMARY KEY, google_sub text UNIQUE NOT NULL, email text NOT NULL,
      email_verified boolean NOT NULL, hosted_domain text, name text NOT NULL, picture text,
      created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz
    )`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${p}auth_sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES ${p}auth_users(id) ON DELETE CASCADE,
      csrf_token text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at bigint NOT NULL
    )`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON ${p}auth_sessions(expires_at)`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${p}auth_login_attempts (
      state_hash text PRIMARY KEY, binding_hash text NOT NULL, verifier text NOT NULL, nonce text NOT NULL,
      return_to text NOT NULL, expires_at bigint NOT NULL
    )`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS auth_attempts_expiry ON ${p}auth_login_attempts(expires_at)`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${p}auth_login_rates (minute bigint PRIMARY KEY, count integer NOT NULL)`);
    await this.db.query(`ALTER TABLE ${p}auth_users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'google'
      CHECK (auth_provider IN ('google', 'token'))`);
    await this.db.query(`ALTER TABLE ${p}auth_sessions ADD COLUMN IF NOT EXISTS token_login_key_hash text`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${p}auth_access_tokens (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES ${p}auth_users(id) ON DELETE CASCADE,
      token_hash text UNIQUE NOT NULL, name text NOT NULL,
      created_at bigint NOT NULL, expires_at bigint NOT NULL, revoked_at bigint, token_login_key_hash text,
      CHECK (expires_at > created_at AND expires_at <= created_at + 2592000000)
    )`);
    await this.db.query(`CREATE INDEX IF NOT EXISTS auth_access_tokens_user ON ${p}auth_access_tokens(user_id)`);
  }
  private async allowLoginAttempt(tx: DbQueryable, now: number): Promise<boolean> {
    const rate = await tx.query(`INSERT INTO ${this.prefix}auth_login_rates AS r (minute,count) VALUES ($1,1)
      ON CONFLICT (minute) DO UPDATE SET count=r.count+1 WHERE r.count < 120 RETURNING count`, [Math.floor(now / 60_000)]);
    return rate.rowCount > 0;
  }
  async allowTokenLoginAttempt(now: number): Promise<boolean> {
    return this.allowLoginAttempt(this.db, now);
  }
  async createAttempt(a: LoginAttempt, now: number): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // One shared cap across backend instances, no spoofable forwarded IP or unbounded map.
      if (!await this.allowLoginAttempt(tx, now)) return false;
      await tx.query(`INSERT INTO ${this.prefix}auth_login_attempts VALUES ($1,$2,$3,$4,$5,$6)`,
        [a.stateHash,a.bindingHash,a.verifier,a.nonce,a.returnTo,a.expiresAt]);
      return true;
    });
  }
  async consumeAttempt(stateHash: string, bindingHash: string, now: number): Promise<LoginAttempt | null> {
    const { rows } = await this.db.query<AttemptRow>(`DELETE FROM ${this.prefix}auth_login_attempts
      WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>$3 RETURNING *`, [stateHash,bindingHash,now]);
    const r = rows[0];
    return r ? { stateHash:r.state_hash,bindingHash:r.binding_hash,verifier:r.verifier,nonce:r.nonce,returnTo:r.return_to,expiresAt:Number(r.expires_at) } : null;
  }
  async createSession(i: AuthIdentity, tokenHash: string, csrfToken: string, expiresAt: number, replacedHash: string | null, tokenLoginKeyHash?: string): Promise<AuthUser | null> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<UserRow>(`INSERT INTO ${this.prefix}auth_users AS u
        (id,google_sub,email,email_verified,hosted_domain,name,picture,auth_provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (google_sub) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,
        hosted_domain=EXCLUDED.hosted_domain,name=EXCLUDED.name,picture=EXCLUDED.picture,last_login_at=now()
        WHERE u.auth_provider=EXCLUDED.auth_provider RETURNING *`,
        [crypto.randomUUID(),i.sub,i.email,i.emailVerified,i.hostedDomain,i.name,i.picture,i.provider ?? "google"]);
      if (!rows[0]) return null;
      const row = rows[0]!;
      if (replacedHash) await tx.query(`DELETE FROM ${this.prefix}auth_sessions WHERE token_hash=$1`, [replacedHash]);
      if (row.disabled_at) return null;
      await tx.query(`INSERT INTO ${this.prefix}auth_sessions (token_hash,user_id,csrf_token,expires_at,token_login_key_hash) VALUES ($1,$2,$3,$4,$5)`,
        [tokenHash,row.id,csrfToken,expiresAt,tokenLoginKeyHash ?? null]);
      return userFromRow(row);
    });
  }
  async getSession(tokenHash: string, now: number): Promise<AuthSession | null> {
    const { rows } = await this.db.query<UserRow & {csrf_token:string;expires_at:string;token_login_key_hash:string|null}>(
      `SELECT u.*,s.csrf_token,s.expires_at,s.token_login_key_hash FROM ${this.prefix}auth_sessions s JOIN ${this.prefix}auth_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.disabled_at IS NULL`, [tokenHash,now]);
    const r = rows[0];
    return r ? { user:userFromRow(r),csrfToken:r.csrf_token,expiresAt:Number(r.expires_at),tokenLoginKeyHash:r.token_login_key_hash } : null;
  }
  async createAccessToken(userId: string, hash: string, t: AccessToken, keyHash: string | null): Promise<void> {
    await this.db.query(`INSERT INTO ${this.prefix}auth_access_tokens
      (id,user_id,token_hash,name,created_at,expires_at,token_login_key_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t.id,userId,hash,t.name,t.createdAt,t.expiresAt,keyHash]);
  }
  async listAccessTokens(userId: string): Promise<AccessToken[]> {
    const {rows} = await this.db.query<AccessRow>(`SELECT * FROM ${this.prefix}auth_access_tokens WHERE user_id=$1 ORDER BY created_at DESC`,[userId]);
    return rows.map(accessFromRow);
  }
  async revokeAccessToken(userId: string, id: string, now: number): Promise<void> {
    await this.db.query(`UPDATE ${this.prefix}auth_access_tokens SET revoked_at=COALESCE(revoked_at,$3) WHERE user_id=$1 AND id=$2`,[userId,id,now]);
  }
  async getAccessToken(hash: string, now: number): Promise<AccessCredential | null> {
    const {rows} = await this.db.query<UserRow & AccessRow & {access_id:string}>(`SELECT u.*,t.id AS access_id,t.name AS token_name,t.created_at AS token_created_at,t.expires_at,t.revoked_at,t.token_login_key_hash
      FROM ${this.prefix}auth_access_tokens t JOIN ${this.prefix}auth_users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.expires_at>$2 AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,[hash,now]);
    const r=rows[0];
    return r ? {...accessFromRow({...r,id:r.access_id}),user:userFromRow(r),tokenLoginKeyHash:r.token_login_key_hash} : null;
  }
  async revokeSession(hash: string): Promise<void> { await this.db.query(`DELETE FROM ${this.prefix}auth_sessions WHERE token_hash=$1`,[hash]); }
  async cleanup(now: number): Promise<void> {
    await this.db.query(`DELETE FROM ${this.prefix}auth_sessions WHERE expires_at<=$1`,[now]);
    await this.db.query(`DELETE FROM ${this.prefix}auth_login_attempts WHERE expires_at<=$1`,[now]);
    await this.db.query(`DELETE FROM ${this.prefix}auth_login_rates WHERE minute<$1`,[Math.floor(now / 60_000)]);
  }
  async close(): Promise<void> { await this.db.close(); }
}
interface UserRow { id:string;google_sub:string;email:string;email_verified:boolean;hosted_domain:string|null;name:string;picture:string|null;disabled_at:unknown;auth_provider:"google"|"token" }
interface AttemptRow { state_hash:string;binding_hash:string;verifier:string;nonce:string;return_to:string;expires_at:string }
function userFromRow(r: UserRow): AuthUser {
  return { id:r.id,sub:r.google_sub,email:r.email,emailVerified:r.email_verified,hostedDomain:r.hosted_domain,name:r.name,picture:r.picture,disabled:Boolean(r.disabled_at),provider:r.auth_provider };
}

interface AccessRow { id:string; name:string; token_name?:string; created_at:string; token_created_at?:string; expires_at:string; revoked_at:string|null; token_login_key_hash:string|null }
function accessFromRow(r: AccessRow): AccessToken {
  return {id:r.id,name:r.token_name ?? r.name,createdAt:Number(r.token_created_at ?? r.created_at),expiresAt:Number(r.expires_at),revokedAt:r.revoked_at === null ? null : Number(r.revoked_at)};
}
