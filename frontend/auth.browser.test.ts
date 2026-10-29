import { WebsiteRpcTokens } from "../src/websiteRpcTokens";
// Opt-in: build frontend first, then RUN_AUTH_BROWSER_TESTS=1 bun --no-env-file test frontend/auth.browser.test.ts
// Uses a real browser and the production frontend proxy, with a local fake API.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { AuthSession } from "./src/authClient";

const suite = process.env.RUN_AUTH_BROWSER_TESTS === "1" ? describe : describe.skip;
suite("Google login UI and proxy", () => {
  let browser: Browser;
  let backend: ReturnType<typeof Bun.serve>;
  let frontend: ReturnType<typeof Bun.spawn>;
  let base: string;
  let session: AuthSession;
  let accessTokens: Array<{id:string;name:string;createdAt:number;expiresAt:number;revokedAt:number|null}> = [];
  const browserErrors: string[] = [];
  const openPage = async (context: BrowserContext) => {
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", (error) => browserErrors.push(error.message));
    return page;
  };
  afterEach(() => { const errors = browserErrors.splice(0); expect(errors).toEqual([]); });
  const calls: Array<{ path: string; method: string; csrf: string | null }> = [];
  const anonymous = (): AuthSession => ({ role: "anonymous", user: null, csrfToken: null, expiresAt: null, loginAvailable: true });
  const signedIn = (role: "admin" | "user"): AuthSession => ({
    role, user: { id: "user-1", email: role === "admin" ? "sieciech.czajka@golem.network" : "someone@example.com", name: "Test Account" },
    csrfToken: "browser-test-csrf", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), loginAvailable: true,
  });

  let rpcTokens: WebsiteRpcTokens;
  beforeAll(async () => {
    if (!await Bun.file(`${import.meta.dir}/dist/index.html`).exists()) throw new Error("Build frontend before running browser tests");
    backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, method: request.method, csrf: request.headers.get("X-CSRF-Token") });
      if (path === "/website-rpc/token") {
        rpcTokens ??= new WebsiteRpcTokens({ insecureLocalhost: true, publicOrigin: base });
        return rpcTokens.issue(request);
      }
      if (path === "/auth/session") return Response.json(session, { headers: { "Cache-Control": "no-store" } });
      if (path === "/auth/access-tokens") {
        if (request.method === "POST") {
          const body=await request.json();
          const token={id:"token-1",name:body.name,createdAt:Date.now(),expiresAt:Date.now()+body.validityDays*86400000,revokedAt:null};
          accessTokens.push(token); return Response.json({...token,token:"arkiv_browser-test-secret"},{status:201});
        }
        return Response.json({tokens:accessTokens});
      }
      if (path === "/auth/access-tokens/token-1" && request.method === "DELETE") {
        accessTokens=accessTokens.map(t=>({...t,revokedAt:Date.now()}));return new Response(null,{status:204});
      }
      if (path === "/auth/token-login") {
        if (!session.tokenLoginAvailable) return new Response(null, {status:404});
        const body = await request.json();
        if (body.token !== "browser-admin-token") return new Response(null, {status:401});
        session = {...signedIn(body.email === "sieciech.czajka@golem.network" ? "admin" : "user"), tokenLoginAvailable:true};
        return new Response(null, {status:204});
      }
      if (path === "/auth/logout") {
        if (request.headers.get("X-CSRF-Token") !== "browser-test-csrf") return new Response(null, { status: 403 });
        session = {...anonymous(),tokenLoginAvailable:!!session.tokenLoginAvailable};
        return new Response(null, { status: 204 });
      }
      if (path === "/auth/proxy-cookie-test") {
        const headers = new Headers({ "Cache-Control": "no-store" });
        headers.append("Set-Cookie", "one=1; Path=/; HttpOnly; SameSite=Lax");
        headers.append("Set-Cookie", "two=2; Path=/; HttpOnly; SameSite=Lax");
        return new Response(request.headers.get("cookie"), { headers });
      }
      if (path === "/health") return Response.json({ features: { transactionData: true, entityQueryIndex: { projectedThroughBlock: "10", floorBlock: "0", lagBlocks: 0, liveEntities: 0 }, jsonRpcPassthrough: ["arkiv_query", "arkiv_getEntityCount", "arkiv_getBlockTiming"] } });
      if (path === "/blocks") return Response.json({ blocks: [], count: 0, limit: 10000, truncated: false });
      if (path === "/admin/metrics") return new Response("# TYPE process_uptime_seconds gauge\nprocess_uptime_seconds 1\n");
      if (path === "/entity-explorer/rpc") {
        if (!rpcTokens.accepts(request)) return new Response(null, { status: 401 });
        // The node, as the relay answers for it: one entity of the node's arkiv_query shape.
        const body = await request.json();
        const owner = `0x${"44".repeat(20)}`;
        const result = body.method === "arkiv_getBlockTiming"
          ? { current_block: 10, current_block_time: 1_800_000_000, duration: 2 }
          : { data: [{
              key: `0x${"01".padStart(64, "0")}`, owner, creator: owner, createdAt: "0x1", updatedAt: "0x1", expiresAt: "0x64",
              creationFlags: { raw: 0, readonly: false, permissionlessExtension: false },
              attributes: [{ name: "arkiv.schema", type: "str", value: "arkiv-demo.posts" }, { name: "score", type: "i32", value: 3 }],
              attributeSchema: [{ name: "arkiv.schema", type: "str", indexed: true }, { name: "score", type: "i32", indexed: true }],
            }], blockNumber: "0xa", cursor: null };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }
      if (path.startsWith("/shadow-rpc")) {
        const body = await request.json();
        const result = body.method === "arkiv_getBlockTiming"
          ? { current_block: 10, current_block_time: 1_800_000_000, duration: 2 }
          : body.method === "arkiv_getEntityCount" ? 0 : { data: [], blockNumber: "0xa", cursor: null };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }
      if (path === "/baseload/configs") return Response.json({ configs: [] });
      return new Response("Test API does not implement this public endpoint", { status: 503 });
    } });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    reservation.stop(true);
    base = `http://127.0.0.1:${port}`;
    frontend = Bun.spawn(["node", `${import.meta.dir}/server.js`], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BACKEND_HOST: "127.0.0.1", BACKEND_PORT: String(backend.port), STATIC_DIR: `${import.meta.dir}/dist` },
      stdout: "ignore", stderr: "inherit",
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(base)).ok) break; } catch { /* Await local server. */ }
      await Bun.sleep(100);
    }
    browser = await chromium.launch({ headless: true });
  }, 15_000);

  afterAll(async () => { await browser?.close(); frontend?.kill(); backend?.stop(true); });

  test("admin can create, dismiss and revoke temporary tokens without persisting the secret",async()=>{
    session=signedIn("admin");accessTokens=[];calls.length=0;
    const context=await browser.newContext(); const page=await openPage(context);
    await page.goto(base);
    await page.getByRole("button",{name:"Access tokens",exact:true}).click();
    await page.getByLabel("Name",{exact:true}).fill("Monitoring");
    await page.getByLabel("Valid for (days)").fill("7");
    await page.getByRole("button",{name:"Create token",exact:true}).click();
    await page.getByLabel("New access token").waitFor();
    expect(await page.getByLabel("New access token").inputValue()).toBe("arkiv_browser-test-secret");
    expect(calls.find(c=>c.path==="/auth/access-tokens" && c.method==="POST")?.csrf).toBe("browser-test-csrf");
    expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain("arkiv_browser-test-secret");
    await page.getByRole("button",{name:"Dismiss token"}).click();
    expect(await page.getByLabel("New access token").count()).toBe(0);
    await page.getByRole("button",{name:"Revoke",exact:true}).click();
    await page.getByText("— Revoked",{exact:false}).waitFor();
    expect(calls.find(c=>c.method==="DELETE")?.csrf).toBe("browser-test-csrf");
    await page.getByRole("button",{name:"Sign out",exact:true}).click();
    await page.getByRole("link",{name:"Sign in with Google"}).waitFor();
    expect(await page.getByRole("button",{name:"Access tokens",exact:true}).count()).toBe(0);
    await context.close();
  });

  test("anonymous direct admin links are guarded and the old token is removed", async () => {
    session = anonymous(); calls.length = 0;
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem("baseload.adminBearerToken", "obsolete"));
    const page = await openPage(context);
    await page.goto(`${base}/admin`);
    await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
    expect(await page.getByRole("button", {name:"Admin login",exact:true}).count()).toBe(0);
    expect(await page.getByRole("heading", { name: "Admin", exact: true }).count()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("baseload.adminBearerToken"))).toBeNull();
    expect(calls.some(({ path }) => path.startsWith("/admin/") || path.startsWith("/baseload"))).toBe(false);
    const href = await page.getByRole("link", { name: "Sign in with Google" }).getAttribute("href");
    expect(href).toStartWith("/api/auth/google/start?returnTo=");
    await context.close();
  });

  test("regular users have identity without administrator screens", async () => {
    session = signedIn("user");
    const context = await browser.newContext(); const page = await openPage(context);
    await page.goto(`${base}/baseload`);
    await page.getByText("Logged In", { exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: "Baseload", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /Disable admin mode/ }).count()).toBe(0);
    await context.close();
  });

  test("administrator can open settings and logout removes access across tabs", async () => {
    session = signedIn("admin"); calls.length = 0;
    const context = await browser.newContext();
    const page = await openPage(context); const second = await openPage(context);
    await page.goto(`${base}/admin`); await second.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Admin", exact: true }).waitFor();
    await second.getByRole("heading", { name: "Admin", exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
    await second.getByRole("link", { name: "Sign in with Google" }).waitFor();
    expect(await second.getByRole("heading", { name: "Admin", exact: true }).count()).toBe(0);
    expect(calls.find(({ path }) => path === "/auth/logout")?.csrf).toBe("browser-test-csrf");
    await context.close();
  });

  test("session expiry leaves admin screens without a page reload", async () => {
    session = signedIn("admin"); session.expiresAt = new Date(Date.now() + 1500).toISOString();
    const context = await browser.newContext(); const page = await openPage(context);
    await page.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Admin", exact: true }).waitFor();
    session = anonymous();
    await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
    expect(await page.getByRole("heading", { name: "Admin", exact: true }).count()).toBe(0);
    await context.close();
  });

  test("the entity explorer reads the node through its relay, never /shadow-rpc or the index, even for administrators", async () => {
    session = signedIn("admin"); calls.length = 0;
    const context = await browser.newContext(); const page = await openPage(context);
    await page.goto(`${base}/entity-explorer?q=${encodeURIComponent("arkiv.schema = str('arkiv-demo.posts')")}`);
    await page.getByText(/^\d+ entit/).waitFor();
    expect(calls.some(({ path }) => path === "/website-rpc/token")).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("arkiv.website-rpc.v1"))).toContain("wrpc.");
    expect(calls.some(({ path }) => path === "/entity-explorer/rpc")).toBe(true);
    expect(calls.some(({ path }) => path.startsWith("/shadow-rpc"))).toBe(false);
    await context.close();
  });

  test("login cancellation is visible and mobile account controls fit", async () => {
    session = anonymous();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await openPage(context); await page.goto(`${base}/?authError=cancelled`);
    await page.getByText("Google sign-in was cancelled.", { exact: false }).waitFor();
    const button = page.getByRole("link", { name: "Sign in with Google" });
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(page.url()).not.toContain("authError");
    await context.close();
  });

  test("entity explorer query history fits a phone and loads an entry into the editor", async () => {
    session = anonymous();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await openPage(context);
    await page.goto(`${base}/entity-explorer?q=${encodeURIComponent("TYPEOF(score) = i32")}`);
    await page.getByText(/^\d+ entit/).waitFor();
    await page.getByRole("button", { name: /^History/ }).click();
    const dialog = page.getByRole("dialog", { name: "Query history" });
    await dialog.waitFor();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await dialog.getByRole("button", { name: "Load into editor", exact: true }).first().click();
    expect(await dialog.count()).toBe(0);
    await context.close();
  });

  test("mobile home search fits and display settings close with Escape", async () => {
    session = anonymous();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await openPage(context);
    await page.goto(base);
    const search = page.getByRole("combobox", { name: "Search the indexer" });
    await search.waitFor();
    const searchBounds = (await search.boundingBox())!;
    expect(searchBounds.x).toBeGreaterThanOrEqual(0);
    expect(searchBounds.x + searchBounds.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    const timeZone = page.getByLabel("Time zone", { exact: true });
    await timeZone.waitFor();
    const bounds = (await timeZone.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await timeZone.waitFor({ state: "detached" });
    await context.close();
  });

  for (const width of [1440, 390]) {
    test(`header links and display settings work at ${width}px`, async () => {
      session = anonymous();
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await openPage(context);
      await page.goto(base);
      await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
      const nav = page.getByRole("navigation", { name: "Primary navigation" });
      const labels = (await nav.getByRole("link").allTextContents()).map((label) => label.trim());
      expect(labels).toEqual(["Home", "Blocks", "Wallets", "Transactions", "Entities"]);
      expect(await nav.getByRole("link", { name: "Home", exact: true }).getAttribute("aria-current")).toBe("page");
      expect(await page.getByRole("link", { name: "Admin", exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.getByRole("button", { name: "Display settings", exact: true }).click();
      const popup = page.getByRole("dialog", { name: "Display settings" });
      await popup.waitFor();
      const bounds = (await popup.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      await popup.getByRole("button", { name: "Full width", exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem("gas-price-tracker:ui.fullWidth") === "true");
      await popup.getByTitle("Switch to dark mode", { exact: true }).click();
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      await popup.getByLabel("Time zone", { exact: true }).selectOption("UTC");
      await page.waitForFunction(() => localStorage.getItem("gas-price-tracker:timeZone") === "UTC");
      await page.mouse.click(1, 843);
      await popup.waitFor({ state: "detached" });
      await nav.getByRole("link", { name: "Entities", exact: true }).click();
      await page.getByRole("heading", { name: "Entities", exact: true }).waitFor();
      expect(await nav.getByRole("link", { name: "Entities", exact: true }).getAttribute("aria-current")).toBe("page");
      await context.close();
    });
  }

  test("transactions and wallets searches open a complete hash or address directly", async () => {
    session = anonymous();
    const context = await browser.newContext(); const page = await openPage(context);
    const hash = `0x${"ab".repeat(32)}`; const address = `0x${"cd".repeat(20)}`;
    await page.goto(`${base}/transactions`);
    await page.getByRole("heading", { name: "Transactions", exact: true }).waitFor();
    await page.getByPlaceholder("Search by transaction hash or address…").fill(hash);
    await page.keyboard.press("Enter");
    await page.waitForURL(`${base}/tx/${hash}`);
    await page.goto(`${base}/senders`);
    await page.getByRole("heading", { name: "Wallets", exact: true }).waitFor();
    await page.getByPlaceholder("Search by wallet address…").fill(address);
    await page.keyboard.press("Enter");
    await page.waitForURL(`${base}/address/${address}`);
    await page.getByRole("heading", { name: "Wallet", exact: true }).waitFor();
    await context.close();
  });

  test("production proxy preserves request cookies and multiple response cookies", async () => {
    const response = await fetch(`${base}/api/auth/proxy-cookie-test`, { headers: { Cookie: "session=example" } });
    expect(await response.text()).toBe("session=example");
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("optional token form supports both roles, clears rejected tokens and never stores the credential", async () => {
    session = {...anonymous(),tokenLoginAvailable:true};
    const context = await browser.newContext({viewport:{width:390,height:844}});
    const page = await openPage(context); await page.goto(`${base}/admin`);
    await page.getByRole("button",{name:"Admin login",exact:true}).click();
    const email = page.getByLabel("Email",{exact:true}); const token = page.getByLabel("Admin token",{exact:true});
    const bounds = await token.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);
    await email.fill("someone@example.com");await token.fill("wrong");
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page.getByText("Invalid admin token.",{exact:false}).waitFor();
    expect(await token.inputValue()).toBe("");
    await token.fill("browser-admin-token");await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page.getByText("Logged In",{exact:true}).waitFor();
    expect(await page.getByRole("heading",{name:"Admin",exact:true}).count()).toBe(0);
    await page.getByRole("button",{name:"Sign out",exact:true}).click();
    await page.getByRole("button",{name:"Admin login",exact:true}).click();
    await email.fill("sieciech.czajka@golem.network");await token.fill("browser-admin-token");
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page.getByText("Administrator",{exact:true}).waitFor();
    await page.goto(`${base}/admin`);await page.getByRole("heading",{name:"Admin",exact:true}).waitFor();
    const stored = await page.evaluate(() => JSON.stringify([localStorage,sessionStorage]));
    expect(stored).not.toContain("browser-admin-token");expect(page.url()).not.toContain("browser-admin-token");
    await context.close();
  });
});
