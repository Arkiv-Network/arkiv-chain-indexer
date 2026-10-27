// The static server's optional node passthrough (server.js, NODE_RPC_UPSTREAM):
// JSON-RPC and the status document reach the node same-origin, without the
// browser's cookies or credentials; nothing else is forwarded, answers are
// always JSON, a client that leaves aborts its upstream request, the body and
// the number of requests in flight are capped, and an unreachable node is
// reported without its address.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

interface Seen {
  method: string;
  path: string;
  cookie: string | null;
  authorization: string | null;
  body: string;
}

const seen: Seen[] = [];
const aborted: string[] = [];
const held: Array<() => void> = [];
let node: ReturnType<typeof Bun.serve> | undefined;
const servers: Array<ReturnType<typeof Bun.spawn>> = [];

function rpcMethod(body: string): string {
  try {
    return (JSON.parse(body) as { method?: string }).method ?? "";
  } catch {
    return "";
  }
}

async function spawnServer(env: Record<string, string>): Promise<string> {
  const port = 25100 + Math.floor(Math.random() * 3000);
  const staticDir = mkdtempSync(path.join(tmpdir(), "arkiv-node-proxy-"));
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  const server = Bun.spawn(["node", path.join(import.meta.dir, "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", STATIC_DIR: staticDir, NODE_ENV: "test", ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fetch(`${base}/index.html`);
      return base;
    } catch {
      if (attempt >= 50) throw new Error("static server did not start");
      await Bun.sleep(100);
    }
  }
}

const post = (base: string, method: string, init: RequestInit = {}) =>
  fetch(`${base}/node-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    ...(init.signal ? { signal: init.signal } : {}),
  });

let base = "";
let capped = "";
let unreachable = "";

beforeAll(async () => {
  node = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text() : "";
      seen.push({
        method: request.method,
        path: url.pathname,
        cookie: request.headers.get("cookie"),
        authorization: request.headers.get("authorization"),
        body,
      });
      if (url.pathname === "/signed/v1/status") return Response.json({ capabilities: { gas: { maxRentLifetimeSeconds: "31536000" } } });
      const method = rpcMethod(body);
      if (method === "html") return new Response("<!doctype html><script>alert(1)</script>", { headers: { "content-type": "text/html" } });
      if (method === "slow") {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => {
            aborted.push(method);
            resolve();
          });
          setTimeout(resolve, 10_000);
        });
        return Response.json({ jsonrpc: "2.0", id: 1, result: "late" });
      }
      if (method === "hold") await new Promise<void>((resolve) => held.push(resolve));
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x24bd" });
    },
  });
  const upstream = `http://127.0.0.1:${node.port}`;
  [base, capped, unreachable] = await Promise.all([
    spawnServer({ NODE_RPC_UPSTREAM: upstream }),
    spawnServer({ NODE_RPC_UPSTREAM: upstream, NODE_RPC_MAX_IN_FLIGHT: "2" }),
    // Port 9 (discard) on loopback: nothing listens, so the connection is refused.
    spawnServer({ NODE_RPC_UPSTREAM: "http://127.0.0.1:9" }),
  ]);
});

afterAll(() => {
  for (const release of held) release();
  for (const server of servers) server.kill();
  node?.stop(true);
});

describe("node passthrough", () => {
  test("POST /node-rpc reaches the node's JSON-RPC root without cookies or credentials", async () => {
    seen.length = 0;
    const response = await post(base, "eth_chainId", { headers: { cookie: "session=secret", authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: "0x24bd" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/", cookie: null, authorization: null });
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

  test("answers are JSON with nosniff, whatever the node sends", async () => {
    const response = await post(base, "html");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a body over 1 MiB is refused, declared or streamed, and never reaches the node", async () => {
    seen.length = 0;
    const big = "x".repeat(1024 * 1024 + 1);
    const declared = await fetch(`${base}/node-rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(declared.status).toBe(413);

    // Chunked, so the size is only known while streaming.
    const streamed = await new Promise<number>((resolve, reject) => {
      const request = http.request(`${base}/node-rpc`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      const chunk = "y".repeat(64 * 1024);
      for (let index = 0; index < 20; index++) request.write(chunk);
      request.end();
    });
    expect(streamed).toBe(413);
    expect(seen.filter((call) => call.body.length > 1024 * 1024)).toEqual([]);
  });

  test("a client that disconnects aborts its upstream request", async () => {
    aborted.length = 0;
    const controller = new AbortController();
    const pending = post(base, "slow", { signal: controller.signal }).catch(() => null);
    await Bun.sleep(300);
    controller.abort();
    await pending;
    for (let attempt = 0; attempt < 30 && aborted.length === 0; attempt++) await Bun.sleep(100);
    expect(aborted).toEqual(["slow"]);
    // The slot is free again.
    expect((await post(base, "eth_chainId")).status).toBe(200);
  });

  test("beyond the in-flight cap the passthrough answers 503 instead of queueing", async () => {
    const first = post(capped, "hold");
    const second = post(capped, "hold");
    for (let attempt = 0; attempt < 30 && held.length < 2; attempt++) await Bun.sleep(50);
    const third = await post(capped, "eth_chainId");
    expect(third.status).toBe(503);
    expect(third.headers.get("content-type")).toBe("application/json");
    while (held.length) held.shift()!();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await post(capped, "eth_chainId")).status).toBe(200);
  });

  test("an unreachable node is a 502 with a fixed message, not its address", async () => {
    const response = await post(unreachable, "eth_chainId");
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("The node could not be reached");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("ECONNREFUSED");
  });
});
