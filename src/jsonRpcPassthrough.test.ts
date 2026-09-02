import { describe, expect, test } from "bun:test";
import { JSON_RPC_SERVER_ERROR, JsonRpcError } from "./jsonRpc";
import {
  DEFAULT_PASSTHROUGH_METHODS,
  JSON_RPC_LIMIT_EXCEEDED,
  JsonRpcPassthrough,
} from "./jsonRpcPassthrough";

/** A URL shaped like the ones that carry a key in the path — nothing may echo it. */
const UPSTREAM = "https://node.example.test/rpc/SUPER_SECRET_KEY";
const RAW_TX = "0x02f8710182...";

interface RecordedCall {
  url: string;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
  headers: Record<string, string>;
}

function recordingFetch(reply: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: unknown, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url: String(input),
      body: JSON.parse(String(init.body)) as RecordedCall["body"],
      headers,
    };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Collects the operator-facing warnings so tests can assert what was logged. */
function warnings() {
  const logged: Array<{ message: string; detail: unknown }> = [];
  return { logged, onWarning: (message: string, detail: unknown) => logged.push({ message, detail }) };
}

async function forwardError(passthrough: JsonRpcPassthrough, method: string, params: unknown[] = []) {
  try {
    await passthrough.forward(method, params);
  } catch (error) {
    if (error instanceof JsonRpcError) return error;
    throw error;
  }
  throw new Error(`${method} unexpectedly succeeded`);
}

