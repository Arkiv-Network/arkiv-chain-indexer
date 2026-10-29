import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { WebsiteRpcTokens, WEBSITE_RPC_TTL_MS } from "./websiteRpcTokens";
import { handleRequest } from "./server";
import { testAuth, testAdminHeaders } from "./testAuth";
import type { ScannerStorage } from "./storage";

const secret = "a".repeat(64);
const request = (headers: Record<string, string> = {}, path = "/entity-explorer/rpc") =>
  new Request(`https://explorer.test${path}`, { method: "POST", headers });
async function issue(service: WebsiteRpcTokens, cookie?: string) {
  const response = service.issue(request(cookie ? { cookie } : {}));
  const access = await response.json();
  return { access, response, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? cookie! };
}

describe("website RPC credentials", () => {
  test("expires at exactly 120 seconds, requires the matching cookie, and keeps refresh bindings stable", async () => {
    let now = 1_000_000;
    const service = new WebsiteRpcTokens({ secret, now: () => now });
    const a = await issue(service);
    expect(a.access.expiresAt).toBe(now + WEBSITE_RPC_TTL_MS);
    expect(a.response.headers.get("cache-control")).toBe("no-store");
    expect(a.response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    expect(a.response.headers.get("set-cookie")).toContain("; Secure");
    const headers = { cookie: a.cookie, authorization: `Bearer ${a.access.token}` };
    expect(service.accepts(request(headers))).toBe(true);
    expect(service.accepts(request({ authorization: headers.authorization }))).toBe(false);
    const b = await issue(service);
    expect(service.accepts(request({ ...headers, cookie: b.cookie }))).toBe(false);
    now += 60_000;
    const refreshed = await issue(service, a.cookie);
    expect(refreshed.response.headers.get("set-cookie")).toBeNull();
    expect(refreshed.access.expiresAt).toBe(now + 120_000);
    now += 59_999;
    expect(service.accepts(request(headers))).toBe(true);
    now++;
    expect(service.accepts(request(headers))).toBe(false);
    expect(service.accepts(request({ ...headers, authorization: `Bearer ${refreshed.access.token}` }))).toBe(true);
  });

  test("rejects tampering, wrong-purpose and overlong signed credentials; replicas share the key", async () => {
    const service = new WebsiteRpcTokens({ secret });
    const { access, cookie } = await issue(service);
    const good = { cookie, authorization: `Bearer ${access.token}` };
    expect(new WebsiteRpcTokens({ secret }).accepts(request(good))).toBe(true);
    expect(new WebsiteRpcTokens({ secret, now: () => Date.now() - 1000 }).accepts(request(good))).toBe(true);
    expect(new WebsiteRpcTokens({ secret: "b".repeat(64) }).accepts(request(good))).toBe(false);
    expect(service.accepts(request({ ...good, authorization: `${good.authorization}x` }))).toBe(false);
    expect(service.accepts(request({ ...good, authorization: `Bearer ${cookie.split("=")[1]}` }))).toBe(false);
    const claims = JSON.parse(Buffer.from(access.token.split(".")[1], "base64url").toString());
    for (const change of [{ exp: claims.iat + 120_001 }, { iat: Date.now() + 100_000 }, { exp: "tomorrow" }, { kind: "session" }]) {
      const body = Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url");
      const token = `wrpc.${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
      expect(service.accepts(request({ cookie, authorization: `Bearer ${token}` }))).toBe(false);
    }
    expect(() => new WebsiteRpcTokens({ secret: "short" })).toThrow();
  });

  test("insecure cookies are restricted to explicitly enabled localhost", async () => {
    const service = new WebsiteRpcTokens({ insecureLocalhost: true, publicOrigin: "http://localhost:5173" });
    const local = service.issue(new Request("http://internal-backend/website-rpc/token", { method: "POST", headers: { origin: "http://localhost:5173" } }));
    expect(local.headers.get("set-cookie")).toStartWith("arkiv_rpc_local=");
    expect(local.headers.get("set-cookie")).not.toContain("; Secure");
    expect(service.issue(request()).headers.get("set-cookie")).toStartWith("__Host-arkiv_rpc=");
    expect(service.issue(new Request("http://localhost/website-rpc/token", { method: "POST", headers: { origin: "https://public.test" } })).headers.get("set-cookie")).toStartWith("__Host-arkiv_rpc=");
    expect(() => new WebsiteRpcTokens({ insecureLocalhost: true })).toThrow();
  });
});

test("both RPC routes are gated before dispatch, with isolated admin access and no-store responses", async () => {
  let forwards = 0;
  const websiteRpcTokens = new WebsiteRpcTokens({ secret });
  const storage = { getChainId: async () => 1337n } as unknown as ScannerStorage;
  const options = { websiteRpcTokens, auth: testAuth(), entityIndex: {} as never,
    entityExplorerRpc: { methods: new Set(["eth_chainId"]), forward: async () => { forwards++; return "0x539"; } } };
  const mint = await handleRequest(request({}, "/website-rpc/token"), storage, options);
  expect(mint.headers.get("cache-control")).toContain("no-store");
  expect(mint.headers.has("access-control-allow-origin")).toBe(false);
  const { token } = await mint.json();
  const cookie = mint.headers.get("set-cookie")!.split(";")[0]!;
  const post = (path: string, headers = {}) => handleRequest(new Request(`https://explorer.test${path}`, {
    method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  }), storage, options);
  for (const path of ["/entity-explorer/rpc", "/shadow-rpc/experimental"]) {
    expect((await post(path)).status).toBe(401);
    expect((await post(path, { authorization: `Bearer ${token}` })).status).toBe(401);
    const response = await post(path, { cookie: `${cookie}; __Host-arkiv_session=unrelated-admin-cookie`, authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect((await post(path, testAdminHeaders)).status).toBe(200);
  }
  expect(forwards).toBe(2);
  expect((await post("/shadow-rpc", { cookie, authorization: `Bearer ${token}` })).status).toBe(401);
});
