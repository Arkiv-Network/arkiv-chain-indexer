import { describe, expect, test } from "bun:test";
import { keccak256Hex } from "./src/keccak";
import { bytesAsText, BytesNotFoundError, loadBytesFromNode } from "./src/nodeBytes";
import { callNodeRelay, describeRentCap, fetchNodeRentCap, NODE_RELAY_PATH, NodeRpcError, parseNodeRentCap, readNodeStatusUrl } from "./src/nodeRpc";

const KEY = `0x${"ab".repeat(32)}`;

describe("node configuration", () => {
  test("the status URL is configured explicitly, absolute http(s) or same-origin, or off", () => {
    expect(readNodeStatusUrl({})).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_STATUS_URL: "" })).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_STATUS_URL: "off" })).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_STATUS_URL: " /node/signed/v1/status " })).toBe("/node/signed/v1/status");
    expect(readNodeStatusUrl({ VITE_NODE_STATUS_URL: "https://alt-node-fast.arkiv-global.net/signed/v1/status" })).toBe(
      "https://alt-node-fast.arkiv-global.net/signed/v1/status",
    );
    expect(readNodeStatusUrl({ VITE_NODE_STATUS_URL: "ws://node" })).toBeNull();
    expect(readNodeStatusUrl({ VITE_NODE_STATUS_URL: "node:8545" })).toBeNull();
  });
});

describe("the node relay", () => {
  test("posts JSON-RPC to the backend's entity-explorer relay without cookies", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { currentBlock: "0x10" } });
    }) as unknown as typeof fetch;
    expect(await callNodeRelay<{ currentBlock: string }>("arkiv_getBlockTiming", [], { fetchImpl })).toEqual({ currentBlock: "0x10" });
    expect(NODE_RELAY_PATH).toBe("/api/entity-explorer/rpc");
    expect(calls[0]!.url).toBe(NODE_RELAY_PATH);
    expect(calls[0]!.init?.credentials).toBe("omit");
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ jsonrpc: "2.0", method: "arkiv_getBlockTiming", params: [] });
  });

  test("relays the node's error, and says when the relay is unreachable or not JSON-RPC", async () => {
    const answering = (response: Response) => (async () => response) as unknown as typeof fetch;
    const limited = answering(Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } }, { status: 200 }));
    await expect(callNodeRelay("arkiv_query", [], { fetchImpl: limited })).rejects.toMatchObject({ name: "NodeRpcError", code: -32005, message: "rate limited" });
    const html = answering(new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } }));
    await expect(callNodeRelay("arkiv_query", [], { fetchImpl: html })).rejects.toThrow("HTTP 404 without JSON-RPC");
    const down = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    await expect(callNodeRelay("arkiv_query", [], { fetchImpl: down })).rejects.toBeInstanceOf(NodeRpcError);
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
    expect(await fetchNodeRentCap(failing, "/node/signed/v1/status")).toBeNull();
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

  test("reads one attribute at a block from the node through the relay, without credentials, and checks its hash", async () => {
    const content = "0x68656c6c6f";
    const { fetchImpl, calls } = nodeAnswering({ data: [{ key: KEY, attributes: [{ name: "body", type: "bytes", value: content }] }], blockNumber: "0x30" });
    const loaded = await loadBytesFromNode(
      { entityKey: KEY, name: "body", atBlock: 48, expectedKeccak256: keccak256Hex("hello") },
      { fetchImpl },
    );
    expect(loaded).toEqual({ content, size: 5, keccak256: keccak256Hex("hello"), blockNumber: 48, matches: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/entity-explorer/rpc");
    expect(calls[0]!.credentials).toBe("omit");
    expect(calls[0]!.body.method).toBe("arkiv_query");
    expect(calls[0]!.body.params).toEqual([`$key = key(${KEY})`, { select: { key: true, attributes: { body: true } }, limit: "0x1", atBlock: "0x30" }]);
  });

  test("a different value at that block is reported, not hidden", async () => {
    const { fetchImpl } = nodeAnswering({ data: [{ key: KEY, attributes: [{ name: "body", type: "bytes", value: "0x00" }] }], blockNumber: "0x31" });
    const loaded = await loadBytesFromNode({ entityKey: KEY, name: "body", expectedKeccak256: "0x1234" }, { fetchImpl });
    expect(loaded.matches).toBe(false);
  });

  test("a missing entity or attribute, or a retyped one, is an error", async () => {
    await expect(loadBytesFromNode({ entityKey: KEY, name: "body" }, { fetchImpl: nodeAnswering({ data: [], blockNumber: "0x1" }).fetchImpl })).rejects.toBeInstanceOf(BytesNotFoundError);
    await expect(
      loadBytesFromNode({ entityKey: KEY, name: "body" }, { fetchImpl: nodeAnswering({ data: [{ key: KEY, attributes: [] }], blockNumber: "0x1" }).fetchImpl }),
    ).rejects.toThrow(/no attribute body/);
    await expect(
      loadBytesFromNode({ entityKey: KEY, name: "body" }, { fetchImpl: nodeAnswering({ data: [{ key: KEY, attributes: [{ name: "body", type: "str", value: "x" }] }], blockNumber: "0x1" }).fetchImpl }),
    ).rejects.toThrow(/str there, not bytes/);
  });

  test("printable UTF-8 can be shown as text; binary cannot", () => {
    expect(bytesAsText("0x7a61c5bcc3b3c582c4872074657874")).toBe("zażółć text");
    expect(bytesAsText("0x000102")).toBeNull();
    expect(bytesAsText("0xff")).toBeNull();
  });
});

describe("bytes shown as text", () => {
  test("cannot spoof with bidi or C1 controls", () => {
    // "abc" RLO "exe.txt" → shown with the override escaped
    expect(bytesAsText("0x616263e280ae6578652e747874")).toBe("abc\\u{202E}exe.txt");
    // C2 85 is U+0085 (NEL, a C1 control)
    expect(bytesAsText("0x61c28562")).toBe("a\\u{0085}b");
  });
});
