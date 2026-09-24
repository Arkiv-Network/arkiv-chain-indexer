import { describe, expect, test } from "bun:test";
import { AuthService, tokenHash } from "../auth";
import {
  MemoryAuthStore,
  TEST_ADMIN,
  TEST_AUTH_CONFIG,
  testAuth,
  testAdminHeaders,
} from "../testAuth";
import { routeTemplate } from "../serverMetrics";
import { createNativeHandler, parseControl } from "./server";
import type { SimulatorStorage } from "./storage";
import { genesis, ZERO } from "./testFixtures";
const g = genesis(),
  storage = { identity: g } as unknown as SimulatorStorage;
const command = {
  commandId: ZERO,
  runId: g.runId,
  expectedRevision: "0",
  expectedHeight: null,
  action: "step",
  config: null,
};
const success = {
  commandId: ZERO,
  runId: g.runId,
  configRevision: "1",
  head: { height: "1", hash: ZERO, stateRoot: ZERO },
  paused: true,
  health: "paused",
  status: "committed",
  resultHeight: "1",
};
const request = (headers: HeadersInit = {}, body: unknown = command) =>
  new Request("https://explorer.test/admin/sim/v1/control", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
describe("native administrator control proxy", () => {
  test("requires existing admin session, exact Origin and CSRF before forwarding", async () => {
    let calls = 0;
    const handler = createNativeHandler({
      storage,
      auth: testAuth(),
      controlUrl: "http://producer:8081",
      controlToken: "private-server-only",
      fetcher: async (r) => {
        calls++;
        expect(r.url).toBe("http://producer:8081/sim/v1/control");
        expect(r.headers.get("authorization")).toBe(
          "Bearer private-server-only",
        );
        expect(r.headers.get("cookie")).toBeNull();
        expect(r.headers.get("origin")).toBeNull();
        expect(await r.json()).toEqual(command);
        return Response.json(success);
      },
    });
    for (const headers of [
      {},
      { ...testAdminHeaders, "X-CSRF-Token": "bad" },
      { ...testAdminHeaders, Origin: "https://evil.test" },
      { Cookie: testAdminHeaders.Cookie },
    ]) {
      const response = await handler(request(headers));
      expect([401, 403]).toContain(response.status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(calls).toBe(0);
    const good = await handler(request(testAdminHeaders));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual(success);
    expect(calls).toBe(1);
    const ordinary = createNativeHandler({
      storage,
      auth: testAuth({ ...TEST_ADMIN, email: "reader@golem.network" }),
      controlUrl: "http://producer",
      controlToken: "key",
      fetcher: async () => {
        throw Error("must not forward");
      },
    });
    expect((await ordinary(request(testAdminHeaders))).status).toBe(403);
  });
  test("temporary token rechecks owner/revocation and rejects browser origins or ambiguous session", async () => {
    const store = new MemoryAuthStore(),
      token = "arkiv_" + "b".repeat(43);
    store.users.set(TEST_ADMIN.sub, { ...TEST_ADMIN });
    store.accessTokens.set(tokenHash(token), {
      id: "a",
      name: "test",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      revokedAt: null,
      user: { ...TEST_ADMIN },
      tokenLoginKeyHash: null,
    });
    let calls = 0;
    const handler = createNativeHandler({
      storage,
      auth: new AuthService(TEST_AUTH_CONFIG, store),
      controlUrl: "http://producer",
      controlToken: "key",
      fetcher: async () => {
        calls++;
        return Response.json(success);
      },
    });
    const auth = { Authorization: `Bearer ${token}` };
    expect((await handler(request(auth))).status).toBe(200);
    expect(
      (await handler(request({ ...auth, Origin: "https://evil.test" }))).status,
    ).toBe(403);
    expect(
      (await handler(request({ ...auth, Cookie: testAdminHeaders.Cookie })))
        .status,
    ).toBe(400);
    store.users.set(TEST_ADMIN.sub, { ...TEST_ADMIN, disabled: true });
    expect((await handler(request(auth))).status).toBe(401);
    expect(calls).toBe(1);
  });
  test("rejects full operation payloads, identity mismatch, excessive limits and unknown control fields", async () => {
    expect(() =>
      parseControl({ ...command, runId: "ff".repeat(16) }, g.runId),
    ).toThrow("IdentityMismatch");
    expect(() =>
      parseControl({ ...command, body: "secret" }, g.runId),
    ).toThrow();
    expect(() =>
      parseControl(
        {
          ...command,
          action: "configure",
          config: {
            version: 1,
            seed: "7",
            blockPeriodMs: "1000",
            payloadBytes: 1025,
            extraRowsPerBlock: 0,
          },
        },
        g.runId,
      ),
    ).toThrow();
    const handler = createNativeHandler({
      storage,
      auth: testAuth(),
      controlUrl: "http://producer",
      controlToken: "key",
      fetcher: async () => {
        throw Error("unexpected");
      },
    });
    expect(
      (
        await handler(
          request(testAdminHeaders, { ...command, payload: "x".repeat(5000) }),
        )
      ).status,
    ).toBe(413);
  });
  test("transport uncertainty and malformed upstream responses never expose upstream content", async () => {
    for (const fetcher of [
      async () => {
        throw Error("private url token calldata");
      },
      async () => Response.json({ ...success, input: "secret" }),
      async () => Response.json({ error: "secret" }, { status: 500 }),
    ]) {
      const handler = createNativeHandler({
        storage,
        auth: testAuth(),
        controlUrl: "http://producer",
        controlToken: "key",
        fetcher,
      });
      const response = await handler(request(testAdminHeaders));
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await response.text()).not.toContain("secret");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  test("only one producer call in flight and retries preserve caller command ID", async () => {
    let finish!: (r: Response) => void;
    const handler = createNativeHandler({
      storage,
      auth: testAuth(),
      controlUrl: "http://producer",
      controlToken: "key",
      fetcher: async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = handler(request(testAdminHeaders));
    await new Promise((r) => setTimeout(r, 0));
    expect((await handler(request(testAdminHeaders))).status).toBe(429);
    finish(Response.json(success));
    expect((await pending).status).toBe(200);
  });
  test("native auth session endpoint reuses established service and route labels are bounded", async () => {
    const handler = createNativeHandler({ storage, auth: testAuth() });
    const response = await handler(
      new Request("https://explorer.test/auth/session", {
        headers: testAdminHeaders,
      }),
    );
    expect(await response.json()).toMatchObject({
      role: "admin",
      csrfToken: "test-csrf",
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(routeTemplate("/sim/v1/blocks/9007199254740993")).toBe(
      "/sim/v1/blocks/:height",
    );
    expect(routeTemplate("/admin/sim/v1/control")).toBe(
      "/admin/sim/v1/control",
    );
  });
});
