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

describe("EthereumRpcClient getBalances", () => {
  const ADDRESS_A = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
  const ADDRESS_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  function mockBatch(reply: (calls: Array<{ id: number; method: string; params: unknown[] }>) => unknown) {
    const requestBodies: string[] = [];
    globalThis.fetch = (async (_input: FetchInput, init: FetchInit) => {
      requestBodies.push(String(init?.body));
      const calls = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(reply(calls)), { status: 200 });
    }) as typeof fetch;
    return requestBodies;
  }

  test("asks for every address at the block in one request", async () => {
    const bodies = mockBatch((calls) =>
      calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: "0x2a" })),
    );
    const rpc = new EthereumRpcClient("https://example.test");
    const snapshot = rpc.getStatsSnapshot();

    const balances = await rpc.getBalances([ADDRESS_A, ADDRESS_B], 1234n);
    expect(balances).toEqual(
      new Map([
        [ADDRESS_A.toLowerCase(), 42n],
        [ADDRESS_B, 42n],
      ]),
    );

    // One HTTP request, not one per address: the scanner's request count is
    // what its share of the RPC key's quota is spent on.
    expect(bodies).toHaveLength(1);
    const calls = JSON.parse(bodies[0]!) as Array<{ method: string; params: unknown[] }>;
    expect(calls.map((call) => call.method)).toEqual(["eth_getBalance", "eth_getBalance"]);
    expect(calls.map((call) => call.params)).toEqual([
      [ADDRESS_A.toLowerCase(), "0x4d2"],
      [ADDRESS_B, "0x4d2"],
    ]);
    // Stats still count the individual calls, not the single round trip.
    expect(rpc.getStatsSince(snapshot).calls).toBe(2);
  });

  test("deduplicates addresses and lowercases them", async () => {
    const bodies = mockBatch((calls) =>
      calls.map((call) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" })),
    );
    const rpc = new EthereumRpcClient("https://example.test");
    await rpc.getBalances([ADDRESS_A, ADDRESS_A.toLowerCase(), ADDRESS_A.toUpperCase()], 1n);
    const calls = JSON.parse(bodies[0]!) as unknown[];
    expect(calls).toHaveLength(1);
  });

  test("no addresses means no request at all", async () => {
    const bodies = mockBatch(() => []);
    const rpc = new EthereumRpcClient("https://example.test");
    expect(await rpc.getBalances([], 1n)).toEqual(new Map());
    expect(bodies).toHaveLength(0);
  });

  test("matches results by id, because a node may answer a batch in any order", async () => {
    mockBatch((calls) =>
      calls
        .map((call, index) => ({ jsonrpc: "2.0", id: call.id, result: index === 0 ? "0x1" : "0x2" }))
        .reverse(),
    );
    const rpc = new EthereumRpcClient("https://example.test");
    expect(await rpc.getBalances([ADDRESS_A, ADDRESS_B], 1n)).toEqual(
      new Map([
        [ADDRESS_A.toLowerCase(), 1n],
        [ADDRESS_B, 2n],
      ]),
    );
  });

  test("one failed call fails the whole batch, so the block is retried whole", async () => {
    mockBatch((calls) =>
      calls.map((call, index) =>
        index === 1
          ? { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "state not available" } }
          : { jsonrpc: "2.0", id: call.id, result: "0x1" },
      ),
    );
    const rpc = new EthereumRpcClient("https://example.test");
    await expect(rpc.getBalances([ADDRESS_A, ADDRESS_B], 1n)).rejects.toThrow(
      "eth_getBalance failed: -32000 state not available",
    );
  });

  test("a missing entry is an error, never a silent zero", async () => {
    mockBatch((calls) => calls.slice(0, 1).map((call) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" })));
    const rpc = new EthereumRpcClient("https://example.test");
    await expect(rpc.getBalances([ADDRESS_A, ADDRESS_B], 1n)).rejects.toThrow(
      "was missing from the batch response",
    );
  });
});
