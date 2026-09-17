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

  beforeAll(async () => {
    if (!await Bun.file(`${import.meta.dir}/dist/index.html`).exists()) throw new Error("Build frontend before running browser tests");
    backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ path, method: request.method, csrf: request.headers.get("X-CSRF-Token") });
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
    expect(await page.getByRole("heading", { name: "Page settings" }).count()).toBe(0);
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
    expect(await page.getByRole("heading", { name: "Baseload workers" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /Disable admin mode/ }).count()).toBe(0);
    await context.close();
  });

  test("administrator can open settings and logout removes access across tabs", async () => {
    session = signedIn("admin"); calls.length = 0;
    const context = await browser.newContext();
    const page = await openPage(context); const second = await openPage(context);
    await page.goto(`${base}/admin`); await second.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Page settings" }).waitFor();
    await second.getByRole("heading", { name: "Page settings" }).waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
    await second.getByRole("link", { name: "Sign in with Google" }).waitFor();
    expect(await second.getByRole("heading", { name: "Page settings" }).count()).toBe(0);
    expect(calls.find(({ path }) => path === "/auth/logout")?.csrf).toBe("browser-test-csrf");
    await context.close();
  });

  test("session expiry leaves admin screens without a page reload", async () => {
    session = signedIn("admin"); session.expiresAt = new Date(Date.now() + 1500).toISOString();
    const context = await browser.newContext(); const page = await openPage(context);
    await page.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Page settings" }).waitFor();
    session = anonymous();
    await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
    expect(await page.getByRole("heading", { name: "Page settings" }).count()).toBe(0);
    await context.close();
  });

  test("regular users opening comparison links query only the public index", async () => {
    session = signedIn("user"); calls.length = 0;
    const context = await browser.newContext(); const page = await openPage(context);
    const queried = page.waitForResponse((response) => response.url().endsWith("/api/shadow-rpc/experimental"));
    await page.goto(`${base}/data?rpc=both&q=*`); await queried;
    await page.getByText("Logged In", { exact: true }).waitFor();
    expect(calls.some(({ path }) => path === "/shadow-rpc")).toBe(false);
    await context.close();
  });

  test("administrator comparison queries use the current session's CSRF token", async () => {
    session = signedIn("admin"); calls.length = 0;
    const context = await browser.newContext(); const page = await openPage(context);
    const queried = page.waitForResponse((response) => response.url().endsWith("/api/shadow-rpc") && response.request().postDataJSON()?.method === "arkiv_query");
    await page.goto(`${base}/data?rpc=both&q=*`); await queried;
    expect(calls.filter(({ path }) => path === "/shadow-rpc").every(({ csrf }) => csrf === "browser-test-csrf")).toBe(true);
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

  test("redesigned Data controls preserve historical counts and query history", async () => {
    session = anonymous();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await openPage(context);
    await page.goto(`${base}/data?q=*&block=7`);
    const countButton = page.getByRole("button", { name: "Count query", exact: true });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(button => button.textContent?.trim() === "Count query" && !button.disabled));
    expect(await page.getByLabel("At block", { exact: true }).inputValue()).toBe("7");
    expect(await page.getByRole("tab", { name: "Default node", exact: true }).count()).toBe(0);
    const request = page.waitForRequest(request => request.postDataJSON()?.method === "arkiv_getEntityCount");
    await countButton.click();
    expect((await request).postDataJSON().params).toEqual([{ query: "*", block: 7 }]);
    await page.getByText("0 matching entities at block 7", { exact: true }).waitFor();
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

  test("mobile home charts keep their height and popup navigation closes with Escape", async () => {
    session = anonymous();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await openPage(context);
    await page.goto(base);
    const chart = page.locator('[data-slot="card"]').filter({ hasText: "Network usage" }).last();
    await chart.waitFor();
    // Empty/loading charts need the same reserved area as populated charts.
    expect((await chart.boundingBox())!.height).toBeGreaterThanOrEqual(260);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "Open navigation menu", exact: true }).click();
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
    test(`popup navigation keeps pages and display controls together at ${width}px`, async () => {
      session = anonymous();
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      const page = await openPage(context);
      await page.goto(base);
      await page.getByRole("link", { name: "Sign in with Google" }).waitFor();
      expect(await page.getByRole("navigation", { name: "Primary navigation" }).count()).toBe(0);
      await page.getByRole("button", { name: "Open navigation menu", exact: true }).click();
      const popup = page.getByRole("dialog", { name: "Navigation menu" });
      await popup.waitFor();
      const bounds = (await popup.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      expect(await popup.getByRole("link", { name: "Home", exact: true }).getAttribute("aria-current")).toBe("page");
      expect(await popup.getByRole("link", { name: "Admin", exact: true }).count()).toBe(0);
      await popup.getByRole("button", { name: "Full width", exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem("gas-price-tracker:ui.fullWidth") === "true");
      await popup.getByTitle("Switch to dark mode", { exact: true }).click();
      await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
      await popup.getByLabel("Time zone", { exact: true }).selectOption("UTC");
      await page.waitForFunction(() => localStorage.getItem("gas-price-tracker:timeZone") === "UTC");
      await popup.getByRole("link", { name: "Data", exact: true }).click();
      await popup.waitFor({ state: "detached" });
      await page.getByRole("heading", { name: "Data", exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Open navigation menu", exact: true }).textContent()).toBe("Data");
      await page.getByRole("button", { name: "Open navigation menu", exact: true }).click();
      await popup.waitFor();
      await page.mouse.click(1, 843);
      await popup.waitFor({ state: "detached" });
      await context.close();
    });
  }

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
    expect(await page.getByRole("heading",{name:"Page settings"}).count()).toBe(0);
    await page.getByRole("button",{name:"Sign out",exact:true}).click();
    await page.getByRole("button",{name:"Admin login",exact:true}).click();
    await email.fill("sieciech.czajka@golem.network");await token.fill("browser-admin-token");
    await page.getByRole("button",{name:"Sign in",exact:true}).click();
    await page.getByText("Administrator",{exact:true}).waitFor();
    await page.goto(`${base}/admin`);await page.getByRole("heading",{name:"Page settings"}).waitFor();
    const stored = await page.evaluate(() => JSON.stringify([localStorage,sessionStorage]));
    expect(stored).not.toContain("browser-admin-token");expect(page.url()).not.toContain("browser-admin-token");
    await context.close();
  });
});
