import { afterEach, describe, expect, test } from "bun:test";
import {
  ARKIV_REGISTRY_ADDRESS,
  ArkivDecoderClient,
  DecoderContractError,
  ENTITY_CREATED_TOPIC0,
  decodeBlockArkivOperations,
  parseDecoderResponse,
  resolveOperationExpiry,
  schemaNameOf,
} from "./arkivOperations";
import { IGNORED_TRANSACTION_FROM_ADDRESS } from "./transactionFilter";
import { LIVE_BLOCKS, decoderOperationJson, decoderResponseJson, udcAttribute } from "./testUdc";
import type { Hex, RpcBlock, RpcLog, RpcReceipt, RpcTransaction } from "./types";

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
  version: unknown = { service: "arkiv-transaction-decoder", version: "v0.3.0" },
): RecordedDecodeCall[] {
  const calls: RecordedDecodeCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/version")) return Response.json(version);
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return handler((body as { data: string }).data);
  }) as unknown as typeof fetch;
  return calls;
}

const decoderOperationFixture = decoderOperationJson;

function decoderResponse(operations: unknown[]): Response {
  return Response.json(decoderResponseJson(operations));
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

describe("parseDecoderResponse", () => {
  test("reads every live golden as the decoder sent it", () => {
    for (const block of LIVE_BLOCKS) {
      for (const transaction of block.transactions) {
        const operations = parseDecoderResponse(transaction.decoded);
        expect(operations).toHaveLength(transaction.decoded.operations.length);
        operations.forEach((operation, index) => {
          const raw = transaction.decoded.operations[index]!;
          expect(operation.opIndex).toBe(index);
          expect(operation.operationType).toBe(raw.operationType as number);
          expect(operation.expiresAt).toBe(raw.expiresAt as string | null);
          expect(operation.minLifetime).toBe(raw.minLifetime as string | null);
          expect(operation.salt).toBe(raw.salt as string | null);
          expect(operation.bytesSize).toBe(raw.bytesSize as number);
          expect(operation.attributes).toEqual(raw.attributes as unknown as typeof operation.attributes);
        });
      }
    }
  });

  test("keeps the permanent create's exact 2^64 - 1 expiry and drops the decoder's permanent flag", () => {
    const block48 = LIVE_BLOCKS.find((block) => block.blockNumber === 48)!;
    const [create] = parseDecoderResponse(block48.transactions[0]!.decoded);
    expect(create!.expiresAt).toBe("18446744073709551615");
    expect(create).not.toHaveProperty("permanent");
    expect(resolveOperationExpiry(48, create!)).toBe("18446744073709551615");
  });

  test("keeps a patch's tombstones, retypes and flags in calldata order", () => {
    const block22 = LIVE_BLOCKS.find((block) => block.blockNumber === 22)!;
    const [patch] = parseDecoderResponse(block22.transactions[0]!.decoded);
    expect(patch!.operation).toBe("patch");
    const raw = block22.transactions[0]!.decoded.operations[0]!.attributes as Array<Record<string, unknown>>;
    expect(patch!.attributes.map((attribute): unknown[] => [attribute.name, attribute.type, attribute.indexed])).toEqual(
      raw.map((attribute): unknown[] => [attribute.name, attribute.type, attribute.indexed]),
    );
    expect(patch!.attributes.some((attribute) => attribute.typeId === 0 && attribute.value === null)).toBe(true);
  });

  test("refuses another format, naming it", () => {
    expect(() => parseDecoderResponse({ functionName: "execute", format: "tagged", operations: [] })).toThrow(
      'the response format is "tagged", not "udc"',
    );
    expect(() => parseDecoderResponse({ functionName: "execute", operations: [] })).toThrow(DecoderContractError);
  });

  test("refuses a payload-era operation", () => {
    const legacy = {
      operationType: 1,
      operation: "create",
      entityKey: null,
      payload: { size: 4 },
      contentType: "text/plain",
      attributes: [{ key: "project", valueType: 8, valueTypeName: "str", value: "demo" }],
      expiresAtBlocks: 100,
      newOwner: null,
    };
    expect(() => parseDecoderResponse(decoderResponseJson([legacy]))).toThrow("operation 0 has no salt");
  });

  test("requires every field, null where it does not apply", () => {
    const { creationFlags: _dropped, ...missing } = decoderOperationFixture();
    expect(() => parseDecoderResponse(decoderResponseJson([missing]))).toThrow("operation 0 has no creationFlags");
    expect(() => parseDecoderResponse(decoderResponseJson([decoderOperationFixture({ expiresAt: 100 })]))).toThrow(
      "operation 0.expiresAt is number 100, expected a decimal string or null",
    );
    expect(() =>
      parseDecoderResponse(decoderResponseJson([decoderOperationFixture({ attributes: [{ name: "x", typeId: 8 }] })])),
    ).toThrow("operation 0.attributes[0].type is missing");
  });

  test("accepts every value encoding the node uses", () => {
    const attributes = [
      udcAttribute("a", "bool", true),
      udcAttribute("b", "i32", -10),
      udcAttribute("c", "u64", "0x1fffffffffffff"),
      udcAttribute("d", "dec", "-0.25"),
      udcAttribute("e", "str", "hello"),
      udcAttribute("f", "bytes", null, { size: 3, keccak256: `0x${"ab".repeat(32)}` }),
      udcAttribute("g", "tombstone", null),
      { name: "h", typeId: 0x87, type: "invalid(0x87)", indexed: true, value: null, size: 0, error: "bytes cannot be indexed" },
    ];
    const [operation] = parseDecoderResponse(decoderResponseJson([decoderOperationFixture({ attributes })]));
    expect(operation!.attributes).toEqual(attributes);
  });

  test("refuses a bytes attribute that carries its content", () => {
    expect(() =>
      parseDecoderResponse(
        decoderResponseJson([decoderOperationFixture({ attributes: [udcAttribute("blob", "bytes", "0x010203")] })]),
      ),
    ).toThrow("bytes content is never stored");
  });
});

describe("schemaNameOf and resolveOperationExpiry", () => {
  test("the schema is the indexed str arkiv.schema only", () => {
    expect(schemaNameOf([udcAttribute("arkiv.schema", "str", "posts")])).toBe("posts");
    expect(schemaNameOf([udcAttribute("arkiv.schema", "str", "posts", { indexed: false })])).toBeNull();
    expect(schemaNameOf([udcAttribute("arkiv.schema", "i32", 3)])).toBeNull();
    expect(schemaNameOf([udcAttribute("schema", "str", "posts")])).toBeNull();
  });

  test("expiry is max(expiresAt, block + minLifetime), capped at 2^64 - 1", () => {
    expect(resolveOperationExpiry(16, { expiresAt: "0", minLifetime: "1800" })).toBe("1816");
    expect(resolveOperationExpiry(16, { expiresAt: "5000", minLifetime: "1800" })).toBe("5000");
    expect(resolveOperationExpiry(16, { expiresAt: "0", minLifetime: "18446744073709551615" })).toBe(
      "18446744073709551615",
    );
    expect(resolveOperationExpiry(16, { expiresAt: null, minLifetime: null })).toBeNull();
  });
});

describe("ArkivDecoderClient.decodeCalldata", () => {
  test("maps decoder operations and posts only the calldata", async () => {
    const calls = stubFetch(() => decoderResponse([decoderOperationFixture()]));
    const client = new ArkivDecoderClient("http://decoder.test/");

    const operations = await client.decodeCalldata("0x1234");

    expect(calls).toEqual([{ url: "http://decoder.test/decode", body: { data: "0x1234" } }]);
    expect(operations).toEqual([
      {
        opIndex: 0,
        operationType: 1,
        operation: "create",
        entityKey: null,
        salt: "42",
        creationFlags: 0,
        expiresAt: "0",
        minLifetime: "1800",
        newOwner: null,
        bytesSize: 0,
        schemaName: null,
        attributes: [udcAttribute("project", "str", "demo")],
      },
    ]);
  });

  test("assigns opIndex from the operation order in the response", async () => {
    stubFetch(() =>
      decoderResponse([
        decoderOperationFixture(),
        decoderOperationFixture({
          operationType: 5,
          operation: "delete",
          entityKey: `0x${"11".repeat(32)}`,
          salt: null,
          creationFlags: null,
          expiresAt: null,
          minLifetime: null,
          permanent: null,
          attributes: [],
        }),
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
    stubFetch(() => Response.json({ error: "input is not an Arkiv execute() call (selector 0xba8ccf92)" }, { status: 400 }));
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

  test("an old-format decoder fails loudly, naming its version", async () => {
    stubFetch(
      () => Response.json({ functionName: "execute", format: "tagged", operations: [] }),
      { service: "arkiv-transaction-decoder", version: "v0.2.2" },
    );
    const client = new ArkivDecoderClient("http://decoder.test");

    const failure = client.decodeCalldata("0xabcd");
    expect(failure).rejects.toThrow(DecoderContractError);
    expect(failure).rejects.toThrow(
      'Arkiv decoder at http://decoder.test (version v0.2.2) answered outside the UDC contract: the response format is "tagged", not "udc"',
    );
  });

  test("a decoder that cannot say its version is reported as unknown", async () => {
    stubFetch(() => Response.json({ functionName: "execute", operations: "nope" }), null);
    const client = new ArkivDecoderClient("http://decoder.test");

    expect(client.decodeCalldata("0xabcd")).rejects.toThrow("(version unknown)");
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
          decoderOperationFixture({ operationType: 5, operation: "delete", entityKey: `0x${"11".repeat(32)}` }),
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

describe("create entity keys from receipts", () => {
  const KEY_A = `0x${"aa".repeat(32)}` as Hex;
  const KEY_B = `0x${"bb".repeat(32)}` as Hex;
  const OWNER_TOPIC = `0x${"11".repeat(12)}${"22".repeat(20)}` as Hex;

  function entityCreatedLog(entityKey: Hex): RpcLog {
    return {
      address: ARKIV_REGISTRY_ADDRESS as Hex,
      topics: [ENTITY_CREATED_TOPIC0 as Hex, entityKey, OWNER_TOPIC],
      data: "0x",
    };
  }

  function receiptFixture(hash: Hex, logs: RpcLog[], overrides: Partial<RpcReceipt> = {}): RpcReceipt {
    return { transactionHash: hash, gasUsed: "0x5208", status: "0x1", logs, ...overrides };
  }

  test("fills create entity keys from EntityCreated logs in operation order", async () => {
    stubFetch(() =>
      decoderResponse([
        decoderOperationFixture({ entityKey: null }),
        decoderOperationFixture({ operationType: 2, operation: "patch", entityKey: `0x${"11".repeat(32)}` }),
        decoderOperationFixture({ entityKey: null }),
      ]),
    );
    const client = new ArkivDecoderClient("http://decoder.test");
    const block = blockFixture([
      transactionFixture(0, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x01" }),
    ]);
    const hash = block.transactions[0]!.hash;
    const receipt = receiptFixture(hash, [
      // A foreign log and a non-EntityCreated registry log must both be ignored.
      { ...entityCreatedLog(`0x${"99".repeat(32)}` as Hex), address: `0x${"99".repeat(20)}` as Hex },
      entityCreatedLog(KEY_A),
      { address: ARKIV_REGISTRY_ADDRESS as Hex, topics: [`0x${"cc".repeat(32)}` as Hex], data: "0x" },
      entityCreatedLog(KEY_B),
    ]);

    const results = await decodeBlockArkivOperations(block, client, [receipt]);

    expect(results[0]?.operations.map((operation) => operation.entityKey)).toEqual([
      KEY_A,
      `0x${"11".repeat(32)}`,
      KEY_B,
    ]);
  });

  test("matches receipts to transactions case-insensitively by hash", async () => {
    stubFetch(() => decoderResponse([decoderOperationFixture({ entityKey: null })]));
    const client = new ArkivDecoderClient("http://decoder.test");
    const block = blockFixture([
      transactionFixture(0, {
        hash: `0x${"ab".repeat(32)}` as Hex,
        to: ARKIV_REGISTRY_ADDRESS as Hex,
        input: "0x01",
      }),
    ]);
    const receipt = receiptFixture(`0x${"AB".repeat(32)}` as Hex, [entityCreatedLog(KEY_A)]);

    const results = await decodeBlockArkivOperations(block, client, [receipt]);

    expect(results[0]?.operations[0]?.entityKey).toBe(KEY_A);
  });

  test("leaves create entity keys null when log and create counts disagree", async () => {
    stubFetch(() =>
      decoderResponse([
        decoderOperationFixture({ entityKey: null }),
        decoderOperationFixture({ entityKey: null }),
      ]),
    );
    const client = new ArkivDecoderClient("http://decoder.test");
    const block = blockFixture([
      transactionFixture(0, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x01" }),
    ]);
    const receipt = receiptFixture(block.transactions[0]!.hash, [entityCreatedLog(KEY_A)]);

    const results = await decodeBlockArkivOperations(block, client, [receipt]);

    expect(results[0]?.operations.map((operation) => operation.entityKey)).toEqual([null, null]);
  });

  test("leaves create entity keys null for a reverted transaction", async () => {
    stubFetch(() => decoderResponse([decoderOperationFixture({ entityKey: null })]));
    const client = new ArkivDecoderClient("http://decoder.test");
    const block = blockFixture([
      transactionFixture(0, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x01" }),
    ]);
    const receipt = receiptFixture(block.transactions[0]!.hash, [], { status: "0x0" });

    const results = await decodeBlockArkivOperations(block, client, [receipt]);

    expect(results[0]?.operations[0]?.entityKey).toBeNull();
  });

  test("leaves operations untouched without receipts", async () => {
    stubFetch(() => decoderResponse([decoderOperationFixture({ entityKey: null })]));
    const client = new ArkivDecoderClient("http://decoder.test");
    const block = blockFixture([
      transactionFixture(0, { to: ARKIV_REGISTRY_ADDRESS as Hex, input: "0x01" }),
    ]);

    const results = await decodeBlockArkivOperations(block, client);

    expect(results[0]?.operations[0]?.entityKey).toBeNull();
  });
});
