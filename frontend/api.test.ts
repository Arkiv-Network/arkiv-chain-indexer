import { afterEach, describe, expect, test } from "bun:test";
import { fetchBaseloadState, updateBaseloadConfig } from "./src/api";
import { EMPTY_BASELOAD_CONFIG } from "./src/baseloadConfig";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("frontend API helpers", () => {
  test("does not attach admin bearer tokens to readonly baseload requests", async () => {
    let observedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({
        enabled: true,
        config: EMPTY_BASELOAD_CONFIG,
        statuses: {},
        balances: {},
      });
    }) as typeof fetch;

    await fetchBaseloadState();

    expect(observedHeaders?.get("authorization")).toBeNull();
  });

  test("attaches admin bearer tokens to baseload updates", async () => {
    let observedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({
        enabled: true,
        config: EMPTY_BASELOAD_CONFIG,
        statuses: {},
        balances: {},
      });
    }) as typeof fetch;

    await updateBaseloadConfig(EMPTY_BASELOAD_CONFIG, "secret");

    expect(observedHeaders?.get("authorization")).toBe("Bearer secret");
    expect(observedHeaders?.get("content-type")).toBe("application/json");
  });
});
