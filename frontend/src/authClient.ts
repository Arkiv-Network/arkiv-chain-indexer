export type UserRole = "anonymous" | "user" | "admin";

export interface AuthSession {
  role: UserRole;
  user: { id: string; email: string; name: string; picture?: string | null } | null;
  csrfToken: string | null;
  expiresAt: string | null;
  loginAvailable: boolean;
  tokenLoginAvailable?: boolean;
}

export const ANONYMOUS_SESSION: AuthSession = {
  role: "anonymous", user: null, csrfToken: null, expiresAt: null, loginAvailable: false,
};
export const AUTH_INVALIDATED_EVENT = "arkiv:auth-invalidated";

export function notifyAuthFailure(status: number): void {
  if ((status === 401 || status === 403) && typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
  }
}

/** Only fixed application endpoints may receive ambient sessions or CSRF tokens. */
export async function authenticatedFetch(
  path: string,
  init: RequestInit = {},
  csrfToken?: string,
): Promise<Response> {
  const origin = "https://application.invalid";
  const url = new URL(path, origin);
  if (!path.startsWith("/api/") || path.includes("\\") || url.origin !== origin || !url.pathname.startsWith("/api/")) {
    throw new Error("Authenticated requests must use an application API path");
  }
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!csrfToken) throw new Error("Your session is unavailable. Sign in again before making changes.");
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  notifyAuthFailure(response.status);
  return response;
}

export async function fetchAuthSession(): Promise<AuthSession> {
  // A failed session probe must not trigger another probe through the auth event.
  const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("Sign-in is temporarily unavailable. Please retry.");
  return response.json() as Promise<AuthSession>;
}

export async function logoutSession(csrfToken: string): Promise<void> {
  const response = await authenticatedFetch("/api/auth/logout", { method: "POST" }, csrfToken);
  if (!response.ok) throw new Error("Could not sign out. Please retry.");
}

export async function tokenLogin(email: string, token: string): Promise<void> {
  const response = await fetch("/api/auth/token-login", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, token }),
  });
  if (!response.ok) {
    const message = response.status === 401 ? "Invalid admin token." : response.status === 429
      ? "Too many login attempts. Please retry later." : response.status === 404
      ? "Token login is disabled on this deployment." : "Could not sign in. Check your email and retry.";
    throw new Error(message);
  }
}

export function googleLoginUrl(returnTo: string): string {
  return `/api/auth/google/start?${new URLSearchParams({ returnTo })}`;
}
