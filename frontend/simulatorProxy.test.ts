import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("local verifier proxy strips credentials, bounds streams and cannot reach controls/bodies", async () => {
  const received: Array<{ path: string; headers: Headers }> = [];
  const light = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
      });
      if (request.method === "POST") {
        const value = (await request.json()) as { oversize?: boolean };
        if (value.oversize)
          return new Response("x".repeat(8 * 1024 * 1024 + 1));
      }
      return Response.json({ role: "light" });
    },
  });
  const allocation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = allocation.port!;
  allocation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["node", resolve(import.meta.dir, "server.js")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCAL_SIMULATOR_LIGHT_HOST: "127.0.0.1",
      LOCAL_SIMULATOR_LIGHT_PORT: String(light.port),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try {
        const r = await fetch(origin + "/local-sim/v1/status");
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await Bun.sleep(20);
    }
    expect(ready).toBe(true);
    received.length = 0;
    const r = await fetch(origin + "/local-sim/v1/query/verified", {
      method: "POST",
      headers: {
        origin,
        cookie: "secret=session",
        authorization: "Bearer secret",
        "x-csrf-token": "secret",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/sim/v1/query/verified");
    for (const name of ["authorization", "cookie", "x-csrf-token", "origin"])
      expect(received[0]!.headers.has(name)).toBe(false);
    expect(
      (
        await fetch(origin + "/local-sim/v1/query/verified", {
          method: "POST",
          headers: { origin: "https://evil.invalid" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    for (const path of [
      "/control",
      "/replication/blocks/1",
      "/status?target=http://evil.invalid",
    ])
      expect((await fetch(origin + "/local-sim/v1" + path)).status).toBe(404);
    expect(received).toHaveLength(1);
    expect(
      (
        await fetch(origin + "/local-sim/v1/query/verified", {
          method: "POST",
          body: "x".repeat(65537),
        })
      ).status,
    ).toBe(413);
    expect(received).toHaveLength(1);
    const tooLarge = await fetch(origin + "/local-sim/v1/query/verified", {
      method: "POST",
      body: JSON.stringify({ oversize: true }),
    });
    expect(tooLarge.status).toBe(502);
    expect(await tooLarge.json()).toEqual({
      error: "VerifierResponseTooLarge",
    });
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await light.stop(true);
  }
}, 15000);
