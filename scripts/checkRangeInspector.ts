/** Real range witness tree acceptance. RANGE_INSPECT_FIXTURE=1 uses the captured proof for local pre-deploy checks. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import fixture from "../frontend/fixtures/range-inspection/price.json";
const origin = process.env.LIGHT_PANEL_URL ?? "https://light-node.rogue-one.eu";
const out = process.env.PANEL_CHECK_OUT ?? "/tmp/arkiv-range-inspector";
const fixtureMode = process.env.RANGE_INSPECT_FIXTURE === "1";
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = []; let received: any;
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().endsWith("/query/range/inspect") && response.ok()) void response.json().then(data => received = data); });
  if (fixtureMode) {
    await page.route("**/node-sim/v1/status", route => route.fulfill({ json: { ...fixture.identity, authentication: "signed-proposer-v1", role: "light", health: "following", paused: false, head: fixture.snapshot, proofProfiles: ["eq-page-v2", "range-complete-v1"] } }));
    await page.route("**/node-sim/v1/query/range/inspect", route => route.fulfill({ json: fixture }));
  }
  await page.goto(origin + "/proof-inspector");
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await page.locator(".rw-section").waitFor({ timeout: 3000 }); break; }
    catch (e) { if (attempt === 7) throw e; const retry = page.getByRole("button", { name: "Retry range inspection", exact: true }); if (await retry.isVisible()) await retry.click(); }
  }
  assert.ok(received?.inspection);
  assert.equal(received.inspection.proofProfile, "range-complete-v1");
  assert.deepEqual(received.rows.map((r: any) => r.attributes.find((a: any) => a.name === "price").value), ["10", "15"]);
  assert.equal(await page.locator(".pv-proof").count(), 1);
  assert.equal(await page.locator(".nd-evidence,#range-query,.nd-identity").count(), 0, "redundant lower sections are removed");
  const nodes = received.inspection.interval.nodes;
  const boundary = nodes.find((n: any) => n.leaf?.value === "20");
  assert.ok(boundary && !boundary.leaf.included);
  await page.getByRole("button", { name: `Locate witness W${boundary.proofIndex}`, exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Selected range proof node" });
  await inspector.scrollIntoViewIfNeeded();
  assert.ok((await inspector.innerText()).includes("price · u64(20)"));
  assert.ok((await inspector.innerText()).includes("No · outside exact bounds"));
  await page.screenshot({ path: out + "/boundary-desktop.png" });
  const match = nodes.find((n: any) => n.leaf?.value === "10");
  await page.getByRole("button", { name: `Locate witness W${match.proofIndex}`, exact: true }).click();
  assert.ok((await inspector.innerText()).includes("Yes · 1 IDs"));
  await page.getByRole("button", { name: "Catalog, rows & keys", exact: true }).click();
  await page.locator(".pv-path-workbench,.pv-workbench").first().waitFor({ timeout: 3000 }).catch(async () => { assert.ok(await page.getByRole("combobox", { name: "Inspect path" }).isVisible()); });
  await page.getByRole("button", { name: "Range interval tree", exact: true }).click();
  await page.locator(".rw-layout").scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/tree-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no page-wide mobile overflow");
  await page.locator(".rw-layout").scrollIntoViewIfNeeded();
  await page.screenshot({ path: out + "/tree-mobile.png" });
  if (!fixtureMode) {
    await page.getByRole("button", { name: "10 < price < 15", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ri-answer")?.textContent?.includes("no matching entities"));
    await page.locator(".rw-section").waitFor();
    await page.getByRole("button", { name: "price > 20", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ri-matches")?.textContent?.includes("price = 21"));
    await page.locator(".rw-section").waitFor();
  }
  // A failed next request must clear every old witness and result.
  await page.route("**/node-sim/v1/query/range/inspect", route => route.fulfill({ status: 400, json: { error: "ProofLimitExceeded" } }));
  await page.getByRole("button", { name: "10 ≤ price < 20", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "ProofLimitExceeded" }).waitFor();
  assert.equal(await page.locator(".rw-section,.ri-answer").count(), 0);
  assert.deepEqual(errors, []);
  const report = { origin, fixtureMode, height: received.snapshot.height, checks: ["actual range trace", "included and excluded leaves", "linked witness list", "existing point path inspector", "lower sections removed", "desktop/mobile", "failed query clears old witness", ...(!fixtureMode ? ["verified empty range", "one-sided range"] : [])], errors };
  await Bun.write(out + "/report.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error("Failed page", page.url(), (await page.locator("body").innerText()).slice(-3500));
    await page.screenshot({ path: out + "/failed.png", fullPage: true });
  }
  throw error;
} finally { await browser.close(); }
