/** Real-browser validation of a hosted native simulator deployment.
 * Walks the checklist in docs/simulator-deployment.md against the public debug
 * and explorer origins: TLS/assets/API routing, continuous production and
 * catch-up, unauthorized control rejection, historical queries around the
 * workload's deletion (block 8), recreation (9) and expiry (14), server-side
 * proof verification and malformed-response rejection, pinned pagination,
 * verifier labels and the absence of Ethereum routes. With --state-dir it also
 * exercises operator pause/step/resume through scripts/simulator.py and, with
 * --restart, a stop/up cycle that must keep the run and its history.
 *
 *   bun --no-env-file scripts/checkSimulatorDeployment.ts \
 *     --debug https://experimental.arkiv-global.net \
 *     --explorer https://explorer.experimental.arkiv-global.net \
 *     [--state-dir DIR] [--restart] [--out DIR]
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]!;
  if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
  const next = process.argv[i + 1];
  if (key === "--restart") options.set(key, "true");
  else if (next && !next.startsWith("--")) options.set(key, next), i++;
  else throw new Error(`${key} needs a value`);
}
const debugOrigin = options.get("--debug"),
  explorerOrigin = options.get("--explorer");
if (!debugOrigin || !explorerOrigin) throw new Error("--debug and --explorer origins are required");
for (const origin of [debugOrigin, explorerOrigin]) assert.equal(new URL(origin).origin, origin, "origins must be exact");
const stateDir = options.get("--state-dir");
const out = resolve(options.get("--out") ?? "simulator-deployment-check");
await mkdir(out, { recursive: true });
const root = resolve(import.meta.dir, "..");
const RECREATED_KEY = "0x372d302d726563726561746564",
  EXPIRING_KEY = "0x372d302d65787069726573";
const report: Record<string, unknown> = { debugOrigin, explorerOrigin, startedAt: new Date().toISOString() };

async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  return { status: response.status, body };
}
/** The public node bounds concurrent reads (ServerBusy); a status sample retries until it answers. */
const producerHead = () => until(() => json(`${debugOrigin}/sim/v1/status`), (r) => r.status === 200 && !!r.body.head, "producer status", 15000).then((r) => Number(r.body.head.height));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 60000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (ready(value)) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(250);
  }
  throw new Error(`${label}: ${String(last)}`);
}
function observe(page: Page) {
  const errors: string[] = [],
    routes: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => routes.push(new URL(r.url()).pathname));
  return { errors, routes, ethereum: () => routes.filter((r) => /shadow-rpc|baseload|batcher|faucet|rpc-keys|eth_/.test(r)) };
}
const card = (page: Page, label: string) => page.locator(".dbg-card", { hasText: label }).first();
async function cardHeight(page: Page, label: string, field = "Height"): Promise<number | null> {
  const text = (await card(page, label).textContent()) ?? "";
  const match = new RegExp(`${field}(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
}
function control(action: "pause" | "step" | "resume") {
  assert(stateDir);
  const child = Bun.spawnSync(["python3", "scripts/simulator.py", "--state-dir", stateDir, "control", action], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(child.stdout).trim();
  if (child.exitCode !== 0) throw new Error(`control ${action} failed: ${new TextDecoder().decode(child.stderr).slice(-400)}`);
  return JSON.parse(text.split("\n").at(-1)!);
}

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
try {
  // API-level facts shared by both origins.
  const health = await json(`${debugOrigin}/api/health`);
  assert.equal(health.body.sourceKind, "arkiv-native-simulator");
  assert.equal(health.body.features.ethereum, false);
  const explorerHealth = await json(`${explorerOrigin}/api/health`);
  assert.equal(explorerHealth.body.features.controls, false);
  const publicNode = await until(() => json(`${debugOrigin}/sim/v1/status`), (r) => r.status === 200 && !!r.body.head, "producer status", 15000);
  assert.equal(publicNode.body.role, "producer");
  assert.equal((await json(`${debugOrigin}/sim/v1/replication/blocks/1`)).status, 400, "public node route must refuse bodies");
  assert.equal((await fetch(`${debugOrigin}/api/metrics`)).status, 404);
  assert.equal((await json(`${debugOrigin}/api/auth/session`)).body.loginAvailable, true);
  assert.equal((await json(`${explorerOrigin}/api/auth/session`)).body.loginAvailable, false);
  const unauthorized = await json(`${debugOrigin}/api/admin/sim/v1/control`, { method: "POST", headers: { "content-type": "application/json", origin: debugOrigin }, body: JSON.stringify({ commandId: "0x" + "00".repeat(32), runId: publicNode.body.runId, expectedRevision: "0", expectedHeight: null, action: "pause", config: null }) });
  assert.equal(unauthorized.status, 401);
  const explorerControl = await fetch(`${explorerOrigin}/api/admin/sim/v1/control`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.ok([401, 503].includes(explorerControl.status));
  report.api = { health: health.body, explorerHealth: explorerHealth.body, identity: { sourceId: publicNode.body.sourceId, runId: publicNode.body.runId, genesisHash: publicNode.body.genesisHash, chainId: publicNode.body.chainId }, unauthorizedControl: unauthorized.status, explorerControl: explorerControl.status };

  // Debug console.
  const debug = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const debugObserved = observe(debug);
  await debug.goto(debugOrigin, { waitUntil: "networkidle" });
  assert.equal(await debug.title(), "Arkiv simulator · debug console");
  await debug.getByRole("heading", { name: "Simulator debug console", exact: true }).waitFor();
  await card(debug, "Light follower").waitFor({ timeout: 30000 });
  const heights = async () => ({ producer: await cardHeight(debug, "Producer"), full: await cardHeight(debug, "Full follower"), light: await cardHeight(debug, "Light follower"), explorer: await cardHeight(debug, "Explorer projection", "Indexed") });
  const before = await until(heights, (h) => h.producer !== null && h.explorer !== null, "topology heights");
  await Bun.sleep(5000);
  const after = await heights();
  assert.ok(after.producer! > before.producer!, "producer must advance while running");
  assert.ok(after.producer! - after.explorer! <= 3, `explorer lag ${after.producer! - after.explorer!}`);
  assert.ok(after.producer! - after.full! <= 3 && after.producer! - after.light! <= 3, "followers must keep up");
  const trust = (await debug.locator(".sim-trust").textContent())!.replace(/\s+/g, " ");
  assert.ok(trust.includes("server-side") || trust.includes("light follower, not this browser"), trust);
  assert.equal(await debug.getByRole("button", { name: "Step", exact: true }).count(), 0, "no controls without a session");
  const controlsNote = (await debug.locator("section", { hasText: "Producer controls" }).first().locator("p.sim-muted").first().textContent())!.trim();
  assert.ok(controlsNote.includes("administrator session"), controlsNote);
  const inspect = async (h: string) => {
    await debug.getByLabel("Block height").fill(h);
    await debug.getByRole("button", { name: "Inspect block", exact: true }).click();
    await debug.waitForFunction((h) => document.querySelector(".sim-metadata dd")?.textContent === h || !!document.querySelector("[role=alert]")?.textContent?.includes(`Block ${h}`), h, { timeout: 15000 });
    return { chips: (await debug.locator(".dbg-chip").allTextContents()).map((c) => c.replace(/\s+/g, " ")), alert: await debug.locator("section", { hasText: "Block inspector" }).first().locator("[role=alert]").allTextContents() };
  };
  const block7 = await inspect("7"), block14 = await inspect("14"), missing = await inspect("99999999");
  assert.ok(block7.chips.some((c) => /^Rolled Back1$/.test(c)) && block7.chips.some((c) => /^Failed1$/.test(c)), JSON.stringify(block7.chips));
  assert.ok(block14.chips.some((c) => /^Expiry deletions1$/.test(c)), JSON.stringify(block14.chips));
  assert.ok(missing.alert.some((a) => a.includes("CoverageUnavailable")), JSON.stringify(missing.alert));
  const lookup = async (height: string, key: string) => {
    await debug.getByLabel("Snapshot height").fill(height);
    await debug.getByLabel("Namespace").fill("1");
    await debug.getByLabel("Record key").fill(key);
    await debug.getByLabel("Incarnation ID").fill("");
    await debug.getByRole("button", { name: "Lookup record", exact: true }).click();
    await debug.locator(".sim-result-heading", { hasText: `Live incarnations at block ${height}` }).waitFor({ timeout: 15000 });
    const live = debug.locator(".sim-result-heading", { hasText: "Live incarnations" }).locator("xpath=following-sibling::div[1]");
    const history = debug.locator(".sim-result-heading", { hasText: "Operation history" }).locator("xpath=following-sibling::div[1]");
    return { liveIds: await live.locator("tbody tr td:first-child").allTextContents(), empty: await live.locator(".sim-empty").count(), history: (await history.locator("tbody tr").allTextContents()).map((r) => r.replace(/\s+/g, " ").trim()) };
  };
  const deleteBefore = await lookup("7", RECREATED_KEY), deleteAt = await lookup("8", RECREATED_KEY), recreated = await lookup("9", RECREATED_KEY);
  assert.deepEqual(deleteBefore.liveIds, ["2"]);
  assert.equal(deleteAt.liveIds.length, 0);
  assert.equal(deleteAt.empty, 1);
  assert.ok(deleteAt.history.some((r) => r.includes("deleteRecord") && r.includes("applied")));
  assert.deepEqual(recreated.liveIds, ["3"]);
  const expiryBefore = await lookup("13", EXPIRING_KEY), expiryAt = await lookup("14", EXPIRING_KEY);
  assert.deepEqual(expiryBefore.liveIds, ["1"]);
  assert.equal(expiryAt.liveIds.length, 0);
  assert.ok(expiryAt.history.some((r) => r.includes("expiry") && r.includes("expireRecord")));
  report.history = { deleteBefore, deleteAt, recreated, expiryBefore, expiryAt };
  await debug.getByLabel("Snapshot height").fill("18");
  await debug.getByLabel("Attribute").fill("group");
  await debug.getByLabel("Native type").selectOption("u64");
  await debug.getByLabel("Value").fill("1");
  await debug.getByLabel("Page size").selectOption("3");
  await debug.getByRole("button", { name: "Read projection", exact: true }).click();
  // Record-lookup results above also carry the projection badge; bind to the Eq result by its block.
  const projectionHeading = debug.locator(".sim-result-heading", { hasText: /^Unverified projection\s*Block 18 ·/ }).first();
  await projectionHeading.waitFor({ timeout: 15000 });
  const projectionIds = await projectionHeading.locator("xpath=following-sibling::div[1]").locator("tbody tr td:first-child").allTextContents();
  assert.deepEqual(projectionIds, ["3", "4", "5"]);
  await debug.route("**/local-sim/v1/query/verified", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.snapshot.height = "17";
    await route.fulfill({ response, json: body });
  }, { times: 1 });
  const verifyButton = debug.getByRole("button", { name: "Verify Eq (server-side)", exact: true });
  await verifyButton.click();
  await debug.getByRole("alert").filter({ hasText: "VerifierBindingMismatch" }).waitFor({ timeout: 20000 });
  assert.equal(await debug.locator(".sim-badge.verified").count(), 0, "malformed proof must release nothing");
  await verifyButton.click();
  await debug.locator(".sim-badge.verified").waitFor({ timeout: 30000 });
  const badge = (await debug.locator(".sim-badge.verified").textContent())!.trim();
  assert.ok(badge.startsWith("Proof verified server-side"), badge);
  const verifiedTable = debug.locator(".sim-badge.verified").locator("xpath=ancestor::div[1]/following-sibling::div[contains(@class,'sim-table-wrap')][1]");
  assert.deepEqual(await verifiedTable.locator("tbody tr td:first-child").allTextContents(), ["3", "4", "5"]);
  const chips = (await debug.locator(".dbg-chip").allTextContents()).map((c) => c.replace(/\s+/g, " "));
  const proofSize = chips.find((c) => c.startsWith("Proof size"));
  assert.ok(proofSize && !proofSize.includes("unavailable") && chips.some((c) => c === "Verifierlight-follower"), JSON.stringify(chips));
  await debug.getByRole("button", { name: "Next verified page", exact: true }).click();
  await until(() => verifiedTable.locator("tbody tr").count(), (n) => n === 2, "second verified page");
  assert.deepEqual(await verifiedTable.locator("tbody tr td:first-child").allTextContents(), ["6", "7"]);
  report.proof = { badge, chips: chips.filter((c) => /Verifier|Proof|Verification|Rows/.test(c)), page1: ["3", "4", "5"], page2: ["6", "7"] };
  const lightClient = (await debug.locator("pre.dbg-command").textContent())!;
  assert.ok(lightClient.includes(`--peer ${debugOrigin}`) && lightClient.includes(publicNode.body.runId));
  await debug.screenshot({ path: join(out, "debug-console.png"), fullPage: true });
  assert.deepEqual(debugObserved.ethereum(), []);
  assert.deepEqual(debugObserved.errors, []);
  report.debug = { heightsBefore: before, heightsAfter: after, trust, controlsNote, block7: block7.chips, block14: block14.chips, missingBlock: missing.alert, routes: [...new Set(debugObserved.routes.filter((r) => r.startsWith("/api/") || r.startsWith("/local-sim/")))] };

  // Explorer.
  const explorer = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const explorerObserved = observe(explorer);
  await explorer.goto(explorerOrigin, { waitUntil: "networkidle" });
  assert.equal(await explorer.title(), "Arkiv simulator explorer");
  await explorer.getByRole("heading", { name: "Chain simulator", exact: true }).waitFor();
  await explorer.locator(".sim-sources").waitFor({ timeout: 30000 });
  const sources = (await explorer.locator(".sim-sources").textContent())!.replace(/\s+/g, " ");
  assert.ok(/Producerblock \d+ · running/.test(sources) && /Full followerblock \d+ · following/.test(sources) && /Explorer projectionblock \d+ · running/.test(sources), sources);
  assert.equal(await explorer.getByText("Browsing anonymously").count(), 1);
  assert.equal(await explorer.getByRole("heading", { name: "Producer controls" }).count(), 0);
  const block8 = (await json(`${explorerOrigin}/api/sim/v1/blocks/8`)).body;
  const search = async (term: string) => {
    await explorer.getByLabel("Search").fill(term);
    await explorer.getByRole("button", { name: "Search", exact: true }).click();
  };
  await search("8");
  await explorer.getByRole("heading", { name: "Block transactions" }).waitFor({ timeout: 15000 });
  const detail = (await explorer.locator(".sim-detail .sim-metadata").first().textContent())!.replace(/\s+/g, " ");
  assert.ok(detail.includes("Height8"), detail);
  await search(block8.transactions[0].digest);
  await until(() => explorer.locator(".sim-table tbody tr").count(), (n) => n === 1, "digest search");
  assert.ok((await explorer.locator(".sim-table tbody tr").first().textContent())!.includes("committed"));
  await search(block8.transactions[0].actor);
  await until(() => explorer.locator(".sim-table tbody tr").count(), (n) => n >= 2, "actor search");
  await search(RECREATED_KEY);
  await until(() => explorer.locator(".sim-table tbody tr").count(), (n) => n === 1, "record key search");
  await explorer.getByLabel("Snapshot height").fill("8");
  await explorer.getByRole("button", { name: "Read projection", exact: true }).click();
  await explorer.locator(".sim-empty").waitFor({ timeout: 15000 });
  await explorer.getByLabel("Snapshot height").fill("9");
  await explorer.getByRole("button", { name: "Read projection", exact: true }).click();
  await until(() => explorer.locator(".sim-table tbody tr td:first-child").allTextContents(), (ids) => ids.join() === "3", "recreated incarnation at 9");
  await explorer.getByRole("button", { name: "Blocks", exact: true }).click();
  await explorer.getByLabel("Snapshot height").fill("latest");
  await explorer.getByLabel("Page size").selectOption("3");
  await explorer.getByRole("button", { name: "Read projection", exact: true }).click();
  const pinnedHeading = explorer.locator(".sim-result-heading", { hasText: "Unverified projection" });
  await pinnedHeading.waitFor({ timeout: 15000 });
  const pinnedText = (await pinnedHeading.textContent())!.replace(/\s+/g, " ");
  const pinned = Number(/Block (\d+)/.exec(pinnedText)![1]);
  const headBefore = await producerHead();
  await Bun.sleep(4000);
  const rowsSeen: string[][] = [];
  for (let i = 0; i < 2; i++) {
    await explorer.getByRole("button", { name: "Next pinned page", exact: true }).click();
    await until(() => explorer.locator(".sim-table tbody tr td:first-child").allTextContents(), (ids) => ids[0] === String(3 * (i + 1)), `pinned page ${i + 2}`);
    rowsSeen.push(await explorer.locator(".sim-table tbody tr td:first-child").allTextContents());
    assert.ok((await pinnedHeading.textContent())!.includes(`Block ${pinned}`), "snapshot must stay pinned");
  }
  const headAfter = await producerHead();
  assert.ok(headAfter > headBefore, "new blocks must have arrived during pagination");
  await explorer.getByRole("button", { name: "Query", exact: true }).click();
  await explorer.getByLabel("Snapshot height").fill("18");
  assert.equal(await explorer.getByRole("button", { name: "Verify Eq locally", exact: true }).count(), 0, "hosted explorer must not claim local verification");
  await explorer.getByRole("button", { name: "Verify Eq (server-side)", exact: true }).click();
  await explorer.locator(".sim-badge.verified").waitFor({ timeout: 30000 });
  const explorerBadge = (await explorer.locator(".sim-badge.verified").textContent())!.trim();
  assert.ok(explorerBadge.startsWith("Proof verified server-side"), explorerBadge);
  assert.equal(await explorer.locator(".sim-table tbody tr").count(), 3);
  await explorer.getByRole("button", { name: "Next verified page", exact: true }).click();
  await until(() => explorer.locator(".sim-table tbody tr").count(), (n) => n === 2, "explorer verified page 2");
  await explorer.screenshot({ path: join(out, "explorer.png"), fullPage: true });
  assert.deepEqual(explorerObserved.ethereum(), []);
  assert.deepEqual(explorerObserved.errors, []);
  report.explorer = { sources, pinnedSnapshot: pinned, headBefore, headAfter, pinnedPages: rowsSeen, badge: explorerBadge, routes: [...new Set(explorerObserved.routes.filter((r) => r.startsWith("/api/") || r.startsWith("/local-sim/")))] };

  // Operator controls through the private listener, observed in the debug console.
  if (stateDir) {
    const paused = control("pause");
    assert.equal(paused.paused, true);
    await until(() => card(debug, "Producer").textContent(), (t) => !!t && t.includes("paused"), "paused state visible");
    const pausedHeight = await cardHeight(debug, "Producer");
    await Bun.sleep(3000);
    assert.equal(await cardHeight(debug, "Producer"), pausedHeight, "no production while paused");
    const stepped = control("step");
    assert.equal(stepped.status, "committed");
    assert.equal(Number(stepped.head.height), pausedHeight! + 1);
    await until(() => cardHeight(debug, "Producer"), (h) => h === pausedHeight! + 1, "step visible");
    await until(() => cardHeight(debug, "Explorer projection", "Indexed"), (h) => h === pausedHeight! + 1, "explorer indexed the stepped block");
    const resumed = control("resume");
    assert.equal(resumed.paused, false);
    await until(() => cardHeight(debug, "Producer"), (h) => h !== null && h > pausedHeight! + 1, "production resumed");
    report.controls = { pausedHeight, stepped: stepped.head.height, resumed: resumed.health };
  }

  // Restart: the same run, identity and hashes must survive a stop/up cycle.
  if (options.get("--restart") === "true") {
    assert(stateDir, "--restart needs --state-dir");
    const sample = Number((await json(`${debugOrigin}/api/sim/v1/status`)).body.indexed.height);
    const hashBefore = (await json(`${debugOrigin}/api/sim/v1/blocks/${sample}`)).body.header.hash;
    const identityBefore = (await until(() => json(`${debugOrigin}/sim/v1/status`), (r) => r.status === 200 && !!r.body.head, "producer status", 15000)).body;
    for (const command of ["stop", "up"]) {
      const child = Bun.spawnSync(["python3", "scripts/simulator.py", "--state-dir", stateDir, command], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(`${command} failed: ${new TextDecoder().decode(child.stderr).slice(-600)}`);
    }
    const identityAfter = await until(() => json(`${debugOrigin}/sim/v1/status`).then((r) => r.body), (s) => s.runId === identityBefore.runId, "producer reopened", 120000);
    assert.equal(identityAfter.genesisHash, identityBefore.genesisHash);
    assert.ok(Number(identityAfter.head.height) >= Number(identityBefore.head.height));
    const explorerAfter = await until(() => json(`${debugOrigin}/api/sim/v1/nodes`).then((r) => r.body), (b) => b.explorer.health === "running" && b.nodes.light.available && b.nodes.full.available, "stack healthy after restart", 120000);
    assert.equal((await json(`${debugOrigin}/api/sim/v1/blocks/${sample}`)).body.header.hash, hashBefore);
    assert.equal((await json(`${debugOrigin}/sim/v1/feed/blocks/${sample}`)).body.header.hash, hashBefore);
    await until(() => json(`${debugOrigin}/sim/v1/status`).then((r) => (r.status === 200 ? Number(r.body.head.height) : -1)), (h) => h > Number(identityAfter.head.height), "production resumed after restart", 60000);
    await debug.reload({ waitUntil: "networkidle" });
    await card(debug, "Light follower").waitFor({ timeout: 30000 });
    report.restart = { sampleHeight: sample, hashUnchanged: true, runId: identityAfter.runId, headBefore: identityBefore.head.height, headAfter: identityAfter.head.height, explorerHealth: explorerAfter.explorer.health };
  }
  report.ok = true;
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await Bun.write(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.ok ? "ok" : "FAILED"}: report and screenshots in ${out}`);
}
