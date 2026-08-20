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

const REFERENCE_CONTENT_TYPE = "application/vnd.atlas.payload-reference+json";

/**
 * A reference-mode operation as the decoder emits it: the payload is flagged
 * `isReference` and carries hex bytes (which must still be dropped), with the
 * parsed reference, verdict, and any parse error alongside it.
 */
function referenceOperationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationType: 1,
    operation: "create",
    entityKey: `0x${"00".repeat(32)}`,
    contentType: REFERENCE_CONTENT_TYPE,
    payload: { hex: "0xb10bb10b", size: 700, isReference: true },
    payloadReference: {
      kind: "atlas.payloadReference",
      version: 1,
      provider: "atlas-payload-provider",
      id: "a".repeat(64),
      namespace: "atlas.test",
      checksum: `sha256:${"b".repeat(64)}`,
      sizeBytes: 700,
      submittedAt: "2026-06-24T15:24:30Z",
      nonce: `0x${"00".repeat(31)}01`,
      payment: 100000,
      signature: {
        scheme: "eip191",
        signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
        receipt: { service: "atlas-payload-provider" },
        messageHash: `0x${"cd".repeat(32)}`,
        signature: `0x${"ef".repeat(65)}`,
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        v: 27,
      },
    },
    referenceVerification: {
      valid: true,
      signerTrusted: true,
      chainId: 1337,
      claimedSigner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      recoveredSigner: "0x7e5f4552091a69125d5dFcB7b8C2659029395Bdf",
      messageHash: `0x${"cd".repeat(32)}`,
      errors: [],
    },
    attributes: [],
    expiresAtBlocks: 10,
    approxExpiresInSeconds: 20,
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

    expect(calls).toEqual([{ url: "http://decoder.test/decode", body: { data: "0x1234" } }]);
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
        isReference: false,
        payloadReference: null,
        referenceVerification: null,
        referenceError: null,
      },
    ]);
    expect(JSON.stringify(operations)).not.toContain("0xdeadbeef");
    expect(JSON.stringify(operations)).not.toContain("secret payload");
  });

  test("sends the chain id in the request body when configured", async () => {
    const calls = stubFetch(() => decoderResponse([decoderOperationFixture()]));
    const client = new ArkivDecoderClient("http://decoder.test", 42069);

    await client.decodeCalldata("0x1234");

    expect(calls).toEqual([
      { url: "http://decoder.test/decode", body: { data: "0x1234", chainId: 42069 } },
    ]);
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

  test("warns once per selector when the decoder cannot read registry calldata", async () => {
    stubFetch(() =>
      Response.json(
        { error: { message: "input is neither Arkiv execute() calldata (selector 0xba8ccf92)" } },
        { status: 400 },
      ),
    );
    const client = new ArkivDecoderClient("http://decoder.test");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => warnings.push(message);

    try {
      for (let call = 0; call < 3; call += 1) {
        await client.decodeCalldata("0x49650044deadbeef");
      }
      await client.decodeCalldata("0xba8ccf92deadbeef");
    } finally {
      console.warn = originalWarn;
    }

    // One warning for each distinct selector, however often it repeats.
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("selector 0x49650044");
    expect(warnings[0]).toContain("http://decoder.test");
    // The decoder's own explanation rides along, so the mismatch is readable
    // from the log line alone.
    expect(warnings[0]).toContain("selector 0xba8ccf92)");
    expect(warnings[1]).toContain("selector 0xba8ccf92 ");
  });

  test("throws on decoder server errors with the decoder URL", async () => {
    stubFetch(() => Response.json({ error: "boom" }, { status: 500 }));
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow(
      "Arkiv decoder at http://decoder.test/decode returned HTTP 500",
    );
  });

  test("throws on network failures with the decoder URL", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow(
      "Arkiv decoder request to http://decoder.test/decode failed: connection refused",
    );
  });

  test("throws on unexpected response shapes", async () => {
    stubFetch(() => Response.json({ functionName: "execute", operations: "nope" }));
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow(
      "Arkiv decoder returned an unexpected response shape",
    );
  });

  test("captures reference-mode metadata and verdict while still dropping payload bytes", async () => {
    stubFetch(() => decoderResponse([referenceOperationFixture()]));
    const client = new ArkivDecoderClient("http://decoder.test", 1337);

    const operations = await client.decodeCalldata("0x1234");

    expect(operations).toHaveLength(1);
    expect(operations?.[0]).toMatchObject({
      isReference: true,
      contentType: REFERENCE_CONTENT_TYPE,
      payloadSizeBytes: 700,
      payloadReference: { provider: "atlas-payload-provider", id: "a".repeat(64) },
      referenceVerification: { valid: true, signerTrusted: true, errors: [] },
      referenceError: null,
    });
    // The reference receipt is kept, but the raw payload bytes are not.
    expect(JSON.stringify(operations)).not.toContain("0xb10bb10b");
  });

  test("captures a reference parse error without a parsed reference", async () => {
    stubFetch(() =>
      decoderResponse([
        referenceOperationFixture({
          payloadReference: undefined,
          referenceVerification: undefined,
          referenceError: "payload is not a valid payload reference: expected value",
        }),
      ]),
    );
    const client = new ArkivDecoderClient("http://decoder.test", 1337);

    const operations = await client.decodeCalldata("0x1234");

    expect(operations?.[0]).toMatchObject({
      isReference: true,
      payloadReference: null,
      referenceVerification: null,
      referenceError: "payload is not a valid payload reference: expected value",
    });
  });

  test("preserves a failed verification verdict and its errors", async () => {
    stubFetch(() =>
      decoderResponse([
        referenceOperationFixture({
          referenceVerification: {
            valid: false,
            signerTrusted: false,
            chainId: 42069,
            recoveredSigner: "0x7e5f4552091a69125d5dFcB7b8C2659029395Bdf",
            errors: ["signer 0x7e5f… is not in the trusted payload-provider allowlist for chain 42069"],
          },
        }),
      ]),
    );
    const client = new ArkivDecoderClient("http://decoder.test", 42069);

    const operations = await client.decodeCalldata("0x1234");

    expect(operations?.[0]?.referenceVerification).toMatchObject({
      valid: false,
      signerTrusted: false,
      claimedSigner: null,
      messageHash: null,
    });
    expect(operations?.[0]?.referenceVerification?.errors).toHaveLength(1);
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
