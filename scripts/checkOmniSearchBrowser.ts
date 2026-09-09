import { chromium, expect } from "@playwright/test";
import type { SearchResponse } from "../src/omniSearchTypes";

// Production frontend with intercepted API calls; no chain or database access.
const root = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const port = probe.port!;
await probe.stop(true);
const server = Bun.spawn(["node", "frontend/server.js"], {
  cwd: root, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdout: "ignore", stderr: "inherit",
});
const browser = await chromium.launch({ headless: true });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const key = `0x${"ab".repeat(32)}`;
const calls: string[] = [];
const pageErrors: string[] = [];
let retryCalls = 0;
function response(query: string): SearchResponse {
  return { query, results: [{ kind: "attribute", label: "name=Alice Smith", detail: "str attribute", href: `/entity/${key}`, scope: "indexed" }],
    suggestions: query === "name" ? [{ label: "name=", query: "name=", detail: "Attribute key", href: null }] :
      [{ label: query === "older" ? "Older result" : query === "newer" ? "Newer result" : "name=Alice Smith",
        query: 'name="Alice Smith"', detail: "Attribute value", href: null }],
    truncated: false, partial: false, notes: ["Recent text suggestions cover a bounded metadata window."],
    coverage: { attributeIndex: true, attributeHead: "12000", recentOperations: 64, recentTransactions: 64, recentLogs: 64 } };
}
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/search`)).ok) break; } catch { /* process starting */ }
    await pause(50);
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health") return route.fulfill({ json: { features: { transactionData: true } } });
    if (url.pathname.startsWith("/api/search")) {
      const q = url.searchParams.get("q") ?? "";
      if (url.pathname.endsWith("/suggest")) calls.push(q);
      if (url.pathname === "/api/search" && q === "retry" && retryCalls++ === 0) {
        await route.fulfill({ status: 503, json: { error: "Please retry this search" } });
        return;
      }
      if (q === "older") await pause(750);
      await route.fulfill({ json: response(q) }).catch(() => {});
      return;
    }
    await route.fulfill({ status: 503, json: { error: "Not used by this browser fixture" } });
  });
  await page.goto(`http://127.0.0.1:${port}/search`);
  const input = page.getByRole("combobox", { name: "Search the indexer" });
  await input.fill("n");
  await pause(300);
  expect(calls).toEqual([]);
  await input.fill("nam");
  await pause(60);
  await input.fill("name");
  await expect(page.getByRole("option", { name: "name= Attribute key", exact: true })).toBeVisible();
  expect(calls).toEqual(["name"]);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("name=");
  await expect(page.getByRole("option")).toContainText("Alice Smith");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveValue("name=");
  await input.fill("name=Ali");
  await expect(page.getByRole("option")).toContainText("Alice Smith");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.locator(".search-results")).toContainText("name=Alice Smith");
  expect(new URL(page.url()).searchParams.get("q")).toBe('name="Alice Smith"');
  await page.reload();
  await expect(page.locator(".search-results")).toContainText("name=Alice Smith");
  await input.fill("older");
  await input.focus();
  await pause(300);
  await input.fill("newer");
  await expect(page.getByRole("option")).toContainText("Newer result");
  await pause(550);
  await expect(page.getByRole("option")).not.toContainText("Older result");
  await input.press("Escape");
  await input.fill("retry");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Please retry");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".search-results")).toContainText("name=Alice Smith");
  expect(retryCalls).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(widths.actual).toBeLessThanOrEqual(widths.viewport);
  await page.screenshot({ path: "/tmp/arkiv-omni-search-mobile.png", fullPage: true });
  expect(pageErrors).toEqual([]);
  console.log("Browser checks passed: debounce, keyboard selection, Escape, permalinks, stale responses, retry, and mobile layout.");
} finally {
  await browser.close();
  server.kill();
  await server.exited;
}
