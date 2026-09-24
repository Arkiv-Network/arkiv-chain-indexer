/** End-to-end checks against a deployed full/light panel pair (no controls or resets).
 * bun --no-env-file scripts/checkNodePanels.ts [--full URL] [--light URL] [--out DIR]
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1]!);
const full = args.get("--full") ?? "https://fullnode.experimental.arkiv-global.net";
const light = args.get("--light") ?? "https://lightnode.experimental.arkiv-global.net";
const out = resolve(args.get("--out") ?? "/tmp/arkiv-node-panel-check");
await mkdir(out, { recursive: true });
const report: Record<string, any> = { startedAt: new Date().toISOString(), full, light };
async function get(url: string, body?: unknown): Promise<any> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(url, { ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if ([429, 503].includes(response.status) || data.error === "ServerBusy") { await Bun.sleep(300); continue; }
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  throw new Error("Repeatedly busy: " + url);
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
  for (let i = 0; i < 100; i++) { const value = await read(); if (accepts(value)) return value; await Bun.sleep(300); }
  throw new Error("Timed out: " + label);
}
function observe(page: Page) {
  const errors: string[] = [], routes: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => routes.push(new URL(r.url()).pathname));
  return { errors, routes };
}
let selection = { height: "20", namespace: "1", attribute: "group", valueType: "u64", value: "1", limit: 3, cursor: null };
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
try {
  const fullStatus = await get(full + "/node-sim/v1/status"), lightStatus = await get(light + "/node-sim/v1/status");
  assert.equal(fullStatus.role, "full"); assert.equal(lightStatus.role, "light");
  for (const key of ["sourceId", "runId", "genesisHash", "chainId"]) assert.equal(fullStatus[key], lightStatus[key]);
  assert.ok(BigInt(lightStatus.head.height) >= 20n);
  const v2 = lightStatus.capabilities?.profile === "arkiv-entity-v2";
  if (v2) selection = {...selection, height: "3"};
  const block = await get(full + "/node-sim/v1/feed/blocks/" + selection.height);
  const first = await get(light + "/node-sim/v1/query/inspect", selection);
  assert.equal(first.snapshot.stateRoot, block.header.stateRoot);
  assert.equal(first.inspection.stateComposition.stateRoot, block.header.stateRoot);
  assert.equal(first.rows.length, 3); assert.equal(first.postingCount, 5); assert.ok(first.continuation);
  assert.equal(first.inspection.postingSet.reconstructedRoot, first.inspection.postingSet.authenticatedRoot);
  assert.equal(first.inspection.postingSet.recordIds.length, 5);
  assert.ok(first.inspection.pointPaths.some((p: any) => p.nodes.some((n: any) => n.kind === "branch")));
  await Bun.write(join(out, "membership-inspection.json"), JSON.stringify(first, null, 2));
  await Bun.write(join(out, `trusted-block-${selection.height}.json`), JSON.stringify(block, null, 2));
  const second = await get(light + "/node-sim/v1/query/inspect", { ...selection, cursor: first.continuation });
  assert.equal(second.rows.length, 2); assert.equal(second.continuation, null);
  assert.equal(second.snapshot.stateRoot, first.snapshot.stateRoot);
  assert.equal(new Set([...first.rows, ...second.rows].map((r: any) => r.recordId)).size, 5);
  const absent = await get(light + "/node-sim/v1/query/inspect", { ...selection, value: "999999" });
  assert.equal(absent.rows.length, 0); assert.ok(absent.inspection.pointPaths.some((p: any) => p.terminal.kind === "absence"));
  const before = await get(light + "/node-sim/v1/query/inspect", { ...selection, height: "13" });
  const after = await get(light + "/node-sim/v1/query/inspect", { ...selection, height: "14" });
  assert.equal(before.postingCount, v2 ? 4 : 2); assert.equal(after.postingCount, v2 ? 3 : 1);
  if (v2) {
    const { ARKIV_EXAMPLES } = await import("../frontend/src/nodeDebugApi");
    report.arkivExamples = [];
    for (const sample of ARKIV_EXAMPLES) {
      const result = await get(light + "/node-sim/v1/query/inspect", sample.request);
      assert.equal(result.profile, "arkiv-entity-v2");
      assert.equal(result.inspection.version, 2);
      assert.equal(result.entities.length, result.rows.length);
      const expected = sample.id === "absence" ? 0 : ["owner", "updated"].includes(sample.id) ? 1 : sample.id === "before-expiry" ? 4 : sample.id === "after-expiry" ? 3 : 5;
      assert.equal(result.postingCount, expected, sample.id);
      report.arkivExamples.push({id:sample.id, matches:result.postingCount});
    }
  }
  report.api = { runId: first.runId, snapshot: first.snapshot, firstPage: first.rows.map((r: any) => r.recordId), secondPage: second.rows.map((r: any) => r.recordId), absentRows: 0, beforeExpiry: before.postingCount, afterExpiry: after.postingCount, proofBytes: first.diagnostics.proofBytes, pointPaths: first.inspection.pointPaths.length };
  for (const origin of [full, light]) {
    for (const route of ["/api/health", "/api/admin/sim/v1/control", "/local-sim/v1/status", "/node-sim/v1/control", "/node-sim/v1/replication/blocks/1"])
      assert.equal((await fetch(origin + route)).status, 404, route);
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const observed = observe(page);
  await page.goto(light, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Next page", exact: true }).waitFor();
  await until(() => page.locator(".nd-result-card .nd-records > details").count(), n => n === 3, "default rows");
  await page.screenshot({ path: join(out, "lightnode-desktop-viewport.png") });
  await page.screenshot({ path: join(out, "lightnode.png"), fullPage: true });
  const startHeight = BigInt((await get(light + "/node-sim/v1/status")).head.height);
  await Bun.sleep(2200);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await until(() => page.locator(".nd-result-card .nd-records > details").count(), n => n === 2, "second page rows");
  assert.ok(BigInt((await get(light + "/node-sim/v1/status")).head.height) > startHeight);
  for (const [label, count] of [["02 / Absence", 0], ["03 / Before expiry", v2 ? 3 : 2], ["04 / After expiry", v2 ? 3 : 1]] as const) {
    const responsePromise = page.waitForResponse(r => r.url().endsWith("/node-sim/v1/query/inspect") && r.status() === 200);
    await page.getByRole("button", { name: new RegExp(label) }).click();
    const data = await (await responsePromise).json(); assert.equal(data.rows.length, count);
    await until(() => page.locator(".nd-result-card .nd-records > details").count(), n => n === count, label);
    if (count === 0) { await page.locator(".nd-absence").waitFor(); await page.screenshot({ path: join(out, "absence.png"), fullPage: true }); }
  }
  if (v2) {
    for (const label of ["05 / Ownership", "06 / Creator", "07 / Decimal", "08 / Wide integer", "09 / Content type", "10 / Updated block", "11 / Entity reference", "12 / Signed integer"]) {
      const incoming = page.waitForResponse(r => r.url().endsWith("/node-sim/v1/query/inspect"));
      await page.getByRole("button", {name:new RegExp(label)}).click();
      const response = await incoming; assert.equal(response.status(), 200, label);
      await page.locator(".nd-verified").waitFor();
      assert.equal(await page.getByRole("alert").count(), 0, label);
      await page.locator(".nd-record summary").first().click();
      await page.getByRole("heading", {name:"Verified entity system fields",exact:true}).first().waitFor();
    }
  }
  await page.getByLabel("Snapshot block", { exact: true }).fill("999999999999");
  await page.getByRole("button", { name: "Run & verify query", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator(".nd-result-card.has-result").count(), 0, "failed query must clear old success");
  await page.route("**/node-sim/v1/query/inspect", route => route.fulfill({ status: 200, json: { ...first, runId: "0".repeat(32) } }));
  const mismatchResponse = page.waitForResponse(r => r.url().endsWith("/node-sim/v1/query/inspect"));
  await page.getByRole("button", { name: /01 \/ Membership/ }).click();
  await mismatchResponse;
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator(".nd-result-card.has-result").count(), 0, "mismatched run must never show success");
  await page.unroute("**/node-sim/v1/query/inspect");
  await page.getByRole("button", { name: /01 \/ Membership/ }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).waitFor();
  await page.locator("summary", { hasText: "Canonical proof bytes" }).click();
  assert.ok((await page.locator(".nd-raw[open] pre").first().textContent())?.startsWith("0x"));
  await page.locator("summary", { hasText: "Canonical proof bytes" }).click();
  await page.getByRole("button", { name: "Next proof node", exact: true }).click();
  await page.screenshot({ path: join(out, "proof-node.png"), fullPage: true });
  await page.route("**/node-sim/v1/status", route => route.fulfill({ status: 200, json: { ...lightStatus, health: "chain-conflict", paused: true } }));
  await until(() => page.locator(".nd-result-card.has-result").count(), n => n === 0, "frozen chain clears trusted presentation");
  assert.equal(await page.getByRole("button", { name: "Run & verify query", exact: true }).isDisabled(), true);
  assert.ok((await page.locator("body").innerText()).includes("chain-conflict"));
  await page.unroute("**/node-sim/v1/status");
  await page.reload({ waitUntil: "networkidle" });
  await until(() => page.locator(".nd-result-card .nd-records > details").count(), n => n === 3, "restored trust sample");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(out, "lightnode-mobile-viewport.png") });
  await page.screenshot({ path: join(out, "lightnode-mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile horizontal overflow");
  const fullPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const fullObserved = observe(fullPage);
  await fullPage.goto(full, { waitUntil: "networkidle" });
  await fullPage.getByLabel("Block height", { exact: true }).fill("7");
  await fullPage.getByRole("button", { name: "Inspect block", exact: true }).click();
  await fullPage.getByRole("heading", { name: "Block #7", exact: true }).waitFor();
  await fullPage.screenshot({ path: join(out, "fullnode.png"), fullPage: true });
  await fullPage.setViewportSize({ width: 390, height: 844 });
  await fullPage.screenshot({ path: join(out, "fullnode-mobile.png"), fullPage: true });
  assert.ok(await fullPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "full panel mobile overflow");
  for (const observation of [observed, fullObserved]) {
    assert.deepEqual(observation.errors, []);
    assert.deepEqual(observation.routes.filter(r => r.startsWith("/api") || /shadow-rpc|baseload|eth_/.test(r)), []);
  }
  report.browser = { errors: [], lightRoutes: [...new Set(observed.routes.filter(r => r.startsWith("/node-sim")))], fullRoutes: [...new Set(fullObserved.routes.filter(r => r.startsWith("/node-sim")))], mobileWidth: 390, historicalPaginationWhileHeadAdvanced: true, wrongRunRejected: true, frozenNodeClearsTrust: true, invalidBlockClearsResult: true, bothPanelsMobileOverflow: false };
  report.ok = true;
} finally {
  await browser.close(); report.finishedAt = new Date().toISOString();
  await Bun.write(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.ok ? "PASS" : "FAIL"}: ${out}/report.json`);
}
