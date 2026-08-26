// Cache-header contract of the static frontend server (server.js): hashed
// assets are immutable, index.html always revalidates, and every file serves
// ETag/Last-Modified validators so a browser refresh gets an empty 304
// instead of re-downloading the bundle.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 24100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  const staticDir = mkdtempSync(path.join(tmpdir(), "arkiv-static-"));
  mkdirSync(path.join(staticDir, "assets"));
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(path.join(staticDir, "assets", "index-abc123.js"), "console.log('bundle');");
  writeFileSync(path.join(staticDir, "llms.txt"), "docs");

  server = Bun.spawn(["node", path.join(import.meta.dir, "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      STATIC_DIR: staticDir,
      NODE_ENV: "test",
    },
    stdout: "ignore",
    stderr: "inherit",
  });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await fetch(`${base}/index.html`);
      return;
    } catch {
      if (attempt >= 50) {
        throw new Error("static server did not start");
      }
      await Bun.sleep(100);
    }
  }
});

afterAll(() => {
  server?.kill();
});

describe("static server caching", () => {
  test("index.html is no-cache with validators and answers 304 on If-None-Match", async () => {
    const first = await fetch(`${base}/index.html`);
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(etag).toMatch(/^"[0-9a-f-]+"$/);
    expect(first.headers.get("last-modified")).toBeTruthy();

    const revalidated = await fetch(`${base}/index.html`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("etag")).toBe(etag);
  });

  test("hashed assets are immutable for a year and support If-Modified-Since", async () => {
    const first = await fetch(`${base}/assets/index-abc123.js`);
    const lastModified = first.headers.get("last-modified");

    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(lastModified).toBeTruthy();

    const revalidated = await fetch(`${base}/assets/index-abc123.js`, {
      headers: { "If-Modified-Since": lastModified ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  test("SPA routes serve index.html with its no-cache policy", async () => {
    const response = await fetch(`${base}/block?block=552584`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("<!doctype html>");
  });

  test("other root files get a short public max-age", async () => {
    const response = await fetch(`${base}/llms.txt`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("a stale validator still gets the full 200 body", async () => {
    const response = await fetch(`${base}/assets/index-abc123.js`, {
      headers: { "If-None-Match": '"0-0"' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bundle");
  });
});
