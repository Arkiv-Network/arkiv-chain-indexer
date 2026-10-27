import { describe, expect, test } from "bun:test";
import { keccak256Hex } from "./src/keccak";
import { bytesAsText, BytesNotFoundError, loadBytesFromNode } from "./src/nodeBytes";
import { describeNodeUrl, describeRentCap, fetchNodeRentCap, parseNodeRentCap, readNodeRpcUrl, readNodeStatusUrl } from "./src/nodeRpc";

const KEY = `0x${"ab".repeat(32)}`;

describe("node configuration", () => {
  test("the RPC URL is absolute http(s), same-origin, or off", () => {
    expect(readNodeRpcUrl({})).toBeNull();
    expect(readNodeRpcUrl({ VITE_NODE_RPC_URL: "" })).toBeNull();
    expect(readNodeRpcUrl({ VITE_NODE_RPC_URL: "off" })).toBeNull();
    expect(readNodeRpcUrl({ VITE_NODE_RPC_URL: " /node-rpc " })).toBe("/node-rpc");
    expect(readNodeRpcUrl({ VITE_NODE_RPC_URL: "https://alt-node-fast.arkiv-global.net/rpc" })).toBe("https://alt-node-fast.arkiv-global.net/rpc");
    expect(readNodeRpcUrl({ VITE_NODE_RPC_URL: "ws://node" })).toBeNull();
    expect(readNodeRpcUrl({ VITE_NODE_RPC_URL: "node:8545" })).toBeNull();
  });

  test("the status URL is derived for the /node-rpc passthrough only, else configured or off", () => {
    expect(readNodeStatusUrl({})).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_RPC_URL: "/node-rpc" })).toBe("/node-rpc/signed/v1/status");
    expect(readNodeStatusUrl({ VITE_NODE_RPC_URL: "/node-rpc/" })).toBe("/node-rpc/signed/v1/status");
    // nginx's `location = /rpc` would answer /rpc/signed/v1/status with the SPA: never guessed.
    expect(readNodeStatusUrl({ VITE_NODE_RPC_URL: "https://alt-node-fast.arkiv-global.net/rpc" })).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_RPC_URL: "http://127.0.0.1:28545/" })).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_RPC_URL: "/rpc" })).toBeNull();
    expect(
      readNodeStatusUrl({ VITE_NODE_RPC_URL: "https://alt-node-fast.arkiv-global.net/rpc", VITE_NODE_STATUS_URL: "https://alt-node-fast.arkiv-global.net/signed/v1/status" }),
    ).toBe("https://alt-node-fast.arkiv-global.net/signed/v1/status");
    expect(readNodeStatusUrl({ VITE_NODE_RPC_URL: "/node-rpc", VITE_NODE_STATUS_URL: "off" })).toBeNull();
  });

  test("a credential in the URL is never shown", () => {
    expect(describeNodeUrl("https://user:secret@node.example.test/rpc")).toBe("https://node.example.test/rpc");
    expect(describeNodeUrl(null)).toBe("not configured");
  });
});

