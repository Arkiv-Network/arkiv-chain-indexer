export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  adminEmails: ReadonlySet<string>;
  sessionTtlSeconds: number;
  insecureLocalhost: boolean;
  /** Explicit opt-in for deployment-local email impersonation; never a route bearer credential. */
  tokenLoginToken?: string;
}

export function parseAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const origin = env.AUTH_PUBLIC_ORIGIN?.trim();
  const tokenLoginFlag = env.AUTH_TOKEN_LOGIN_ENABLED?.trim() || "false";
  if (tokenLoginFlag !== "true" && tokenLoginFlag !== "false") {
    throw new Error("AUTH_TOKEN_LOGIN_ENABLED must be true or false");
  }
  const tokenLoginToken = tokenLoginFlag === "true" ? env.AUTH_TOKEN_LOGIN_TOKEN?.trim() : undefined;
  if (tokenLoginFlag === "true" && !tokenLoginToken) {
    throw new Error("AUTH_TOKEN_LOGIN_ENABLED requires AUTH_TOKEN_LOGIN_TOKEN");
  }
  if (!clientId && !clientSecret && !tokenLoginToken) return undefined;
  if ((clientId || clientSecret) && (!clientId || !clientSecret)) {
    throw new Error("Google login requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together");
  }
  if (!origin) {
    throw new Error("Authentication requires AUTH_PUBLIC_ORIGIN");
  }
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error("AUTH_PUBLIC_ORIGIN must be an exact HTTPS origin"); }
  const insecureLocalhost = env.AUTH_INSECURE_LOCALHOST === "true";
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(insecureLocalhost && url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("AUTH_PUBLIC_ORIGIN must be an exact HTTPS origin (HTTP localhost requires AUTH_INSECURE_LOCALHOST=true)");
  }
  if (insecureLocalhost && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("AUTH_INSECURE_LOCALHOST may only be used with a localhost origin");
  }
  const sessionTtlSeconds = Number(env.AUTH_SESSION_TTL_SECONDS || 43_200);
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 60 || sessionTtlSeconds > 604_800) {
    throw new Error("AUTH_SESSION_TTL_SECONDS must be an integer between 60 and 604800");
  }
  const adminEmails = new Set((env.AUTH_ADMIN_EMAILS ?? "sieciech.czajka@golem.network")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  return { clientId: clientId ?? "", clientSecret: clientSecret ?? "", publicOrigin: url.origin,
    adminEmails, sessionTtlSeconds, insecureLocalhost, ...(tokenLoginToken ? { tokenLoginToken } : {}) };
}
