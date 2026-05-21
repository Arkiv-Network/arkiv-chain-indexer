import { afterEach, describe, expect, test } from "bun:test";
import {
  deleteBaseloadConfig,
  fetchBaseloadConfigs,
  fetchBaseloadState,
  fetchSenders,
  loadBaseloadConfig,
  saveBaseloadConfig,
  updateBaseloadConfig,
} from "./src/api";
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

  test("attaches admin bearer tokens to saved config management requests", async () => {
    const observed: Array<{ input: string; method: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observed.push({
        input: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      if (String(input).endsWith("/baseload/configs")) {
        return Response.json({ configs: [] });
      }
      if (String(input).endsWith("/load")) {
        return Response.json({
          enabled: true,
          config: EMPTY_BASELOAD_CONFIG,
          statuses: {},
          balances: {},
        });
      }
      return Response.json({
        name: "low gas",
        workerCount: 0,
        config: EMPTY_BASELOAD_CONFIG,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        deleted: true,
      });
    }) as typeof fetch;

    await fetchBaseloadConfigs("secret");
    await saveBaseloadConfig("low gas", EMPTY_BASELOAD_CONFIG, "secret");
    await loadBaseloadConfig("low gas", "secret");
    await deleteBaseloadConfig("low gas", "secret");

    expect(observed).toEqual([
      { input: "/api/baseload/configs", method: "GET", authorization: "Bearer secret" },
      { input: "/api/baseload/configs/low%20gas", method: "PUT", authorization: "Bearer secret" },
      { input: "/api/baseload/configs/low%20gas/load", method: "PUT", authorization: "Bearer secret" },
      { input: "/api/baseload/configs/low%20gas", method: "DELETE", authorization: "Bearer secret" },
    ]);
  });

  test("fetches sender stats with query parameters", async () => {
    let observedInput = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      observedInput = String(input);
      return Response.json({
        count: 0,
        limit: 25,
        truncated: false,
        filters: { order: "desc" },
        senders: [],
      });
    }) as typeof fetch;

    await fetchSenders(new URLSearchParams("limit=25&order=desc"));

    expect(observedInput).toBe("/api/senders?limit=25&order=desc");
  });
});