describe("JsonRpcPassthrough", () => {
  test("claims the submission methods by default", () => {
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM });
    expect([...passthrough.methods]).toEqual([...DEFAULT_PASSTHROUGH_METHODS]);
    // Only the raw form: signing happens in the wallet, so a public endpoint
    // never needs the node to hold keys. The Arkiv entity reads ride along
    // because the index has no entity state to answer them from.
    expect([...DEFAULT_PASSTHROUGH_METHODS]).toEqual([
      "eth_sendRawTransaction",
      "arkiv_query",
      "arkiv_getEntity",
      "arkiv_getEntityCount",
      "arkiv_getBlockTiming",
    ]);
    expect(passthrough.methods.has("eth_sendTransaction")).toBe(false);
  });

  test("forwards the call as a well-formed request and returns the node's result", async () => {
    const { impl, calls } = recordingFetch((call) =>
      jsonResponse({ jsonrpc: "2.0", id: call.body.id, result: `0x${"ab".repeat(32)}` }),
    );
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM, fetchImpl: impl });

    expect(await passthrough.forward("eth_sendRawTransaction", [RAW_TX])).toBe(`0x${"ab".repeat(32)}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(UPSTREAM);
    expect(calls[0]!.body.jsonrpc).toBe("2.0");
    expect(calls[0]!.body.method).toBe("eth_sendRawTransaction");
    expect(calls[0]!.body.params).toEqual([RAW_TX]);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
  });

  test("sends a configured key as x-api-key", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM, apiKey: "hub-key", fetchImpl: impl });
    await passthrough.forward("eth_sendRawTransaction", [RAW_TX]);
    expect(calls[0]!.headers["x-api-key"]).toBe("hub-key");
  });

  test("relays the node's rejection verbatim — it is the useful part of a failed send", async () => {
    const { impl } = recordingFetch(() =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "nonce too low", data: { expected: 7 } },
      }),
    );
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM, fetchImpl: impl });
    const error = await forwardError(passthrough, "eth_sendRawTransaction", [RAW_TX]);
    expect(error.code).toBe(-32000);
    expect(error.message).toBe("nonce too low");
    expect(error.toBody().data).toEqual({ expected: 7 });
  });

  test("a transport failure tells the caller nothing about the upstream", async () => {
    const { logged, onWarning } = warnings();
    const impl = (async () => {
      throw new Error(`connect ECONNREFUSED ${UPSTREAM}`);
    }) as unknown as typeof fetch;
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM, fetchImpl: impl, onWarning });

    const error = await forwardError(passthrough, "eth_sendRawTransaction", [RAW_TX]);
    expect(error.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(error.message).toBe("eth_sendRawTransaction could not be forwarded to the upstream node");
    expect(error.message).not.toContain("SUPER_SECRET_KEY");
    expect(error.message).not.toContain("node.example.test");
    // The operator still gets the cause, just not over the wire.
    expect(logged).toHaveLength(1);
    expect(String((logged[0]!.detail as Error).message)).toContain("ECONNREFUSED");
  });

  test("an upstream HTTP failure is reported by status, never by body", async () => {
    const { logged, onWarning } = warnings();
    const { impl } = recordingFetch(() => new Response("quota exhausted for key SUPER_SECRET_KEY", { status: 429 }));
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM, fetchImpl: impl, onWarning });

    const error = await forwardError(passthrough, "eth_sendRawTransaction", [RAW_TX]);
    expect(error.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(error.message).toBe(
      "eth_sendRawTransaction was rejected by the upstream node (HTTP 429)",
    );
    expect(error.message).not.toContain("SUPER_SECRET_KEY");
    expect(logged[0]!.detail).toContain("quota exhausted");
  });

  test("a malformed upstream reply is a server error, not a crash", async () => {
    const { onWarning } = warnings();
    const cases: Array<[string, Response]> = [
      ["not json", new Response("<html>gateway</html>")],
      ["not an object", jsonResponse([1, 2, 3])],
      ["no result member", jsonResponse({ jsonrpc: "2.0", id: 1 })],
    ];
    for (const [label, response] of cases) {
      const passthrough = new JsonRpcPassthrough({
        url: UPSTREAM,
        fetchImpl: (async () => response.clone()) as unknown as typeof fetch,
        onWarning,
      });
      const error = await forwardError(passthrough, "eth_sendRawTransaction", [RAW_TX]);
      expect(`${label}: ${error.code}`).toBe(`${label}: ${JSON_RPC_SERVER_ERROR}`);
      expect(error.message).toContain("malformed response from the upstream node");
    }
  });

  test("a null result is a result, not a malformed reply", async () => {
    const { impl } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: null }));
    const passthrough = new JsonRpcPassthrough({ url: UPSTREAM, fetchImpl: impl });
    expect(await passthrough.forward("eth_sendRawTransaction", [RAW_TX])).toBeNull();
  });

  test("gives up on a hung upstream instead of holding the request open", async () => {
    const { onWarning } = warnings();
    const impl = ((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const passthrough = new JsonRpcPassthrough({
      url: UPSTREAM,
      fetchImpl: impl,
      timeoutMs: 5,
      onWarning,
    });
    const error = await forwardError(passthrough, "eth_sendRawTransaction", [RAW_TX]);
    expect(error.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(error.message).toContain("could not be forwarded");
  });

  test("caps forwarded calls per minute and reopens on the next window", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    let now = 1_000_000;
    const passthrough = new JsonRpcPassthrough({
      url: UPSTREAM,
      fetchImpl: impl,
      rateLimitPerMinute: 2,
      now: () => now,
    });

    await passthrough.forward("eth_sendRawTransaction", [RAW_TX]);
    await passthrough.forward("eth_sendRawTransaction", [RAW_TX]);
    const error = await forwardError(passthrough, "eth_sendRawTransaction", [RAW_TX]);
    expect(error.code).toBe(JSON_RPC_LIMIT_EXCEEDED);
    expect(error.message).toContain("at most 2 forwarded requests per minute");
    // A rejected call must not consume the window, or a flood would hold it shut.
    expect(calls).toHaveLength(2);

    now += 60_000;
    expect(await passthrough.forward("eth_sendRawTransaction", [RAW_TX])).toBe("0x1");
    expect(calls).toHaveLength(3);
  });

  test("a rate limit of 0 means no cap", async () => {
    const { impl, calls } = recordingFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
    const passthrough = new JsonRpcPassthrough({
      url: UPSTREAM,
      fetchImpl: impl,
      rateLimitPerMinute: 0,
      now: () => 0,
    });
    for (let index = 0; index < 50; index += 1) {
      await passthrough.forward("eth_sendRawTransaction", [RAW_TX]);
    }
    expect(calls).toHaveLength(50);
  });

  test("the startup summary names the methods but never the upstream", () => {
    const passthrough = new JsonRpcPassthrough({
      url: UPSTREAM,
      apiKey: "hub-key",
      methods: ["eth_sendRawTransaction"],
      timeoutMs: 2_500,
      rateLimitPerMinute: 30,
    });
    const summary = passthrough.describe();
    expect(summary).toBe("eth_sendRawTransaction (timeout 2500ms, 30/min)");
    expect(summary).not.toContain("SUPER_SECRET_KEY");
    expect(summary).not.toContain("hub-key");
    expect(new JsonRpcPassthrough({ url: UPSTREAM, rateLimitPerMinute: 0 }).describe()).toContain(
      "unlimited (no rate cap)",
    );
  });
});
