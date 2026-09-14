import { describe, expect, test } from "bun:test";
import { AuthService, roleForIdentity, safeReturnPath, tokenHash } from "./auth";
import { parseAuthConfig } from "./authConfig";
import { handleRequest } from "./server";
import type { ScannerStorage } from "./storage";
import { MemoryAuthStore, TEST_ADMIN, TEST_AUTH_CONFIG, TEST_SESSION_TOKEN, testAdminHeaders, testAuth } from "./testAuth";
import type { OidcProvider } from "./googleOidc";
import type { BlockServerOptions } from "./server";

const stubStorage = {} as ScannerStorage;
const request = (path: string, method = "GET", headers: Record<string,string> = {}, body?: string) =>
  new Request(`https://explorer.test${path}`, { method,headers,...(body ? {body} : {}) });
const fakeProvider: OidcProvider = {
  async authorizationUrl(state) { return `https://accounts.google.com/authorize?state=${state}`; },
  async authenticate() { return TEST_ADMIN; },
};

function harness() {
  let now = 1_800_000_000_000;
  const store = new MemoryAuthStore();
  const auth = new AuthService(TEST_AUTH_CONFIG,store,fakeProvider,() => now);
  return {store,auth,advance: (ms:number) => { now += ms; },start: async () => {
    const response = await auth.handle(request("/auth/google/start?returnTo=%2Fdata%3Fa%3D1"));
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
    return {cookie,state};
  }};
}

describe("Google session lifecycle", () => {
  test("binds login to browser, consumes once, creates identity and hash-only session, rotates and logs out", async () => {
    const h = harness();
    const {cookie,state} = await h.start();
    expect((await h.auth.handle(request(`/auth/google/callback?state=${state}&code=x`))).status).toBe(400);
    const response = await h.auth.handle(request(`/auth/google/callback?state=${state}&code=x`,"GET",{Cookie:cookie}));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/data?a=1");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    const sessionCookie = cookies.find((c) => c.startsWith("__Host-arkiv_session="))!;
    expect(sessionCookie).toContain("HttpOnly; SameSite=Lax; Max-Age=43200; Secure");
    expect(sessionCookie).not.toContain("Domain=");
    const rawCookie = sessionCookie.split(";")[0]!;
    const rawToken = rawCookie.split("=")[1]!;
    expect(h.store.sessions.has(rawToken)).toBe(false);
    expect(h.store.sessions.has(tokenHash(rawToken))).toBe(true);
    const identity = await (await h.auth.handle(request("/auth/session","GET",{Cookie:rawCookie}))).json();
    expect(identity.role).toBe("admin");
    expect(identity.user.email).toBe(TEST_ADMIN.email);
    expect(identity).not.toHaveProperty("sub");
    expect((await h.auth.handle(request(`/auth/google/callback?state=${state}&code=x`,"GET",{Cookie:cookie}))).status).toBe(400);
    const next = await h.start();
    await h.auth.handle(request(`/auth/google/callback?state=${next.state}&code=x`,"GET",{Cookie:`${next.cookie}; ${rawCookie}`}));
    expect(h.store.sessions.has(tokenHash(rawToken))).toBe(false);
    const headers = {Cookie:rawCookie,Origin:TEST_AUTH_CONFIG.publicOrigin,"X-CSRF-Token":identity.csrfToken};
    expect((await h.auth.handle(request("/auth/logout","POST",headers))).status).toBe(401);
    // A separate fresh session is revocable and logout requires origin plus its CSRF binding.
    h.store.sessions.set(tokenHash(rawToken),{user:TEST_ADMIN,csrfToken:identity.csrfToken,expiresAt:1_900_000_000_000});
    expect((await h.auth.handle(request("/auth/logout","POST",{Cookie:rawCookie}))).status).toBe(403);
    const logout = await h.auth.handle(request("/auth/logout","POST",headers));
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await (await h.auth.handle(request("/auth/session","GET",{Cookie:rawCookie}))).json()).role).toBe("anonymous");
  });
  test("rejects expired and mismatched state and browser bindings", async () => {
    const h = harness();const {cookie,state} = await h.start();
    expect((await h.auth.handle(request(`/auth/google/callback?state=${"x".repeat(43)}`,"GET",{Cookie:cookie}))).status).toBe(400);
    expect((await h.auth.handle(request(`/auth/google/callback?state=${state}`,"GET",{Cookie:`__Host-arkiv_login=${"z".repeat(43)}`}))).status).toBe(400);
    h.advance(600_001);
    expect((await h.auth.handle(request(`/auth/google/callback?state=${state}`,"GET",{Cookie:cookie}))).status).toBe(400);
  });
  test("cancellation is a bounded error and doesn't mint a session", async () => {
    const h = harness();
    const auth = new AuthService(TEST_AUTH_CONFIG,h.store,{...fakeProvider,async authenticate() {throw new Error("sensitive provider body");}},() => 1_800_000_000_000);
    const {cookie,state} = await h.start();
    const response = await auth.handle(request(`/auth/google/callback?state=${state}&error=access_denied`,"GET",{Cookie:cookie}));
    expect(response.headers.get("location")).toBe("/data?a=1&authError=cancelled");
    expect(h.store.sessions.size).toBe(0);
    expect(await response.text()).not.toContain("sensitive");
  });
  test("session expiry, disabled users and current allowlist are checked on each request", async () => {
    const h = harness();
    h.store.sessions.set(tokenHash(TEST_SESSION_TOKEN),{user:TEST_ADMIN,csrfToken:"test-csrf",expiresAt:1_800_000_001_000});
    expect(await h.auth.requireAdmin(request("/baseload/configs","GET",testAdminHeaders))).toBeNull();
    const noAdmins = new AuthService({...TEST_AUTH_CONFIG,adminEmails:new Set()},h.store,fakeProvider,() => 1_800_000_000_000);
    expect((await noAdmins.requireAdmin(request("/baseload/configs","GET",testAdminHeaders)))?.status).toBe(403);
    h.store.users.set(TEST_ADMIN.sub,{...TEST_ADMIN,disabled:true});
    expect((await h.auth.requireAdmin(request("/baseload/configs","GET",testAdminHeaders)))?.status).toBe(401);
    h.store.users.clear();h.advance(1001);
    expect((await h.auth.requireAdmin(request("/baseload/configs","GET",testAdminHeaders)))?.status).toBe(401);
  });
});

