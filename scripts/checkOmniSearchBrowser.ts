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
const calls: string[] = [];
const pageErrors: string[] = [];
let retryCalls = 0;
function response(query: string): SearchResponse {
  const item = { kind: "block" as const, label: `Block ${query}`, detail: "Block number", href: `/block?block=${query}`, scope: "indexed" as const };
  return { query, results: [item], suggestions: [{ label: item.label, query, detail: item.detail, href: item.href }],
    truncated: false, partial: false, notes: [],
    coverage: { attributeIndex: false, attributeHead: null, recentOperations: 0, recentTransactions: 0, recentLogs: 0 } };
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
      if (url.pathname === "/api/search" && q === "333333" && retryCalls++ === 0) {
        await route.fulfill({ status: 503, json: { error: "Please retry this search" } });
        return;
      }
      if (q === "111111") await pause(750);
      await route.fulfill({ json: response(q) }).catch(() => {});
      return;
    }
    await route.fulfill({ status: 503, json: { error: "Not used by this browser fixture" } });
  });
  await page.goto(`http://127.0.0.1:${port}/search`);
  const input = page.getByRole("combobox", { name: "Search the indexer" });
  for (const query of ["name", "name=Alice", "Alice Smith", "$payload=hello", "0xabc"]) {
    await input.fill(query);
    await pause(300);
  }
  expect(calls).toEqual([]);
  expect(await input.getAttribute("placeholder")).not.toContain("key=value");
  await input.fill("12");
  await pause(60);
  await input.fill("123");
  await expect(page.getByRole("option", { name: "Block 123 Block number", exact: true })).toBeVisible();
  expect(calls).toEqual(["123"]);
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/block\?block=123$/);
  await page.goto(`http://127.0.0.1:${port}/search?q=123`);
  await expect(page.locator(".search-results")).toContainText("Block 123");
  await page.reload();
  await expect(page.locator(".search-results")).toContainText("Block 123");
  await input.fill("111111");
  await input.focus();
  await pause(300);
  await input.fill("222222");
  await expect(page.getByRole("option")).toContainText("Block 222222");
  await pause(550);
  await expect(page.getByRole("option")).not.toContainText("Block 111111");
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveValue("222222");
  await input.fill("333333");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Please retry");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".search-results")).toContainText("Block 333333");
  expect(retryCalls).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  const widths = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(widths.actual).toBeLessThanOrEqual(widths.viewport);
  await page.screenshot({ path: "/tmp/arkiv-omni-search-mobile.png", fullPage: true });
  expect(pageErrors).toEqual([]);
  console.log("Browser checks passed: indexed inputs only, short block suggestions, debounce, identifier navigation, Escape, permalinks, stale responses, retry, and mobile layout.");
} finally {
  await browser.close();
  server.kill();
  await server.exited;
}
