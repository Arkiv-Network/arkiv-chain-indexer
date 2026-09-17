import { AccessTokens } from "./AccessTokens";
import { useState } from "react";
import { googleLoginUrl } from "./authClient";
import type { useAuth } from "./useAuth";

export function AccountControls({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const { session, loading, busy, error } = auth;
  const [showAccessTokens, setShowAccessTokens] = useState(false);
  const [showTokenLogin, setShowTokenLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  return (
    <div className="account-controls">
      {loading ? <span className="muted">Checking sign-in…</span> : session.user ? (
        <>
          <span className="account-identity" title={session.user.email}>
            <strong>{session.user.name || session.user.email}</strong>
            <small>{session.role === "admin" ? "Administrator" : "Logged In"}</small>
          </span>
          {session.role === "admin" && session.csrfToken ? <>
            <button type="button" className="secondary" onClick={() => setShowAccessTokens(v => !v)}>Access tokens</button>
            {showAccessTokens && <AccessTokens key={session.user.id} csrfToken={session.csrfToken} />}
          </> : null}
          <button type="button" className="secondary" onClick={() => { setShowAccessTokens(false); void auth.logout(); }} disabled={busy}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </>
      ) : session.loginAvailable || session.tokenLoginAvailable ? (
        <>
        {session.loginAvailable ? (
        <a className="google-login-button" href={googleLoginUrl(window.location.pathname + window.location.search + window.location.hash)}>
          Sign in with Google
        </a>
        ) : null}
        {session.tokenLoginAvailable ? (
          <button type="button" className="secondary" onClick={() => setShowTokenLogin(true)} disabled={busy}>Admin login</button>
        ) : null}
        {session.tokenLoginAvailable && showTokenLogin ? (
          <form className="token-login-form" onSubmit={(event) => {
            event.preventDefault();
            const submittedToken = token;
            setToken("");
            void auth.loginWithToken(email, submittedToken).then((ok) => { if (ok) setShowTokenLogin(false); });
          }}>
            <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="username" required disabled={busy} /></label>
            <label>Admin token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" required disabled={busy} /></label>
            <div className="token-login-actions">
              <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => { setShowTokenLogin(false); setToken(""); }}>Cancel</button>
            </div>
          </form>
        ) : null}
        </>
      ) : (
        <span className="muted">{error ? "Sign-in unavailable" : "Browsing anonymously"}</span>
      )}
      {error ? (
        <span className="account-error" role="status">
          {error} <button type="button" className="secondary" onClick={() => void auth.refresh()}>Retry</button>
        </span>
      ) : null}
    </div>
  );
}