describe("authorization boundaries", () => {
  const surfaces: [string,string][] = [["/baseload","PUT"],["/baseload/configs","GET"],["/baseload/configs/a","GET"],
    ["/baseload/configs/a","PUT"],["/baseload/configs/a","DELETE"],["/baseload/configs/a/load","PUT"],
    ["/shadow-rpc","POST"],["/admin/metrics","GET"]];
  for (const [path,method] of surfaces) test(`${method} ${path} rejects anonymous and ordinary users before any side effect`, async () => {
    const storage = new Proxy({}, {get() {throw new Error("Storage must not be accessed");}}) as ScannerStorage;
    expect((await handleRequest(request(path,method),storage,{auth:testAuth()})).status).toBe(401);
    const auth = testAuth({...TEST_ADMIN,email:"someone@golem.network"});
    expect((await handleRequest(request(path,method,testAdminHeaders),storage,{auth})).status).toBe(403);
  });
  test("requires exact email, verified email and signed Workspace domain", () => {
    const role = (overrides = {}) => roleForIdentity({...TEST_ADMIN,...overrides},TEST_AUTH_CONFIG.adminEmails);
    expect(role()).toBe("admin");
    for (const overrides of [{email:"other@golem.network"},{email:"sieciech.czajka@golem.network.evil"},
      {emailVerified:false},{hostedDomain:null},{hostedDomain:"Golem.network"}]) expect(role(overrides)).toBe("user");
  });
  test("CSRF requires both exact configured origin and session-bound token", async () => {
    const auth = testAuth();
    for (const headers of [{Cookie:testAdminHeaders.Cookie}, {...testAdminHeaders,Origin:"https://evil.test"},
      {...testAdminHeaders,"X-CSRF-Token":"wrong"}]) expect((await auth.requireAdmin(request("/shadow-rpc","POST",headers)))?.status).toBe(403);
    expect(await auth.requireAdmin(request("/shadow-rpc","POST",testAdminHeaders))).toBeNull();
  });
  test("private responses cannot be cached, revalidated or credentialed cross-origin", async () => {
    const response = await handleRequest(request("/auth/session","GET",{...testAdminHeaders,"If-None-Match":"*"}),stubStorage,{auth:testAuth()});
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("etag")).toBe(false);expect(response.headers.has("access-control-allow-origin")).toBe(false);
    const preflight = await handleRequest(request("/shadow-rpc","OPTIONS",{Origin:"https://evil.test","Access-Control-Request-Headers":"X-CSRF-Token"}),stubStorage);
    expect(preflight.headers.has("access-control-allow-origin")).toBe(false);
  });
  test("auth DB failure gives 503 while public requests and missing-cookie browsing need no auth lookup", async () => {
    const store = new MemoryAuthStore();store.getSession = async () => {throw new Error("database secret");};
    const auth = new AuthService(TEST_AUTH_CONFIG,store,fakeProvider);
    const response = await handleRequest(request("/baseload/configs","GET",testAdminHeaders),stubStorage,{auth});
    expect(response.status).toBe(503);expect(await response.text()).not.toContain("secret");
    expect((await handleRequest(request("/auth/session"),stubStorage,{auth})).status).toBe(200);
    expect((await handleRequest(request("/unknown"),stubStorage,{auth})).status).toBe(404);
  });
  test("legacy environment secrets cannot authorize admin operations", async () => {
    const options = {auth:testAuth(),metricsBearerToken:"metrics-secret",baseloadAutomationToken:"ramp-secret"};
    for (const [path,method] of surfaces) for (const secret of ["metrics-secret","ramp-secret"]) {
      expect((await handleRequest(request(path,method,{Authorization:`Bearer ${secret}`}),stubStorage,options)).status).toBe(401);
    }
  });
  test("public experimental RPC never forwards any method, including mixed batches", async () => {
    let calls = 0;
    const options: BlockServerOptions = { jsonRpcPassthrough:{methods:new Set(["eth_chainId","eth_sendRawTransaction"]),
      async forward() {calls++;throw new Error("must not forward");}}, entityIndex:{} as BlockServerOptions["entityIndex"] & {} };
    const storage = {getChainId:async () => 1337n} as unknown as ScannerStorage;
    const response = await handleRequest(request("/shadow-rpc/experimental","POST",{},JSON.stringify([
      {jsonrpc:"2.0",id:1,method:"eth_chainId"},{jsonrpc:"2.0",id:2,method:"eth_sendRawTransaction",params:["0x123"]}
    ])),storage,options);
    expect(response.status).toBe(200);const body = await response.json();
    expect(body[0].result).toBe("0x539");expect(body[1].error.code).toBe(-32601);expect(calls).toBe(0);
  });
});

