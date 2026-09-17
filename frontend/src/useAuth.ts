import { useCallback, useEffect, useRef, useState } from "react";
import {
  ANONYMOUS_SESSION, AUTH_INVALIDATED_EVENT, fetchAuthSession, logoutSession, tokenLogin,
  type AuthSession,
} from "./authClient";

export function useAuth() {
  const [session, setSession] = useState<AuthSession>(ANONYMOUS_SESSION);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await fetchAuthSession();
      if (request !== generation.current) return;
      setSession(next);
      setError(null);
    } catch (cause) {
      if (request !== generation.current) return;
      setSession(ANONYMOUS_SESSION);
      setError(cause instanceof Error ? cause.message : "Sign-in is temporarily unavailable.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);

  const invalidate = useCallback(() => {
    ++generation.current;
    setSession(ANONYMOUS_SESSION);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Remove the obsolete credential even when authentication is unavailable.
    try { window.localStorage.removeItem("baseload.adminBearerToken"); } catch { /* Storage may be disabled. */ }
    const url = new URL(window.location.href);
    const failure = url.searchParams.get("authError");
    if (failure) {
      url.searchParams.delete("authError");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    void refresh().then(() => {
      if (failure) setError(failure === "cancelled" ? "Google sign-in was cancelled." : "Google sign-in failed. Please retry.");
    });
    const onFocus = () => void refresh();
    const onStorage = (event: StorageEvent) => { if (event.key === "auth.logout") invalidate(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    window.addEventListener(AUTH_INVALIDATED_EVENT, invalidate);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("arkiv-auth");
      channel.current.onmessage = () => invalidate();
    }
    return () => {
      ++generation.current;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AUTH_INVALIDATED_EVENT, invalidate);
      channel.current?.close();
      channel.current = null;
    };
  }, [refresh, invalidate]);

  useEffect(() => {
    if (!session.expiresAt) return;
    const delay = Date.parse(session.expiresAt) - Date.now();
    const timer = window.setTimeout(invalidate, Math.max(0, Math.min(delay, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [session.expiresAt, invalidate]);

  const logout = useCallback(async () => {
    if (!session.csrfToken || busy) return;
    setBusy(true);
    setError(null);
    // Invalidate pending probes before and after logout to prevent stale roles.
    ++generation.current;
    try {
      await logoutSession(session.csrfToken);
      ++generation.current;
      setSession({ ...ANONYMOUS_SESSION, loginAvailable: session.loginAvailable, tokenLoginAvailable: !!session.tokenLoginAvailable });
      channel.current?.postMessage("logout");
      try { window.localStorage.setItem("auth.logout", String(Date.now())); } catch { /* Optional tab notification. */ }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out. Please retry.");
    } finally {
      setBusy(false);
    }
  }, [session, busy]);

  const loginWithToken = useCallback(async (email: string, token: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    ++generation.current;
    try {
      await tokenLogin(email, token);
      const request = ++generation.current;
      const next = await fetchAuthSession();
      if (request === generation.current) setSession(next);
      channel.current?.postMessage("login");
      try { window.localStorage.setItem("auth.logout", String(Date.now())); } catch { /* Optional tab notification. */ }
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in. Please retry.");
      return false;
    } finally { setBusy(false); }
  }, [busy]);

  return { session, loading, busy, error, refresh, logout, loginWithToken };
}
