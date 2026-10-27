// The static server's optional node passthrough (server.js, NODE_RPC_UPSTREAM):
// JSON-RPC and the status document reach the node same-origin, without the
// browser's cookies or credentials, and nothing else is forwarded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 25100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn> | undefined;
let node: ReturnType<typeof Bun.serve> | undefined;
const seen: Array<{ method: string; path: string; cookie: string | null; authorization: string | null; body: string }> = [];

beforeAll(async () => {
  node = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        cookie: request.headers.get("cookie"),
        authorization: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.text() : "",
      });
      if (url.pathname === "/signed/v1/status") return Response.json({ capabilities: { gas: { maxRentLifetimeSeconds: "31536000" } } });
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x24bd" });
    },
  });
  const staticDir = mkdtempSync(path.join(tmpdir(), "arkiv-node-proxy-"));
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  server = Bun.spawn(["node", path.join(import.meta.dir, "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STATIC_DIR: staticDir, NODE_ENV: "test", NODE_RPC_UPSTREAM: `http://127.0.0.1:${node.port}` },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fetch(`${base}/index.html`);
      return;
    } catch {
      if (attempt >= 50) throw new Error("static server did not start");
      await Bun.sleep(100);
    }
  }
});

afterAll(() => {
  server?.kill();
  node?.stop(true);
});

describe("node passthrough", () => {
  test("POST /node-rpc reaches the node's JSON-RPC root without cookies or credentials", async () => {
    seen.length = 0;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    const response = await fetch(`${base}/node-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session=secret", authorization: "Bearer secret" },
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x24bd" });
    expect(seen).toEqual([{ method: "POST", path: "/", cookie: null, authorization: null, body }]);
  });

  test("GET /node-rpc/signed/v1/status reaches the status document", async () => {
    seen.length = 0;
    const response = await fetch(`${base}/node-rpc/signed/v1/status`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { capabilities: { gas: { maxRentLifetimeSeconds: string } } }).capabilities.gas.maxRentLifetimeSeconds).toBe("31536000");
    expect(seen.map((call) => call.path)).toEqual(["/signed/v1/status"]);
  });

  test("anything else under /node-rpc is refused and never forwarded", async () => {
    seen.length = 0;
    for (const [method, route] of [["GET", "/node-rpc"], ["POST", "/node-rpc/signed/v1/control"], ["GET", "/node-rpc/other"]] as const) {
      const response = await fetch(`${base}${route}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(response.status).toBe(405);
    }
    expect(seen).toEqual([]);
  });
});