describe("rent cap", () => {
  const status = { capabilities: { gas: { maxRentLifetimeSeconds: "31536000", maxRentLifetimeBlocks: "15768000", rentBlockPeriodMs: "2000", rentWeiPerStorageUnitDay: "20000000000" } } };

  test("is read from /signed/v1/status and described in words", () => {
    const cap = parseNodeRentCap(status);
    expect(cap).toEqual({ maxRentLifetimeSeconds: "31536000", maxRentLifetimeBlocks: "15768000", rentBlockPeriodMs: "2000", rentWeiPerStorageUnitDay: "20000000000" });
    expect(describeRentCap(cap)).toBe("1 year (15,768,000 blocks)");
    expect(describeRentCap({ ...cap!, maxRentLifetimeSeconds: "172800", maxRentLifetimeBlocks: null })).toBe("2 days");
    expect(describeRentCap(null)).toBe("the node's rent cap");
    expect(parseNodeRentCap({ capabilities: {} })).toBeNull();
    expect(parseNodeRentCap("<html>")).toBeNull();
  });

  test("an unreachable or non-JSON status degrades to null", async () => {
    const failing = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect(await fetchNodeRentCap(failing, "/node-rpc/signed/v1/status")).toBeNull();
    const html = (async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await fetchNodeRentCap(html, "/x")).toBeNull();
    // A JSON body served as HTML (an SPA fallback) is not trusted either.
    const mislabelled = (async () => new Response(JSON.stringify(status), { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await fetchNodeRentCap(mislabelled, "/x")).toBeNull();
    const ok = (async () => Response.json(status)) as unknown as typeof fetch;
    expect((await fetchNodeRentCap(ok, "/x"))?.maxRentLifetimeBlocks).toBe("15768000");
    expect(await fetchNodeRentCap(ok, null)).toBeNull();
  });
});

describe("loading bytes from the node", () => {
  function nodeAnswering(result: unknown) {
    const calls: Array<{ url: string; credentials: RequestCredentials | undefined; body: { method: string; params: unknown[] } }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), credentials: init?.credentials, body: JSON.parse(String(init?.body)) });
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test("reads one attribute at a block from the node, without credentials, and checks its hash", async () => {
    const content = "0x68656c6c6f";
    const { fetchImpl, calls } = nodeAnswering({ data: [{ key: KEY, attributes: [{ name: "body", type: "bytes", value: content }] }], blockNumber: "0x30" });
    const loaded = await loadBytesFromNode(
      { entityKey: KEY, name: "body", atBlock: 48, expectedKeccak256: keccak256Hex("hello") },
      { kind: "custom", customUrl: "http://127.0.0.1:28545" },
      { fetchImpl },
    );
    expect(loaded).toEqual({ content, size: 5, keccak256: keccak256Hex("hello"), blockNumber: 48, matches: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:28545");
    expect(calls[0]!.credentials).toBe("omit");
    expect(calls[0]!.body.method).toBe("arkiv_query");
    expect(calls[0]!.body.params).toEqual([`$key = key(${KEY})`, { select: { key: true, attributes: { body: true } }, limit: "0x1", atBlock: "0x30" }]);
  });

  test("a different value at that block is reported, not hidden", async () => {
    const { fetchImpl } = nodeAnswering({ data: [{ key: KEY, attributes: [{ name: "body", type: "bytes", value: "0x00" }] }], blockNumber: "0x31" });
    const loaded = await loadBytesFromNode({ entityKey: KEY, name: "body", expectedKeccak256: "0x1234" }, { kind: "custom", customUrl: "http://n" }, { fetchImpl });
    expect(loaded.matches).toBe(false);
  });

  test("a missing entity or attribute, or a retyped one, is an error", async () => {
    const source = { kind: "custom" as const, customUrl: "http://n" };
    await expect(loadBytesFromNode({ entityKey: KEY, name: "body" }, source, { fetchImpl: nodeAnswering({ data: [], blockNumber: "0x1" }).fetchImpl })).rejects.toBeInstanceOf(BytesNotFoundError);
    await expect(
      loadBytesFromNode({ entityKey: KEY, name: "body" }, source, { fetchImpl: nodeAnswering({ data: [{ key: KEY, attributes: [] }], blockNumber: "0x1" }).fetchImpl }),
    ).rejects.toThrow(/no attribute body/);
    await expect(
      loadBytesFromNode({ entityKey: KEY, name: "body" }, source, { fetchImpl: nodeAnswering({ data: [{ key: KEY, attributes: [{ name: "body", type: "str", value: "x" }] }], blockNumber: "0x1" }).fetchImpl }),
    ).rejects.toThrow(/str there, not bytes/);
  });

  test("printable UTF-8 can be shown as text; binary cannot", () => {
    expect(bytesAsText("0x7a61c5bcc3b3c582c4872074657874")).toBe("zażółć text");
    expect(bytesAsText("0x000102")).toBeNull();
    expect(bytesAsText("0xff")).toBeNull();
  });
});
