// Opt-in: build frontend, then RUN_STATISTICS_BROWSER_TESTS=1 bun --no-env-file test frontend/statistics.browser.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { STATISTICS_PERIODS } from "../src/indexerStatisticsTypes";
import { statisticsFixture } from "./testStatistics";

const suite = process.env.RUN_STATISTICS_BROWSER_TESTS === "1" ? describe : describe.skip;
suite("statistics activity period UI", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let snapshot = statisticsFixture();
  let statisticsRequests = 0;
  const errors: string[] = [];

  beforeAll(async () => {
    if (!await Bun.file(`${import.meta.dir}/dist/index.html`).exists()) throw new Error("Build frontend before browser tests");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/statistics") { statisticsRequests++; return Response.json(snapshot); }
      if (path === "/api/auth/session") return Response.json({ role: "anonymous", user: null, csrfToken: null, expiresAt: null, loginAvailable: false });
      if (path === "/api/health") return Response.json({ features: {} });
      if (path.startsWith("/api/")) return new Response(null, { status: 503 });
      const file = Bun.file(`${import.meta.dir}/dist${path}`);
      return new Response(await file.exists() ? file : Bun.file(`${import.meta.dir}/dist/index.html`));
    } });
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => { await browser?.close(); server?.stop(true); });

  for (const width of [1440, 390]) test(`all nine periods select without fetching, preserve current gauges, and fit ${width}px`, async () => {
    snapshot = statisticsFixture(); statisticsRequests = 0; errors.length = 0;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(3000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/statistics`);
      const period = page.getByLabel("Activity period", { exact: true });
      const activity = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Indexed activity/ }) });
      const entities = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Entity state/ }) });
      const payload = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Current active payload state/ }) });
      const inputs = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Transaction input and payloads/ }) });
      const operations = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Entity operations/ }) });
      await activity.waitFor();
      expect(await period.inputValue()).toBe("all");
      const originalEntities = await entities.innerText();
      await page.getByLabel("Byte units", { exact: true }).selectOption("bytes");
      const originalPayload = await payload.innerText();
      const requests = statisticsRequests;
      for (const { id } of STATISTICS_PERIODS) {
        await period.selectOption(id);
        expect(await period.inputValue()).toBe(id);
        expect(await activity.locator("dd").first().innerText()).toBe(snapshot.windows![id].blocks.indexed);
        expect(await operations.locator("tbody td").first().innerText()).toBe(snapshot.windows![id].operations.byType[0]!.successful);
        expect(await inputs.locator("dd").first().innerText()).toBe(`${BigInt(snapshot.windows![id].blocks.inputBytes).toLocaleString("en-US")} B`);
        expect(await entities.innerText()).toBe(originalEntities);
        expect(await payload.innerText()).toBe(originalPayload);
      }
      expect(statisticsRequests).toBe(requests);
      await period.selectOption("2h");
      await page.reload();
      await activity.waitFor();
      expect(await period.inputValue()).toBe("2h");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  test("legacy snapshot falls back from a saved period to All time and disables unavailable options", async () => {
    snapshot = statisticsFixture(); delete snapshot.windows;
    const context = await browser.newContext();
    try {
      await context.addInitScript(() => localStorage.setItem("gas-price-tracker:statistics.period", "1h"));
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/statistics`);
      await page.getByText("Time-window activity is unavailable in this snapshot.", { exact: false }).waitFor();
      expect(await page.getByLabel("Activity period", { exact: true }).inputValue()).toBe("all");
      expect(await page.locator("#statistics-period option:disabled").count()).toBe(8);
      expect(await page.locator("section").filter({ has: page.getByRole("heading", { name: /^Indexed activity/ }) }).innerText()).toContain("99");
    } finally { await context.close(); }
  });
});
