# Website RPC sessions

`POST /entity-explorer/rpc` and `POST /shadow-rpc/experimental` now require a website
RPC token and its matching browser cookie, or existing administrator credentials.
The frontend exposes these paths under `/api`. `/shadow-rpc` remains admin-only.
No login or challenge is required for ordinary website visitors.

Website RPC access is reserved for supported browser interactions and explicitly
authorized clients. Unauthorized automated RPC use violates the service's terms
of use. Do not automate the anonymous website handshake; use operator-authorized
administrator credentials for diagnostic tooling.

## Browser flow

The shared async token manager calls `POST /api/website-rpc/token`, stores the
short-lived access token in `localStorage`, and sends it as a bearer token with a
host-only, HttpOnly, Secure, SameSite=Strict binding cookie. Both SDK entity queries
and byte-loading requests use that manager. Credentials are attached only to the
two known same-origin RPC paths; custom nodes receive neither tokens nor cookies.

The backend signs purpose-specific session and access claims and enforces a maximum
access-token lifetime of 120 seconds. The browser checks every 60 seconds and
refreshes before RPC calls when needed, including after background-tab suspension.
Concurrent requests share one pending refresh. One HTTP 401 triggers one refresh
and retry, covering expired credentials, server restarts and first-visit tab races.
Clock skew is handled by scheduling from the returned remaining lifetime.
Unavailable localStorage falls back to memory. The binding cookie lasts 24 hours
and is reused during refresh; it alone cannot authorize RPC.

Token issuance and gated RPC responses are private/no-store. This mechanism is
independent of Google login and never grants administrator permissions. Existing
method allowlists, request-size limits, and relay rate limits still apply.

## Deployment

- Set `WEBSITE_RPC_TOKEN_SECRET` to a random value of at least 32 bytes, identical
  on every backend replica (`openssl rand -hex 32`). Keep it out of frontend config.
- With no secret, the backend warns and uses a random process-local key. This is
  suitable only for one backend process. Restarting invalidates sessions; the next
  refresh establishes a new one. Multiple replicas with different keys will fail
  intermittently and must not be deployed that way.
- Use HTTPS. For HTTP localhost development only, set
  `WEBSITE_RPC_INSECURE_LOCALHOST=true` and `WEBSITE_RPC_PUBLIC_ORIGIN` to its exact
  HTTP localhost origin (for example `http://localhost:5173`). Insecure cookies
  require that request Origin; internal proxy hostnames never authorize them.
- Deploy backend and frontend together. Old frontend bundles receive HTTP 401
  until the page reloads. There are no database migrations.
- Existing administrator access tokens, or administrator sessions with Origin and
  CSRF headers, authorize both RPC paths for explicit diagnostic work. Browser RPC
  credentials coexist with administrator cookies but never authorize admin routes.
- `compareEntityQuery.ts` accepts an existing temporary admin access token through
  `INDEX_RPC_ACCESS_TOKEN`, or `--admin-token-file` and `--admin-email` for the
  explicitly enabled token-login test environment. These credentials go only to
  the index target, never the node target. `verifyUdcExplorer.ts` reuses its existing
  administrator headers for experimental queries. The UDC harness passes its
  configured admin login to both tools.

## Limits

This is a deterrent to casual external reuse, not proof that a request came from
the website. A script can reproduce anonymous issuance and retain the cookie.
The usage notice is a policy statement, not an enforcement mechanism. Anyone with
JavaScript execution on this origin can read localStorage tokens; do not store
administrator or upstream secrets there. Stronger controls would require an
identity/challenge and shared per-client budgets, which are outside this change.
