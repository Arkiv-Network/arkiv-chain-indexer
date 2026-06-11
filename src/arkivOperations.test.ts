import { afterEach, describe, expect, test } from "bun:test";
import {
  ARKIV_REGISTRY_ADDRESS,
  ArkivDecoderClient,
  decodeBlockArkivOperations,
} from "./arkivOperations";
import { IGNORED_TRANSACTION_FROM_ADDRESS } from "./transactionFilter";
import type { Hex, RpcBlock, RpcTransaction } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface RecordedDecodeCall {
  url: string;
  body: unknown;
}

function stubFetch(
  handler: (data: string) => Response | Promise<Response>,
): RecordedDecodeCall[] {
  const calls: RecordedDecodeCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return handler((body as { data: string }).data);
  }) as unknown as typeof fetch;
  return calls;
}

function decoderOperationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationType: 1,
    operation: "create",
    entityKey: `0x${"11".repeat(32)}`,
    payload: { hex: "0xdeadbeef", size: 4, text: "secret payload" },
    contentType: "text/plain",
    attributes: [{ key: "project", valueType: 2, valueTypeName: "string", value: "demo" }],
    expiresAtBlocks: 100,
    approxExpiresInSeconds: 200,
    newOwner: null,
    ...overrides,
  };
}

function decoderResponse(operations: unknown[]): Response {
  return Response.json({ functionName: "execute", operations });
}

function transactionFixture(index: number, overrides: Partial<RpcTransaction> = {}): RpcTransaction {
  return {
    hash: `0x${index.toString(16).padStart(64, "0")}` as Hex,
    from: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

function blockFixture(transactions: RpcTransaction[]): RpcBlock {
  return {
    number: "0x1",
    timestamp: "0x65a0bb80",
    gasUsed: "0x0",
    gasLimit: "0x1c9c380",
    transactions,
  };
}

describe("ArkivDecoderClient.decodeCalldata", () => {
  test("maps decoder operations and drops payload contents", async () => {
    const calls = stubFetch(() => decoderResponse([decoderOperationFixture()]));
    const client = new ArkivDecoderClient("http://decoder.test/");

    const operations = await client.decodeCalldata("0x1234");

    expect(calls).toEqual([
      { url: "http://decoder.test/api/decode", body: { data: "0x1234" } },
    ]);
    expect(operations).toEqual([
      {
        opIndex: 0,
        operationType: 1,
        operation: "create",
        entityKey: `0x${"11".repeat(32)}`,
        contentType: "text/plain",
        payloadSizeBytes: 4,
        attributes: [{ key: "project", valueType: 2, valueTypeName: "string", value: "demo" }],
        expiresAtBlocks: 100,
        newOwner: null,
      },
    ]);
    expect(JSON.stringify(operations)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(operations)).not.toContain("secret payload");
  });

  test("assigns opIndex from the operation order in the response", async () => {
    stubFetch(() =>
      decoderResponse([
        decoderOperationFixture(),
        decoderOperationFixture({ operationType: 5, operation: "delete" }),
      ]),
    );
    const client = new ArkivDecoderClient("http://decoder.test");

    const operations = await client.decodeCalldata("0x1234");

    expect(operations?.map((operation) => operation.opIndex)).toEqual([0, 1]);
    expect(operations?.map((operation) => operation.operation)).toEqual(["create", "delete"]);
  });

  test("returns null when the decoder rejects the calldata with HTTP 400", async () => {
    stubFetch(() => Response.json({ error: "not an Arkiv execute() call" }, { status: 400 }));
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(await client.decodeCalldata("0xabcd")).toBeNull();
  });

  test("throws on decoder server errors with the decoder URL", async () => {
    stubFetch(() => Response.json({ error: "boom" }, { status: 500 }));
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow(
      "Arkiv decoder at http://decoder.test/api/decode returned HTTP 500",
    );
  });

  test("throws on network failures with the decoder URL", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow(
      "Arkiv decoder request to http://decoder.test/api/decode failed: connection refused",
    );
  });

  test("throws on unexpected response shapes", async () => {
    stubFetch(() => Response.json({ functionName: "execute", operations: "nope" }));
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow(
      "Arkiv decoder returned an unexpected response shape",
    );
  });
});

describe("decodeBlockArkivOperations", () => {
  test("decodes only Arkiv registry transactions and keeps original block positions", async () => {
    const calls = stubFetch((data) => {
      if (data === "0x01") return decoderResponse([decoderOperationFixture()]);
      if (data === "0x05") return Response.json({ error: "not arkiv" }, { status: 400 });
      if (data === "0x06") {
        return decoderResponse([
          decoderOperationFixture(),
          decoderOperationFixture({ operationType: 5, operation: "delete" }),
        ]);
      }
      throw new Error(`unexpected decode request for ${data}`);
    });
    const client = new ArkivDecoderClient("http://decoder.test");
    const uppercaseRegistry = `0x${ARKIV_REGISTRY_ADDRESS.slice(2).toUpperCase()}` as Hex;
    const block = blockFixture([
      transactionFixture(0, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x01" }),
      // Ignored sender sits between two Arkiv transactions; positions must not shift.
      transactionFixture(1, {
        from: IGNORED_TRANSACTION_FROM_ADDRESS as Hex,
        to: ARKIV_REGISTRY_ADDRESS as Hex,
        input: "0x02",
      }),
      transactionFixture(2, {
        to: "0x9999999999999999999999999999999999999999",
        input: "0x03",
      }),
      transactionFixture(3, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x" }),
      transactionFixture(4, { to: ARKIV_REGISTRY_ADDRESS as Hex }),
      transactionFixture(5, { to: uppercaseRegistry, input: "0x05" }),
      transactionFixture(6, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x06" }),
    ]);

    const results = await decodeBlockArkivOperations(block, client);

    expect(calls.map((call) => (call.body as { data: string }).data)).toEqual([
      "0x01",
      "0x05",
      "0x06",
    ]);
    expect(results.map((entry) => entry.position)).toEqual([0, 6]);
    expect(results.map((entry) => entry.hash)).toEqual([
      block.transactions[0]!.hash,
      block.transactions[6]!.hash,
    ]);
    expect(results[0]?.operations).toHaveLength(1);
    expect(results[1]?.operations).toHaveLength(2);
  });

  test("returns an empty list for blocks without Arkiv registry transactions", async () => {
    const calls = stubFetch(() => {
      throw new Error("decoder must not be called");
    });
    const client = new ArkivDecoderClient("http://decoder.test");
    const block = blockFixture([
      transactionFixture(0, { to: "0x9999999999999999999999999999999999999999", input: "0x01" }),
      transactionFixture(1, { to: null }),
    ]);

    expect(await decodeBlockArkivOperations(block, client)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
