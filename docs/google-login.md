# Google login

Anonymous visitors retain all public explorer features. Any Google account may sign in and receives
identity/logout controls. The initial administrator is **sieciech.czajka@golem.network**; the backend
requires an exact normalized email allowlist match, `email_verified: true`, and Google's signed
Workspace claim `hd: "golem.network"`. Other Golem accounts do not become administrators.

Administrators can use Health, Admin settings and Baseload management, saved configurations,
the backend node relay and node/index comparisons. Public `/health`, `/sync`, `/baseload`, and index
reads remain available anonymously. The public experimental RPC is local-only and cannot invoke the
upstream forwarder, including in mixed batches.

## Configuration

Set these backend environment variables together:

```dotenv
GOOGLE_CLIENT_ID=<Google Web application client ID>
GOOGLE_CLIENT_SECRET=<Google Web application client secret>
AUTH_PUBLIC_ORIGIN=https://scanner.arkiv-global.net
AUTH_ADMIN_EMAILS=sieciech.czajka@golem.network
AUTH_SESSION_TTL_SECONDS=43200
```

Compose forwards these only to the backend. Never add them to Vite variables, image build arguments or
frontend runtime configuration. Leaving Google credentials absent disables Google login; a partial
credential pair fails startup. Without either login method, human admin access is refused. The email allowlist defaults to the address
above; an explicitly empty allowlist grants nobody administrator access.

In the Google Cloud console, use a **Web application** OAuth client and register exactly
`https://<deployment-host>/api/auth/google/callback` for each host. The consent audience must allow the
intended users; an Internal-only Workspace application excludes outside accounts. The previous credential
probe did not validate redirect registration, consent audience or an actual account login.

For local HTTP development, explicitly set:

```dotenv
AUTH_PUBLIC_ORIGIN=http://localhost:5173
AUTH_INSECURE_LOCALHOST=true
VITE_API_TARGET=http://127.0.0.1:3000
VITE_API_TARGET_STRIP_PREFIX=true
```

Register `http://localhost:5173/api/auth/google/callback` in Google. The origin must be the browser's
origin, not the direct backend URL. Production uses host-only `__Host-arkiv_session` and
`__Host-arkiv_login` cookies, with Secure, HttpOnly, SameSite=Lax and Path=/. Local development uses
separate `arkiv_dev_*` names. Each host has its own session; there is no cross-subdomain login.

## Optional Kalarepa token login

Kalarepa may offer **Admin login**, accepting an email address and its existing admin token. Enable this
only in Kalarepa's private backend environment:

```dotenv
AUTH_TOKEN_LOGIN_ENABLED=true
AUTH_TOKEN_LOGIN_TOKEN=<existing Kalarepa admin token>
AUTH_PUBLIC_ORIGIN=https://kalarepa.arkiv-global.net
```

The default is `AUTH_TOKEN_LOGIN_ENABLED=false`; keep that value on proper deployments and omit the
token. A token value alone does not enable login. The form and endpoint are disabled unless explicitly
enabled. Google login can coexist, or its client credentials can both be omitted for token-only login.

The token authorizes choosing any email. The normalized address `sieciech.czajka@golem.network` receives
Administrator; other addresses receive Logged In, using the current `AUTH_ADMIN_EMAILS` allowlist. This
does not verify ownership of the entered email. Token identities have provider `token` and remain
separate from Google identities, even for the same email.

`POST /api/auth/token-login` accepts JSON `{email,token}` only from the configured Origin, under the
shared 120/minute login cap and a 4 KiB body limit. It exchanges the token for the usual HttpOnly session;
the browser never saves the entered token or sends it as an API bearer credential. Protected writes
still require session CSRF. Disabling the option or changing its token rejects existing token sessions
on their next request; Google sessions continue to work. PostgreSQL stores only the token fingerprint
needed for this check, alongside the session hash. Additive columns preserve existing Google sessions.

## Sessions and revocation

`GET /api/auth/google/start?returnTo=/data` starts code-flow login with PKCE, browser-bound state and
nonce. The backend validates discovery, signature/JWKS, issuer, audience, expiry, nonce, subject and
applicable authorized-party claims using openid-client. Google tokens are discarded after extracting
identity metadata. Login-attempt consumption is atomic across backend instances; attempts expire in
10 minutes and their creation is capped at 120/minute per database across instances.