test("return paths cannot escape the application origin", () => {
  for (const value of [null,"//evil.test","/\\evil.test","https://evil.test","/%2f%2fevil.test","/%5cevil","/\n/evil","/api/auth/google/start"]) expect(safeReturnPath(value)).toBe("/");
  expect(safeReturnPath("/data?source=index#foo")).toBe("/data?source=index#foo");
});
test("configuration disables login only when absent and explicitly constrains insecure development cookies", () => {
  expect(parseAuthConfig({})).toBeUndefined();
  expect(() => parseAuthConfig({GOOGLE_CLIENT_ID:"x"})).toThrow();
  const env = {GOOGLE_CLIENT_ID:"x",GOOGLE_CLIENT_SECRET:"x",AUTH_PUBLIC_ORIGIN:"https://explorer.test"};
  expect([...parseAuthConfig(env)!.adminEmails]).toEqual([TEST_ADMIN.email]);
  for (const origin of ["http://explorer.test","https://explorer.test/path","https://user:pass@explorer.test"]) expect(() => parseAuthConfig({...env,AUTH_PUBLIC_ORIGIN:origin})).toThrow();
  expect(parseAuthConfig({...env,AUTH_PUBLIC_ORIGIN:"http://localhost:5173",AUTH_INSECURE_LOCALHOST:"true"})!.insecureLocalhost).toBe(true);
});

