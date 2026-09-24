/** Opt-in real producer → scanner → PostgreSQL → API/UI → persisted light test.
 * TEST_DATABASE_URL must name a disposable LOCAL test server. This runner creates
 * and drops a separate database and never reads .env. Run with bun --no-env-file.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { openDb } from "../src/db";

const base = process.env.TEST_DATABASE_URL;
if (
  !base ||
  !["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)
)
  throw new Error("Explicit local TEST_DATABASE_URL required");
const root = resolve(import.meta.dir, "..");
const binary = resolve(
  process.env.SIMULATOR_BINARY ??
    join(root, "../arkiv-db-pure-astra/target/debug/arkiv-simulator"),
);
const scratch = await mkdtemp(join(tmpdir(), "arkiv-sim-e2e-"));
const databaseName = "sim_e2e_" + randomUUID().replaceAll("-", "");
const url = new URL(base);
url.pathname = "/" + databaseName;
const databaseUrl = url.toString();
const adminDb = openDb(base);
const processes = new Map<string, ReturnType<typeof Bun.spawn>>();
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !/^(DATABASE_URL|SOURCE_KIND|SIMULATOR_|AUTH_|GOOGLE_|PORT$|SERVER_)/.test(
        k,
      ),
  ),
) as Record<string, string>;
const port = () => {
  const s = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(),
  });
  const p = s.port!;
  s.stop(true);
  return p;
};
const p = {
  producer: port(),
  admin: port(),
  light: port(),
  api: port(),
  ui: port(),
};
const source = `http://127.0.0.1:${p.producer}`,
  light = `http://127.0.0.1:${p.light}`,
  api = `http://127.0.0.1:${p.api}`,
  ui = `http://localhost:${p.ui}`;
const secret = randomUUID() + randomUUID(),
  loginSecret = randomUUID();
async function start(
  name: string,
  cmd: string[],
  extra: Record<string, string> = {},
) {
  assert(!processes.has(name));
  const child = Bun.spawn(cmd, {
    cwd: root,
    env: { ...env, ...extra },
    stdout: Bun.file(join(scratch, name + ".log")),
    stderr: Bun.file(join(scratch, name + ".err")),
  });
  processes.set(name, child);
  return child;
}
async function stop(name: string) {
  const child = processes.get(name);
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(5000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  processes.delete(name);
}
async function json(
  address: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const response = await fetch(address, {
    signal: AbortSignal.timeout(10000),
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    headers: { "content-type": "application/json", ...headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(JSON.stringify({ status: response.status, data }));
  return data;
}
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  timeout = 30000,
): Promise<T> {
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
    await Bun.sleep(100);
  }
  throw new Error(`${label}: ${String(last)}`);
}
const nodeArgs = (role: string, name: string, listen: number) => [
  binary,
  role,
  "--unsigned-simulator",
  "--run-dir",
  join(scratch, name),
  "--listen",
  `127.0.0.1:${listen}`,
];
const producer = () =>
  start(
    "producer",
    [
      ...nodeArgs("producer", "node", p.producer),
      "--admin-listen",
      `127.0.0.1:${p.admin}`,
    ],
    { SIMULATOR_ADMIN_TOKEN: secret },
  );
let identity: any;
async function step() {
  const s = await json(source + "/sim/v1/status");
  const command = {
    commandId:
      "0x" +
      randomUUID().replaceAll("-", "") +
      randomUUID().replaceAll("-", ""),
    runId: s.runId,
    expectedRevision: s.configRevision,
    expectedHeight: s.head.height,
    action: "step",
    config: null,
  };
  const reply = await json(
    `http://127.0.0.1:${p.admin}/sim/v1/control`,
    command,
    { authorization: "Bearer " + secret },
  );
  assert.equal(reply.status, "committed");
  return reply;
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let dbCreated = false;
try {
  await adminDb.query(`CREATE DATABASE "${databaseName}"`);
  dbCreated = true;
  await producer();
  identity = await until(
    () => json(source + "/sim/v1/status"),
    (x) => x.head.height === "0",
    "producer startup",
  );
  const pins = [
    "--source-id",
    identity.sourceId,
    "--run-id",
    identity.runId,
    "--genesis-hash",
    identity.genesisHash,
    "--chain-id",
    identity.chainId,
  ];
  const startLight = () =>
    start("light", [
      ...nodeArgs("light", "light", p.light),
      "--peer",
      source,
      ...pins,
    ]);
  await startLight();
  await until(
    () => json(light + "/sim/v1/status"),
    (x) => x.head.height === "0",
    "light bootstrap",
  );
  for (let h = 1; h <= 20; h++) await step();
  const nativeEnv = {
    SOURCE_KIND: "native-simulator",
    DATABASE_URL: databaseUrl,
    SIMULATOR_URL: source,
    SIMULATOR_SOURCE_ID: identity.sourceId,
    SIMULATOR_RUN_ID: identity.runId,
    SIMULATOR_GENESIS_HASH: identity.genesisHash,
    SIMULATOR_CHAIN_ID: identity.chainId,
    SIMULATOR_SCHEMA: "sim_e2e",
    SIMULATOR_POLL_MS: "100",
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(p.api),
    SIMULATOR_CONTROL_URL: `http://127.0.0.1:${p.admin}`,
    SIMULATOR_CONTROL_TOKEN: secret,
    AUTH_TOKEN_LOGIN_ENABLED: "true",
    AUTH_TOKEN_LOGIN_TOKEN: loginSecret,
    AUTH_ADMIN_EMAILS: "operator@example.test",
    AUTH_PUBLIC_ORIGIN: ui,
    AUTH_INSECURE_LOCALHOST: "true",
  };
  const scan = () =>
    start(
      "scanner",
      ["bun", "--no-env-file", "run", "src/index.ts"],
      nativeEnv,
    );
  await scan();
  await start(
    "backend",
    ["bun", "--no-env-file", "run", "src/serve.ts"],
    nativeEnv,
  );
  await until(
    () => json(api + "/sim/v1/status"),
    (x) => x.indexed?.height === "20",
    "initial PG catchup",
  );
  await until(
    () => json(light + "/sim/v1/status"),
    (x) => x.head.height === "20",
    "light catchup",
  );
  const eq = {
    height: "18",
    namespace: "1",
    attribute: "group",
    valueType: "u64",
    value: "1",
    limit: 3,
    cursor: null,
  };
  const first = await json(light + "/sim/v1/query/verified", eq);
  assert.deepEqual(
    first.rows.map((r: any) => r.recordId),
    ["3", "4", "5"],
  );
  assert.equal(first.postingCount, 5);
  const projected = await json(api + "/sim/v1/query", {
    namespaceId: "1",
    atHeight: "18",
    limit: 3,
    predicate: {
      op: "eq",
      attribute: { name: "group", type: "u64", value: "1" },
    },
  });
  assert.deepEqual(
    projected.rows.map((r: any) => r.recordId),
    ["3", "4", "5"],
  );
  assert.equal(projected.verification, "unverified-projection");
  // Offline explorer and durable process restarts. Scanner later fills the exact gap.
  await stop("scanner");
  await stop("producer");
  assert.deepEqual(
    (
      await json(api + "/sim/v1/records?namespaceId=1&atHeight=18&limit=64")
    ).rows.map((r: any) => r.recordId),
    ["3", "4", "5", "6", "7"],
  );
  await producer();
  const reopened = await until(
    () => json(source + "/sim/v1/status"),
    (x) => x.head.height === "20",
    "producer reopen",
  );
  assert.equal(reopened.runId, identity.runId);
  assert.equal(reopened.paused, true);
  for (let h = 21; h <= 24; h++) await step();
  const second = await json(light + "/sim/v1/query/verified", {
    ...eq,
    cursor: first.continuation,
  });
  assert.deepEqual(
    second.rows.map((r: any) => r.recordId),
    ["6", "7"],
  );
  assert.equal(second.snapshot.hash, first.snapshot.hash);
  await scan();
  await until(
    () => json(api + "/sim/v1/status"),
    (x) => x.indexed?.height === "24",
    "scanner resume exact gap",
  );
  await stop("light");
  await startLight();
  await until(
    () => json(light + "/sim/v1/status"),
    (x) => x.head.height === "24",
    "light durable reopen",
  );
  await start("frontend", ["node", "frontend/server.js"], {
    HOST: "127.0.0.1",
    PORT: String(p.ui),
    BACKEND_HOST: "127.0.0.1",
    BACKEND_PORT: String(p.api),
    LOCAL_SIMULATOR_LIGHT_HOST: "127.0.0.1",
    LOCAL_SIMULATOR_LIGHT_PORT: String(p.light),
  });
  await until(
    () => fetch(ui + "/api/health").then((r) => r.json()),
    (x) => x.sourceKind === "arkiv-native-simulator",
    "frontend proxy",
  );
  const routes: string[] = [];
  const errors: string[] = [];
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("request", (r) => {
    if (r.url().startsWith(ui)) routes.push(new URL(r.url()).pathname);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(ui);
  await page
    .getByRole("heading", { name: "Chain simulator", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Producer controls" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Query", exact: true }).click();
  await page.getByLabel("Snapshot height").fill("18");
  await page.route(
    "**/api/sim/v1/query",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.identity.runId = "ff".repeat(16);
      await route.fulfill({ response, json: body });
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Read projection", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Invalid projection response" })
    .waitFor();
  assert.equal(await page.locator(".sim-table tbody tr").count(), 0);

  await page
    .getByRole("button", { name: "Read projection", exact: true })
    .click();
  await page
    .locator(".sim-result-heading .sim-badge")
    .filter({ hasText: "Unverified projection" })
    .waitFor();
  await page
    .getByRole("button", { name: "Verify Eq locally", exact: true })
    .click();
  await page.locator(".sim-badge.verified").waitFor();
  assert.equal(await page.locator(".sim-table tbody tr").count(), 3);
  await page
    .getByRole("button", { name: "Next verified page", exact: true })
    .click();
  await until(
    () => page.locator(".sim-table tbody tr").count(),
    (n) => n === 2,
    "verified next page",
  );
  await page.getByLabel("Value", { exact: true }).fill("2");
  assert.equal(await page.locator(".sim-badge.verified").count(), 0);
  await page.getByLabel("Value", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Verify Eq locally", exact: true })
    .click();
  await page.locator(".sim-badge.verified").waitFor();
  await mkdir(join(scratch, "screenshots"));
  await page.screenshot({
    path: join(scratch, "screenshots", "verified-eq.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Admin login", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("operator@example.test");
  await page.getByLabel("Admin token", { exact: true }).fill(loginSecret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Producer controls", exact: true })
    .waitFor();

  await page.route(
    "**/api/admin/sim/v1/control",
    (route) =>
      route.fulfill({ status: 409, json: { error: "ControlConflict" } }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Command rejected" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry same command", exact: true })
      .count(),
    0,
  );
  await until(
    () => page.getByRole("button", { name: "Step", exact: true }).isEnabled(),
    Boolean,
    "rejected command unlocks new command",
  );
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await until(
    () => json(source + "/sim/v1/status"),
    (s) => s.head.height === "25",
    "authenticated UI step",
  );

  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route(
    "**/api/admin/sim/v1/control",
    async (route) => {
      intercepted = true;
      await held;
      await route.fulfill({ status: 503, json: { error: "CommitUncertain" } });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await until(
    async () => intercepted,
    Boolean,
    "in-flight control held for logout",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await until(
    () => page.getByRole("heading", { name: "Producer controls" }).count(),
    (n) => n === 0,
    "logout hides controls",
  );
  release();
  await Bun.sleep(100);
  await page.getByRole("button", { name: "Admin login", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill("operator@example.test");
  await page.getByLabel("Admin token", { exact: true }).fill(loginSecret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Producer controls", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Retry same command", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: "CommitUncertain" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();

  assert.equal(
    routes.some((r) => /shadow-rpc|baseload|batcher|faucet|rpc-keys/.test(r)),
    false,
  );
  assert.deepEqual(errors, []);
  // Body/control routes cannot accidentally travel through the local verifier proxy.
  for (const path of [
    "/local-sim/v1/replication/blocks/1",
    "/local-sim/v1/control",
  ])
    assert.equal((await fetch(ui + path)).status, 404);
  console.log(
    JSON.stringify(
      {
        ok: true,
        blocks: 26,
        independentHistoricalIds: ["3", "4", "5", "6", "7"],
        producerRestart: "same run, paused",
        scannerRestart: "20→24 without skip",
        lightRestart: "durable catalog",
        browser:
          "projection, proof paging, stale badge clearing, admin step/logout, no Ethereum requests",
        artifacts: scratch,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  for (const name of [...processes.keys()].reverse()) await stop(name);
  if (dbCreated)
    await adminDb.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await adminDb.close();
  // Logs/screenshots retained for review; node database files contain test payload only.
}
