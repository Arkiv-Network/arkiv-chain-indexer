import { afterEach, describe, expect, test } from "bun:test";
import { EthereumRpcClient } from "./rpc";

const originalFetch = globalThis.fetch;
const textEncoder = new TextEncoder();
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("EthereumRpcClient RPC stats", () => {
  test("counts calls and request/response payload bytes", async () => {
    const responseText = '{"jsonrpc":"2.0","id":1,"result":"0x2a"}';
    const requestBodies: string[] = [];
    const mockFetch = async (_input: FetchInput, init: FetchInit) => {
      requestBodies.push(String(init?.body));
      return new Response(responseText, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = mockFetch as typeof fetch;

    const rpc = new EthereumRpcClient("https://example.test");
    const snapshot = rpc.getStatsSnapshot();

    await expect(rpc.getLatestBlockNumber()).resolves.toBe(42n);

    const expectedRequestBody = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';
    expect(requestBodies).toEqual([expectedRequestBody]);
    expect(rpc.getStatsSince(snapshot)).toEqual({
      calls: 1,
      requestBytes: textEncoder.encode(expectedRequestBody).byteLength,
      responseBytes: textEncoder.encode(responseText).byteLength,
    });
  });

  test("counts failed HTTP responses", async () => {
    const responseText = "upstream unavailable";
    const mockFetch = async (_input: FetchInput, _init: FetchInit) =>
      new Response(responseText, {
        status: 503,
      });
    globalThis.fetch = mockFetch as typeof fetch;

    const rpc = new EthereumRpcClient("https://example.test");
    const snapshot = rpc.getStatsSnapshot();

    await expect(rpc.getLatestBlockNumber()).rejects.toThrow("RPC eth_blockNumber failed with HTTP 503");

    const stats = rpc.getStatsSince(snapshot);
    expect(stats.calls).toBe(1);
    expect(stats.requestBytes).toBeGreaterThan(0);
    expect(stats.responseBytes).toBe(textEncoder.encode(responseText).byteLength);
  });
});