describe("optional token login", () => {
  const secret = "deployment-test-secret";
  const config = {...TEST_AUTH_CONFIG, tokenLoginToken:secret};
  const headers = {Origin:config.publicOrigin,"Content-Type":"application/json"};
  const login = (auth:AuthService,email=TEST_ADMIN.email,token=secret,extra={}) =>
    auth.handle(request("/auth/token-login","POST",{...headers,...extra},JSON.stringify({email,token})));
  const cookieOf = (response:Response) => response.headers.get("set-cookie")!.split(";")[0]!;
  test("default off, secret alone has no effect, and token-only deployments require explicit configuration", async () => {
    expect(parseAuthConfig({AUTH_TOKEN_LOGIN_TOKEN:secret})).toBeUndefined();
    expect(parseAuthConfig({AUTH_TOKEN_LOGIN_ENABLED:"false",AUTH_TOKEN_LOGIN_TOKEN:secret})).toBeUndefined();
    for (const env of [{AUTH_TOKEN_LOGIN_ENABLED:"yes"},{AUTH_TOKEN_LOGIN_ENABLED:"true"},
      {AUTH_TOKEN_LOGIN_ENABLED:"true",AUTH_TOKEN_LOGIN_TOKEN:secret}]) expect(() => parseAuthConfig(env)).toThrow();
    const tokenOnly = parseAuthConfig({AUTH_TOKEN_LOGIN_ENABLED:"true",AUTH_TOKEN_LOGIN_TOKEN:secret,AUTH_PUBLIC_ORIGIN:config.publicOrigin})!;
    const auth = new AuthService(tokenOnly,new MemoryAuthStore());
    expect(await (await auth.handle(request("/auth/session"))).json()).toMatchObject({loginAvailable:false,tokenLoginAvailable:true});
    expect((await auth.handle(request("/auth/google/start"))).status).toBe(503);
    expect((await login(auth)).status).toBe(204);
    expect((await login(new AuthService(TEST_AUTH_CONFIG,new MemoryAuthStore(),fakeProvider))).status).toBe(404);
    expect((await handleRequest(request("/auth/token-login","POST",headers,"{}"),stubStorage)).status).toBe(404);
  });
  test("email chooses role, identities stay separate from Google, sessions rotate and logout needs CSRF", async () => {
    const store = new MemoryAuthStore(); const auth = new AuthService(config,store,fakeProvider);
    store.users.set(TEST_ADMIN.sub,TEST_ADMIN);
    const response = await login(auth,"  SIECIECH.CZAJKA@GOLEM.NETWORK  ");
    expect(response.status).toBe(204);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Max-Age=43200; Secure");
    const cookie = cookieOf(response);
    const identity = await (await auth.handle(request("/auth/session","GET",{Cookie:cookie}))).json();
    expect(identity).toMatchObject({role:"admin",loginAvailable:true,tokenLoginAvailable:true,user:{email:TEST_ADMIN.email}});
    expect(identity.user.id).not.toBe(TEST_ADMIN.id);
    const stored = [...store.sessions.values()][0]!;
    expect(stored.user).toMatchObject({provider:"token",emailVerified:false,hostedDomain:null});
    expect(stored.tokenLoginKeyHash).toBe(tokenHash(secret));
    expect(await auth.requireAdmin(request("/admin/metrics","GET",{Cookie:cookie}))).toBeNull();
    expect((await auth.handle(request("/auth/logout","POST",{Cookie:cookie,Origin:config.publicOrigin}))).status).toBe(403);
    const next = await login(auth,"someone@example.com",secret,{Cookie:cookie});
    expect((await auth.requireAdmin(request("/admin/metrics","GET",{Cookie:cookie})))?.status).toBe(401);
    const nextCookie = cookieOf(next);
    const nextSession = await (await auth.handle(request("/auth/session","GET",{Cookie:nextCookie}))).json();
    expect(nextSession.role).toBe("user");
    expect((await auth.requireAdmin(request("/admin/metrics","GET",{Cookie:nextCookie})))?.status).toBe(403);
    expect((await auth.handle(request("/auth/logout","POST",{Cookie:nextCookie,Origin:config.publicOrigin,"X-CSRF-Token":nextSession.csrfToken}))).status).toBe(204);
    expect(store.sessions.size).toBe(0);
    expect(store.users.get(TEST_ADMIN.sub)).toEqual(TEST_ADMIN);
  });
  test("disable, rotation and disabled accounts invalidate token sessions without affecting Google sessions", async () => {
    const store = new MemoryAuthStore(); const auth = new AuthService(config,store,fakeProvider);
    const cookie = cookieOf(await login(auth));
    for (const nextConfig of [TEST_AUTH_CONFIG,{...config,tokenLoginToken:"rotated"}]) {
      const next = new AuthService(nextConfig,store,fakeProvider);
      expect((await next.requireAdmin(request("/admin/metrics","GET",{Cookie:cookie})))?.status).toBe(401);
      expect((await (await next.handle(request("/auth/session","GET",{Cookie:cookie}))).json()).role).toBe("anonymous");
      store.sessions.set(tokenHash(TEST_SESSION_TOKEN),{user:TEST_ADMIN,csrfToken:"test-csrf",expiresAt:Date.now()+60000});
      expect(await next.requireAdmin(request("/admin/metrics","GET",testAdminHeaders))).toBeNull();
    }
    const subject = `token:${tokenHash(TEST_ADMIN.email)}`;
    store.users.set(subject,{...store.users.get(subject)!,disabled:true});
    expect((await login(auth)).status).toBe(403);
    expect((await auth.requireAdmin(request("/admin/metrics","GET",{Cookie:cookie})))?.status).toBe(401);
  });
  test("rejects invalid credentials, cross-origin login, bearer credentials, malformed and oversized bodies, and throttles attempts", async () => {
    const store = new MemoryAuthStore(); const auth = new AuthService(config,store,fakeProvider);
    expect((await login(auth,TEST_ADMIN.email,"wrong")).status).toBe(401);
    expect((await login(auth,"invalid")).status).toBe(400);
    expect((await login(auth,TEST_ADMIN.email,secret,{Origin:"https://evil.test"})).status).toBe(403);
    expect((await login(auth,TEST_ADMIN.email,secret,{Authorization:`Bearer ${secret}`})).status).toBe(400);
    expect((await auth.handle(request("/auth/token-login","POST",{"Content-Type":"application/json"},"{}"))).status).toBe(403);
    expect((await login(auth,TEST_ADMIN.email,secret,{"Content-Type":"text/plain"})).status).toBe(415);
    for (const body of ["{","null","[]",JSON.stringify({email:123,token:secret})])
      expect((await auth.handle(request("/auth/token-login","POST",headers,body))).status).toBe(400);
    expect((await login(auth,TEST_ADMIN.email,"x".repeat(5000))).status).toBe(413);
    store.allowTokenLoginAttempt = async () => false;
    expect((await login(auth)).status).toBe(429);
    expect(store.sessions.size).toBe(0);
    expect((await auth.requireAdmin(request("/admin/metrics","GET",{Authorization:`Bearer ${secret}`})))?.status).toBe(401);
  });
});

