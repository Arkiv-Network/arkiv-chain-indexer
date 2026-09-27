/** Read-only acceptance check for the light-node query and explanation pages. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.env.LIGHT_PANEL_URL ?? "https://light-node.rogue-one.eu";
const out = process.env.PANEL_CHECK_OUT ?? "/tmp/arkiv-query-subpages";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const proofRequests: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/node-sim/v1/query/")) proofRequests.push(request.url()); });
  const response = await page.goto(origin + "/range-explained");
  assert.equal(response?.status(), 200);
  await page.getByRole("heading", { level: 1 }).waitFor();
  const text = await page.locator("main").innerText();
  for (const phrase of ["state root", "64", "u64", "i32", "u256", "dec", "index", "snapshot"]) assert.ok(text.toLowerCase().includes(phrase), phrase);
  assert.equal(proofRequests.length, 0, "the educational page must not issue a live proof query on load");
  await page.screenshot({ path: out + "/explanation-desktop.png" });
  const answer = page.locator(".nd-demo-answer strong");
  async function expectAnswer(text: string) { await page.getByText(`Example answer: ${text}.`, { exact: true }).waitFor(); }
  await expectAnswer("10, 15");
  await page.getByLabel("Example upper boundary", { exact: true }).selectOption("inclusive");
  await expectAnswer("10, 15, 20");
  await page.getByLabel("Example lower boundary", { exact: true }).selectOption("exclusive");
  await expectAnswer("15, 20");
  await page.getByLabel("Example upper boundary", { exact: true }).selectOption("unbounded");
  await expectAnswer("15, 20, 21");
  await page.getByLabel("Example lower boundary", { exact: true }).selectOption("unbounded");
  await page.locator(".nd-boundary-output [role=alert]").waitFor();
  assert.equal(await answer.count(), 0);
  await page.getByLabel("Example lower boundary", { exact: true }).selectOption("exclusive");
  await page.getByLabel("Example upper boundary", { exact: true }).selectOption("exclusive");
  await page.getByLabel("Example upper value", { exact: true }).fill("15");
  await expectAnswer("no matches");
  await page.getByLabel("Example lower value", { exact: true }).fill("20");
  await expectAnswer("no matches");
  await page.getByLabel("Example lower value", { exact: true }).fill("wrong");
  await page.locator(".nd-boundary-output [role=alert]").waitFor();
  assert.equal(proofRequests.length, 0, "teaching controls must not claim live verification");
  await page.getByLabel("Example lower value", { exact: true }).fill("10");
  await page.getByLabel("Example lower boundary", { exact: true }).selectOption("inclusive");
  await page.getByLabel("Example upper value", { exact: true }).fill("20");
  await expectAnswer("10, 15");
  await page.locator(".nd-boundary-demo").screenshot({ path: out + "/boundaries.png" });
  await page.getByRole("link", { name: "Open the live price example", exact: true }).click();
  await page.waitForURL("**/queries?range=price#range-query");
  const lab = page.locator("#range-query");
  await lab.waitFor();
  assert.equal(await lab.getByLabel("Range attribute", { exact: true }).inputValue(), "price");
  assert.equal(await lab.getByLabel("Range lower bound", { exact: true }).inputValue(), "10");
  assert.equal(await lab.getByLabel("Range upper boundary", { exact: true }).inputValue(), "exclusive");
  assert.equal(await page.locator(".nd-proof-heading").count(), 0);
  assert.equal(proofRequests.length, 0, "a preselected example should wait for the user's query");
  await page.screenshot({ path: out + "/queries-desktop.png" });
  await page.getByRole("navigation", { name: "Light node pages", exact: true }).getByRole("link", { name: "Range explained", exact: true }).click();
  await page.waitForURL("**/range-explained");
  await page.goBack();
  await page.waitForURL("**/queries?range=price#range-query");
  await page.goForward();
  await page.waitForURL("**/range-explained");
  await page.reload();
  await expectAnswer("10, 15");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: out + "/explanation-mobile.png" });
  await page.getByRole("navigation", { name: "Light node pages", exact: true }).getByRole("link", { name: "Simple queries", exact: true }).click();
  await page.waitForURL("**/queries");
  await page.locator("#range-query").waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: out + "/queries-mobile.png" });
  await page.goto(origin + "/#range-query");
  await page.locator("#range-query").waitFor();
  assert.equal(proofRequests.length, 0);
  await page.route("**/node-sim/v1/status", route => route.fulfill({ status: 503, json: { error: "ServerBusy" } }));
  await page.goto(origin + "/range-explained");
  await expectAnswer("10, 15");
  assert.ok((await page.locator("main").innerText()).includes("state root"));
  await page.unroute("**/node-sim/v1/status");
  async function waitForEquality() {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await page.locator(".nd-verified").first().waitFor({ timeout: 1500 }); return; }
      catch (error) {
        if (attempt === 7) throw error;
        if ((await page.locator("body").innerText()).includes("ServerBusy")) await page.getByRole("button", { name: "Run & verify query", exact: true }).click();
      }
    }
  }
  await page.goto(origin + "/queries");
  await page.locator("#range-query").waitFor();
  await page.locator(".nd-equality-disclosure > summary").click();
  await page.getByRole("button", { name: "Run & verify query", exact: true }).click();
  await waitForEquality();
  assert.equal(await page.locator(".nd-proof-heading").count(), 0, "simple equality must not render the full inspector");
  await page.goto(origin + "/proof-inspector");
  await waitForEquality();
  await page.getByText("Trace the answer to the root.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByText("PAGE 2", { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  assert.deepEqual(errors, []);
  const report = { origin, checks: ["direct explanation route", "complete explanation", "no automatic proof queries", "responsive layout", "inclusive/exclusive/one-sided/reversed bounds", "empty teaching result", "live example links", "navigation/back/forward/reload", "legacy root link", "explanation available without live status", "compact equality", "equality inspector and pagination"], errors };
  await Bun.write(out + "/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error("Failed page", page.url(), (await page.locator("body").innerText()).slice(-4500));
    await page.screenshot({ path: out + "/failed.png", fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
}
