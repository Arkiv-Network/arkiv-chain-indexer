import { afterEach, describe, expect, test } from "bun:test";
import { authenticatedFetch, fetchAuthSession, googleLoginUrl, logoutSession } from "./src/authClient";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("application session requests", () => {
  test("uses uncached same-origin cookies and sends CSRF only on writes", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    globalThis.fetch = (async (path: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ path: String(path), init });
      return Response.json({});
    }) as unknown as typeof fetch;
    await authenticatedFetch("/api/baseload/configs");
    await authenticatedFetch("/api/baseload", { method: "PUT" }, "csrf");
    await logoutSession("csrf");
    expect(calls.map(({ init }) => init.credentials)).toEqual(["same-origin", "same-origin", "same-origin"]);
    expect(calls.map(({ init }) => init.cache)).toEqual(["no-store", "no-store", "no-store"]);
    expect(calls.map(({ init }) => new Headers(init.headers).get("X-CSRF-Token"))).toEqual([null, "csrf", "csrf"]);
    expect(calls.every(({ init }) => !new Headers(init.headers).has("authorization"))).toBe(true);
    expect(calls[2]?.path).toBe("/api/auth/logout");
    expect(calls[2]?.init.method).toBe("POST");
  });

  test("refuses writes without a CSRF token before sending a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    await expect(authenticatedFetch("/api/baseload", { method: "PUT" })).rejects.toThrow("session is unavailable");
    expect(calls).toBe(0);
  });

  test("refuses arbitrary destinations and paths escaping the API", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    for (const path of ["https://node.example/api/x", "//node.example/api/x", "/api/../../x", "/api/%2e%2e/x", "/api/\\example/x"]) {
      await expect(authenticatedFetch(path, { method: "POST" }, "csrf")).rejects.toThrow("application API path");
    }
    expect(calls).toBe(0);
  });

  test("loads role from the server and reports unavailable sessions without provider details", async () => {
    globalThis.fetch = (async () => Response.json({ role: "user", user: { id: "user", email: "someone@example.com", name: "Someone" } })) as unknown as typeof fetch;
    expect((await fetchAuthSession()).role).toBe("user");
    globalThis.fetch = (async () => new Response("private provider error", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchAuthSession()).rejects.toThrow("Sign-in is temporarily unavailable");
  });

  test("encodes a return path without introducing authorization parameters", () => {
    const url = new URL(googleLoginUrl("/data?q=a&role=admin#result"), "https://explorer.example");
    expect(url.pathname).toBe("/api/auth/google/start");
    expect([...url.searchParams.keys()]).toEqual(["returnTo"]);
    expect(url.searchParams.get("returnTo")).toBe("/data?q=a&role=admin#result");
  });
});
