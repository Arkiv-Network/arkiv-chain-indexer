import { useEffect, useState } from "react";
import { authenticatedFetch } from "./authClient";

type Token = { id: string; name: string; createdAt: number; expiresAt: number; revokedAt: number | null };
export function AccessTokens({ csrfToken }: { csrfToken: string }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    const response = await authenticatedFetch("/api/auth/access-tokens");
    if (!response.ok) throw new Error("Could not load access tokens.");
    const body = await response.json() as { tokens: Token[] };
    setTokens(body.tokens);
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  async function create() {
    setBusy(true); setError(""); setSecret("");
    try {
      const response = await authenticatedFetch("/api/auth/access-tokens", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, validityDays: days }),
      }, csrfToken);
      if (!response.ok) throw new Error("Could not create token. Enter a name and validity of 1–30 days.");
      const body = await response.json() as { token: string };
      setSecret(body.token); setName(""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create token."); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError(""); setSecret("");
    try {
      const response = await authenticatedFetch(`/api/auth/access-tokens/${id}`, { method: "DELETE" }, csrfToken);
      if (!response.ok) throw new Error("Could not revoke token.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not revoke token."); }
    finally { setBusy(false); }
  }
  return <section className="access-tokens" aria-label="Access tokens">
    <h3>Access tokens</h3>
    <p>Tokens grant all administrator API permissions. They expire within 30 days and can be revoked here. Managing tokens requires a login session.</p>
    <form onSubmit={e => { e.preventDefault(); void create(); }}>
      <label>Name<input value={name} onChange={e => setName(e.target.value)} required maxLength={100} disabled={busy} placeholder="Monitoring server" /></label>
      <label>Valid for (days)<input type="number" min={1} max={30} step={1} value={days} onChange={e => setDays(Number(e.target.value))} required disabled={busy} /></label>
      <button type="submit" disabled={busy}>Create token</button>
    </form>
    {secret && <div role="status"><p>Copy this token now. It will only be shown once. Use it as an Authorization: Bearer credential.</p>
      <input aria-label="New access token" readOnly value={secret} onFocus={e => e.target.select()} autoComplete="off" />
      <button type="button" className="secondary" onClick={() => setSecret("")}>Dismiss token</button></div>}
    {error && <p role="alert">{error}</p>}
    <ul>{tokens.map(t => <li key={t.id}><strong>{t.name}</strong> — {t.revokedAt !== null ? "Revoked" : t.expiresAt <= Date.now() ? "Expired" : `Expires ${new Date(t.expiresAt).toLocaleString()}`}
      {t.revokedAt === null && t.expiresAt > Date.now() && <button type="button" className="secondary" disabled={busy} onClick={() => void revoke(t.id)}>Revoke</button>}</li>)}</ul>
  </section>;
}
