/** Read-only browser check: LIGHT_PANEL_URL=http://127.0.0.1:23574 bun --no-env-file scripts/checkRangeNodePanel.ts */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Locator } from "playwright";

const origin = process.env.LIGHT_PANEL_URL ?? "https://light-node.rogue-one.eu";
const out = process.env.PANEL_CHECK_OUT ?? "/tmp/arkiv-range-panel";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const results: Array<{ name: string; height: string; rows: number; terms: number }> = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const lab = page.locator("#range-query");
  await lab.waitFor();

  async function run(button: Locator, name: string, expectLimit = false) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const incoming = page.waitForResponse(response => response.url().endsWith("/node-sim/v1/query/range/verified"));
      await button.click();
      const response = await incoming;
      const body = await response.json();
      const request = response.request().postDataJSON();
      assert.ok(!("limit" in request) && !("cursor" in request));
      if ([429, 503].includes(response.status())) {
        await lab.getByRole("alert").waitFor();
        await page.waitForTimeout(350);
        continue;
      }
      if (expectLimit) {
        assert.ok(!response.ok());
        assert.match(JSON.stringify(body), /ProofLimitExceeded|BudgetExceeded/);
        await lab.getByRole("alert").waitFor();
        assert.equal(await lab.locator(".nd-verified").count(), 0);
        assert.equal(await lab.locator(".nd-record").count(), 0);
        return body;
      }
      assert.equal(response.status(), 200, JSON.stringify(body));
      assert.equal(body.complete, true);
      assert.equal(body.proofProfile, "range-complete-v1");
      assert.equal(body.snapshot.height, request.height);
      assert.equal(body.postingCount, body.rows.length);
      for (const row of body.rows) {
        const value = BigInt(row.attributes.find((a: any) => a.name === request.attribute).value);
        if (request.lower) assert.ok(request.lower.inclusive ? value >= BigInt(request.lower.value) : value > BigInt(request.lower.value));
        if (request.upper) assert.ok(request.upper.inclusive ? value <= BigInt(request.upper.value) : value < BigInt(request.upper.value));
      }
      await lab.getByText("Complete range verified", { exact: true }).waitFor();
      assert.equal(await lab.locator(".nd-record").count(), body.rows.length);
      assert.equal(await lab.getByRole("button", { name: "Next page", exact: true }).count(), 0);
      results.push({ name, height: body.snapshot.height, rows: body.rows.length, terms: body.termCount });
      return body;
    }
    throw new Error("Range endpoint remained busy");
  }

  const recent = lab.getByRole("button", { name: /Recent creations/ });
  const initial = await run(recent, "recent");
  assert.ok(initial.rows.length > 0, "live creation example should demonstrate matching records");
  await lab.locator(".nd-record summary").first().click();
  await lab.getByText("Exact range API request", { exact: true }).click();
  await lab.screenshot({ path: `${out}/desktop.png` });
  const empty = await run(lab.getByRole("button", { name: /Prove an empty range/ }), "empty");
  assert.equal(empty.rows.length, 0);
  await lab.getByText("Verified empty range", { exact: true }).waitFor();
  await run(lab.getByRole("button", { name: /Exclude the endpoints/ }), "exclusive");
  const priceButton = lab.getByRole("button", { name: /10 ≤ price < 20/ });
  const prices = (result: any) => result.rows.map((row: any) => row.attributes.find((a: any) => a.name === "price").value).sort();
  assert.deepEqual(prices(await run(priceButton, "price")), ["10", "15"]);
  assert.match(await lab.locator(".nd-records").innerText(), /price = 10/);
  assert.match(await lab.locator(".nd-records").innerText(), /price = 15/);
  await lab.screenshot({ path: `${out}/price-desktop.png` });
  await run(recent, "recent-before-custom");

  const submit = lab.getByRole("button", { name: "Run & verify range", exact: true });
  await lab.getByLabel("Range lower bound", { exact: true }).fill((BigInt(initial.snapshot.height) + 1000n).toString());
  await lab.getByLabel("Range upper bound", { exact: true }).fill("");
  assert.equal((await run(submit, "one-sided-empty")).rows.length, 0);
  await lab.getByLabel("Range lower bound", { exact: true }).fill("0");
  await lab.getByLabel("Range lower boundary", { exact: true }).selectOption("inclusive");
  await run(submit, "oversized", true);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(prices(await run(priceButton, "mobile-price")), ["10", "15"]);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile page overflows");
  await lab.screenshot({ path: `${out}/mobile.png` });
  assert.deepEqual(errors, []);
  const report = { origin, checks: ["recent creations", "empty range", "exclusive bounds", "price attribute 10 inclusive to 20 exclusive", "visible matching attribute values", "one-sided range", "limit error clears results", "request JSON", "desktop/mobile", "no pagination"], results, errors };
  await Bun.write(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) console.error("Failed page", (await page.locator("#range-query").innerText()).slice(-3500));
  throw error;
} finally {
  await browser.close();
}