describe("administrator access tokens", () => {
  function setup() {
    let now=1_800_000_000_000;
    const store=new MemoryAuthStore();
    store.sessions.set(tokenHash(TEST_SESSION_TOKEN),{user:TEST_ADMIN,csrfToken:"test-csrf",expiresAt:now+40*86400000});
    const auth=new AuthService(TEST_AUTH_CONFIG,store,fakeProvider,()=>now);
    const call=(path:string,method="GET",headers:Record<string,string>={...testAdminHeaders},body?:unknown)=>
      handleRequest(request(path,method,headers,body===undefined?undefined:JSON.stringify(body)),{getChainId:async()=>1337n} as ScannerStorage,{auth});
    const create=()=>call("/auth/access-tokens","POST",{...testAdminHeaders},{name:"Automation",validityDays:30});
    return {store,auth,call,create,advance:(ms:number)=>{now+=ms;}};
  }
  test("creates once-only secrets, authorizes all admin APIs, lists metadata and revokes",async()=>{
    const h=setup(); const response=await h.create(); expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const t=await response.json() as {id:string;token:string;createdAt:number;expiresAt:number};
    expect(t.expiresAt-t.createdAt).toBe(30*86400000);
    expect(h.store.accessTokens.has(tokenHash(t.token))).toBe(true);
    expect(JSON.stringify([...h.store.accessTokens.values()])).not.toContain(t.token);
    const headers={Authorization:`Bearer ${t.token}`};
    expect((await h.call("/admin/metrics","GET",headers)).status).toBe(200);
    expect((await h.call("/metrics","GET",headers)).status).toBe(200);
    expect((await h.call("/shadow-rpc","POST",headers,{jsonrpc:"2.0",id:1,method:"eth_chainId"})).status).toBe(200);
    expect((await h.call("/baseload","PUT",headers,{})).status).toBe(503); // authorized, runtime absent
    expect(await h.auth.requireAccessToken(request("/baseload/configs","GET",headers))).toBeNull();
    expect((await h.call("/auth/access-tokens","GET",headers)).status).toBe(401);
    expect((await h.call("/auth/access-tokens","POST",headers,{name:"extend",validityDays:30})).status).toBe(401);
    expect((await h.call(`/auth/access-tokens/${t.id}`,"DELETE",headers)).status).toBe(401);
    const list=await h.call("/auth/access-tokens"); expect(await list.text()).not.toContain(t.token);
    expect((await h.call("/admin/metrics","GET",{...headers,...testAdminHeaders})).status).toBe(400);
    expect((await h.call(`/auth/access-tokens/${t.id}`,"DELETE")).status).toBe(204);
    expect((await h.call("/admin/metrics","GET",headers)).status).toBe(401);
  });
  test("enforces expiry and current owner privileges",async()=>{
    const h=setup(); const {token}=await (await h.create()).json() as {token:string}; const headers={Authorization:`Bearer ${token}`};
    h.store.users.set(TEST_ADMIN.sub,{...TEST_ADMIN,email:"ordinary@golem.network"});
    expect((await h.call("/admin/metrics","GET",headers)).status).toBe(403);
    h.store.users.set(TEST_ADMIN.sub,{...TEST_ADMIN,disabled:true});
    expect((await h.call("/admin/metrics","GET",headers)).status).toBe(401);
    h.store.users.clear(); h.advance(30*86400000);
    expect((await h.call("/admin/metrics","GET",headers)).status).toBe(401);
  });
  test("token-login credentials invalidate on rotation and lookup failures fail closed",async()=>{
    const h=setup();
    h.store.sessions.set(tokenHash(TEST_SESSION_TOKEN),{user:{...TEST_ADMIN,provider:"token",emailVerified:false,hostedDomain:null},csrfToken:"test-csrf",expiresAt:1_900_000_000_000,tokenLoginKeyHash:tokenHash("login-secret")});
    const config={...TEST_AUTH_CONFIG,tokenLoginToken:"login-secret"};
    const auth=new AuthService(config,h.store,fakeProvider,()=>1_800_000_000_000);
    const created=await auth.handle(request("/auth/access-tokens","POST",testAdminHeaders,JSON.stringify({name:"Test",validityDays:1})));
    expect(created.status).toBe(201);
    const {token}=await created.json() as {token:string};
    const req=request("/admin/metrics","GET",{Authorization:`Bearer ${token}`});
    expect(await auth.requireAccessToken(req)).toBeNull();
    const rotated=new AuthService({...config,tokenLoginToken:"rotated"},h.store,fakeProvider,()=>1_800_000_000_000);
    expect((await rotated.requireAccessToken(req))?.status).toBe(401);
    expect((await h.auth.requireAccessToken(req))?.status).toBe(401);
    h.store.getAccessToken=async()=>{throw new Error("database unavailable");};
    expect((await auth.requireAccessToken(req))?.status).toBe(503);
  });
  test("management requires admin session and CSRF; rejects invalid lifetimes and oversized bodies",async()=>{
    const h=setup();
    for(const validityDays of [0,-1,31,1.5,"30",null]) expect((await h.call("/auth/access-tokens","POST",{...testAdminHeaders},{name:"test",validityDays})).status).toBe(400);
    expect((await h.call("/auth/access-tokens","POST",{},{})).status).toBe(401);
    expect((await h.call("/auth/access-tokens","POST",{Cookie:testAdminHeaders.Cookie},{name:"test",validityDays:1})).status).toBe(403);
    expect((await h.call("/auth/access-tokens","POST",{...testAdminHeaders},{name:"x".repeat(5000),validityDays:1})).status).toBe(413);
    h.store.users.set(TEST_ADMIN.sub,{...TEST_ADMIN,email:"ordinary@golem.network"});
    expect((await h.create()).status).toBe(403);
  });
});