`GET /api/auth/session` returns `{role,user,csrfToken,expiresAt,loginAvailable,tokenLoginAvailable}`;
`loginAvailable` describes Google login. `user` includes the
internal ID, email, name and optional picture; no Google subject or provider tokens are returned.
`POST /api/auth/logout` revokes the session. Cookie-authenticated writes, logout and protected RPC
require the exact configured Origin and the session's `X-CSRF-Token` header. Sensitive responses are
no-store with no ETag or wildcard CORS. Public reads retain their existing shared caches.

Users are keyed by stable Google subject. PostgreSQL stores session-token hashes; the raw token exists
only briefly at issuance and in the HttpOnly cookie. Login rotates and revokes the replaced session.
Sessions have a 12-hour absolute default lifetime; privileges and disabled status are checked each
request. Google account changes are observed at the next login, bounded by that lifetime. To revoke all
sessions for a known internal user ID, delete its rows from `auth_sessions`; setting `auth_users.disabled_at`
disables that user. There is no role-management UI in this release.

The three auth tables and a bounded login-rate table are additive. `serve.ts` initializes them independently
of scanner transactions and removes expired sessions/attempts/rate buckets every minute. A store outage
returns 503 for protected requests; a Google outage does not disrupt existing local sessions. Audit events
use internal IDs and fixed action names, never email, subject, tokens, state or raw provider errors.

## Automation migration

Sign in as an administrator and open **Access tokens** beside the account controls. Enter a name and
validity of 1–30 days. Copy the token when created: only its SHA-256 hash is stored, and the secret is
never returned again. List or revoke your tokens from the same panel.

Send `Authorization: Bearer <access-token>` without a session cookie. Tokens authorize all administrator
API operations, including metrics, Baseload configurations and Shadow RPC. Token management itself
requires an administrator login session with Origin/CSRF checks: tokens cannot mint or revoke tokens.
Expiry, revocation, disabled accounts and the current administrator allowlist are checked on each use.
Tokens issued through the optional testing login also stop working when its login secret is rotated or disabled.

`METRICS_BEARER_TOKEN`, `BASELOAD_AUTOMATION_TOKEN` and `--metrics-bearer-token` no longer authorize
requests. `/metrics` stays open; deployment controls its external exposure. `/admin/metrics` requires
an admin session or generated access token. Replace off-host scraper credentials with generated access tokens and rotate them before their expiry (maximum 30 days).
For `scripts/rampBaseload.ts`, supply the generated token as `ARKIV_ACCESS_TOKEN` in the script environment.
This is a client credential, not backend configuration.

The management API is `GET /auth/access-tokens`, `POST /auth/access-tokens` with JSON
`{"name":"Automation","validityDays":30}`, and `DELETE /auth/access-tokens/:id` (public prefix `/api`).
Creation returns the token once plus metadata; list responses contain metadata only. Tokens remain valid
after logout until expiry or revocation, provided the issuing account remains an administrator.

See [Prometheus setup](prometheus.md). Actual deployed scraper credentials must be migrated during rollout;
repository changes do not change a running deployment.

## Proxy and rollout checks

The tracked nginx sites preserve Set-Cookie and disable access/error logging and proxy caching under
`/api/auth/`, so callback query credentials do not enter logs. Ensure any CDN, ingress and TLS terminator
also excludes callback query strings from logs and bypasses caching for auth/admin routes. Public deployment
requires HTTPS termination; the site's existing certbot/TLS setup is an operational prerequisite.
The frontend Node proxy passes each Set-Cookie header independently. Vite can explicitly strip `/api`
for a direct Bun target via `VITE_API_TARGET_STRIP_PREFIX=true`.

Before cutover, run ordinary offline tests and then isolated PostgreSQL integration tests using only
`TEST_DATABASE_URL`. Keep the preceding deployment available for an explicit rollback. Do not enable a
token login on proper deployments. Complete these opt-in checks through the real HTTPS origin with the account holder:

1. Public browsing works before login; the Sign in action starts Google on the registered callback.
2. The specified administrator's real token has verified email and signed `hd=golem.network`; no missing
   Workspace claim may silently grant admin.
3. A different Google account is Logged In, can browse and logout, and receives 403 on admin operations.
4. The administrator can use Health, saved Baseload configs and node comparisons; mutations require CSRF.
5. Logout, expiry and explicit revocation stop access on subsequent requests; other tabs drop admin views.
6. Off-host metrics and the ramp script work with only their assigned scopes, and the retired token fails.

Automated tests use a fake provider and store plus realistic signed JWTs and mocked discovery/JWKS
(including key rotation after the library's 60-second JWKS refresh throttle). Isolated DB tests cover
stable subjects, cross-instance atomic state consumption, session rotation/revocation, expiry and rates.
Real Google login, consent and HTTPS ingress behavior require the account holder and are not performed
by the offline suite.
