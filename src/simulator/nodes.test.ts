import { describe, expect, test } from "bun:test";
import { NodeProbe } from "./nodes";
import { genesis, status } from "./testFixtures";

const g = genesis();
const reply = (role: "producer" | "full" | "light", extra: object = {}) =>
  Response.json({ ...status(g), role, ...extra });

describe("native node topology probe", () => {
  test("reports each configured node separately without inventing values", async () => {
    const urls: string[] = [];
    const probe = new NodeProbe(
      { producer: "http://producer:9400", full: "http://full:9403" },
      g,
      async (r) => {
        urls.push(r.url);
        expect(r.headers.get("cookie")).toBeNull();
        if (r.url.startsWith("http://full")) throw new Error("ECONNREFUSED secret-host");
        return reply("producer", { storage: { fileBytes: "4096" } });
      },
    );
    const nodes = await probe.probe();
    expect(urls.sort()).toEqual(["http://full:9403/sim/v1/status", "http://producer:9400/sim/v1/status"]);
    expect(nodes.producer).toMatchObject({ configured: true, available: true, error: null });
    expect(nodes.producer.status?.storage).toEqual({ fileBytes: "4096" });
    expect(typeof nodes.producer.latencyMs).toBe("number");
    expect(nodes.full).toMatchObject({ configured: true, available: false, error: "Transport", status: null });
    expect(JSON.stringify(nodes)).not.toContain("secret-host");
    expect(nodes.light).toEqual({ role: "light", configured: false, available: false, error: null, latencyMs: null, status: null });
  });
  test("rejects wrong role, changed identity, bad status bodies and HTTP failures with fixed codes", async () => {
    const cases: [string, () => Response][] = [
      ["UnexpectedRole", () => reply("light")],
      ["IdentityMismatch", () => reply("producer", { runId: "ff".repeat(16) })],
      ["UnsupportedVersion", () => reply("producer", { apiVersion: 2 })],
      ["InvalidRequest", () => Response.json({ garbage: true })],
      ["UpstreamUnavailable", () => new Response("down", { status: 503 })],
      ["LimitExceeded", () => new Response("x".repeat(70000), { headers: { "content-type": "application/json" } })],
    ];
    for (const [code, make] of cases) {
      const probe = new NodeProbe({ producer: "http://producer:9400" }, g, async () => make());
      const { producer } = await probe.probe();
      expect(producer).toMatchObject({ configured: true, available: false, error: code, status: null });
    }
    const light = new NodeProbe({ light: "http://light:9402" }, g, async () => reply("light"));
    expect((await light.probe()).light).toMatchObject({ available: true, status: { role: "light" } });
  });
  test("retries a momentary ServerBusy once and otherwise reports it as such", async () => {
    let calls = 0;
    const flaky = new NodeProbe({ producer: "http://producer:9400" }, g, async () =>
      ++calls === 1 ? Response.json({ error: "ServerBusy" }, { status: 429 }) : reply("producer"),
    );
    expect((await flaky.probe()).producer).toMatchObject({ available: true, error: null });
    expect(calls).toBe(2);
    const busy = new NodeProbe({ producer: "http://producer:9400" }, g, async () => Response.json({ error: "ServerBusy" }, { status: 429 }));
    expect((await busy.probe()).producer).toMatchObject({ available: false, error: "ServerBusy", status: null });
  });
  test("shares one probe per TTL and retries after the window", async () => {
    let calls = 0,
      now = 1000;
    const probe = new NodeProbe({ producer: "http://producer:9400" }, g, async () => { calls++; return reply("producer"); }, 1000, 3000, () => now);
    await Promise.all([probe.probe(), probe.probe(), probe.probe()]);
    expect(calls).toBe(1);
    now += 999;
    await probe.probe();
    expect(calls).toBe(1);
    now += 1;
    await probe.probe();
    expect(calls).toBe(2);
  });
});
