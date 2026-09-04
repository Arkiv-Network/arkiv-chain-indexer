import { describe, expect, test } from "bun:test";
import { createWalletClient, ENTITY_EVENTS_ABI, ExpirationTime } from "@arkiv-network/sdk";
import { defineChain, encodeAbiParameters, encodeEventTopics, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BaseloadRuntime,
  baseloadGasShapeKey,
  decodeBaseloadMutationReceipt,
  isBaseloadTransactionReceiptSuccessful,
  learnBaseloadGasLimit,
  readBaseloadCreatedEntityKeyFromSdkResult,
  readBaseloadEntityKeysFromSdkResult,
  estimateCurrentBlock,
  readReceiptQuantity,
  sendBaseloadMutation,
  toSdkMutationParameters,
  type BaseloadMutationParameters,
} from "./baseloadRuntime";

const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ENTITY_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const SECOND_ENTITY_KEY = `0x${"22".repeat(32)}` as `0x${string}`;

describe("baseload runtime SDK entity key handling", () => {
  test("trusts a valid entity key returned by the SDK", () => {
    expect(readBaseloadCreatedEntityKeyFromSdkResult(ENTITY_KEY, TX_HASH)).toBe(ENTITY_KEY);
  });

  test("rejects a missing SDK entity key", () => {
    expect(() => readBaseloadCreatedEntityKeyFromSdkResult(undefined, TX_HASH)).toThrow(
      /SDK returned invalid entity key/,
    );
  });

  test("rejects a malformed SDK entity key", () => {
    expect(() => readBaseloadCreatedEntityKeyFromSdkResult("0x1234", TX_HASH)).toThrow(
      /SDK returned invalid entity key/,
    );
  });

  test("trusts valid entity key arrays returned by batch mutations", () => {
    expect(
      readBaseloadEntityKeysFromSdkResult(
        [ENTITY_KEY, SECOND_ENTITY_KEY],
        TX_HASH,
        2,
        "createdEntities",
      ),
    ).toEqual([ENTITY_KEY, SECOND_ENTITY_KEY]);
  });

  test("rejects malformed batch mutation entity key arrays", () => {
    expect(() =>
      readBaseloadEntityKeysFromSdkResult([ENTITY_KEY], TX_HASH, 2, "createdEntities"),
    ).toThrow(/expected 2 keys/);
    expect(() =>
      readBaseloadEntityKeysFromSdkResult([ENTITY_KEY, "0x1234"], TX_HASH, 2, "createdEntities"),
    ).toThrow(/createdEntities\[1\]/);
  });
});

describe("baseload runtime receipt handling", () => {
  test("accepts successful transaction receipt status forms", () => {
    expect(isBaseloadTransactionReceiptSuccessful({ status: "0x1" })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: "1" })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 1 })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 1n })).toBe(true);
    expect(isBaseloadTransactionReceiptSuccessful({ status: true })).toBe(true);
  });

  test("rejects reverted transaction receipt status forms", () => {
    expect(isBaseloadTransactionReceiptSuccessful({ status: "0x0" })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: "0" })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 0 })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: 0n })).toBe(false);
    expect(isBaseloadTransactionReceiptSuccessful({ status: false })).toBe(false);
  });

  test("keeps compatibility with receipt fixtures that omit status", () => {
    expect(isBaseloadTransactionReceiptSuccessful({ transactionHash: TX_HASH })).toBe(true);
  });
});

function updateInput(entityKey: `0x${string}`, expiresIn: number) {
  return {
    entityKey,
    payload: new Uint8Array([1]),
    contentType: "application/octet-stream",
    attributes: [],
    expiresIn,
  } as unknown as NonNullable<BaseloadMutationParameters["updates"]>[number];
}

function sdkExtensions(parameters: BaseloadMutationParameters): Array<{ entityKey: string; expires: unknown }> {
  const sdk = toSdkMutationParameters(parameters) as {
    extensions?: Array<{ entityKey: string; expires: unknown }>;
  };
  return sdk.extensions ?? [];
}

describe("baseload SDK mutation parameters", () => {
  test("extends past the update's own TTL so the engine never sees an unchanged expiry", () => {
    // The engine measures expiry in blocks: an update landing in the block that
    // last set the expiry would compute the same value and revert the batch with
    // ExpiryNotExtended, so the batched extension must clear it by a block.
    expect(sdkExtensions({ updates: [updateInput(ENTITY_KEY, 60)] })).toEqual([
      { entityKey: ENTITY_KEY, expires: ExpirationTime.fromSeconds(62) },
    ]);
  });

  test("keeps update-derived extensions aligned to the 2s block time", () => {
    expect(sdkExtensions({ updates: [updateInput(ENTITY_KEY, 61)] })).toEqual([
      { entityKey: ENTITY_KEY, expires: ExpirationTime.fromSeconds(64) },
    ]);
  });

  test("leaves explicitly requested extensions at their aligned TTL", () => {
    expect(sdkExtensions({ extensions: [{ entityKey: SECOND_ENTITY_KEY, expiresIn: 61 }] })).toEqual([
      { entityKey: SECOND_ENTITY_KEY, expires: ExpirationTime.fromSeconds(62) },
    ]);
  });

  test("carries an extension for every entity in an update batch", () => {
    expect(
      sdkExtensions({ updates: [updateInput(ENTITY_KEY, 60), updateInput(SECOND_ENTITY_KEY, 60)] }),
    ).toEqual([
      { entityKey: ENTITY_KEY, expires: ExpirationTime.fromSeconds(62) },
      { entityKey: SECOND_ENTITY_KEY, expires: ExpirationTime.fromSeconds(62) },
    ]);
  });

  test("maps updates onto SDK patches that replace payload and set attributes", () => {
    const sdk = toSdkMutationParameters({ updates: [updateInput(ENTITY_KEY, 60)] }) as {
      patches?: Array<Record<string, unknown>>;
      updates?: unknown;
    };
    expect(sdk.updates).toBeUndefined();
    expect(sdk.patches).toEqual([
      {
        entityKey: ENTITY_KEY,
        payload: new Uint8Array([1]),
        contentType: "application/octet-stream",
        set: {},
      },
    ]);
  });
});

const ENGINE_ADDRESS = "0x4400000000000000000000000000000000000044";

/**
 * A JSON-RPC endpoint that records every method it is asked for, so a test can
 * assert what a send actually costs.
 */
function startRecordingRpcServer() {
  const methods: string[] = [];
  const results: Record<string, unknown> = {
    eth_chainId: "0x1",
    eth_blockNumber: "0x64",
    eth_getTransactionCount: "0x7",
    eth_estimateGas: "0x5208",
    eth_maxPriorityFeePerGas: "0x1",
    eth_sendRawTransaction: TX_HASH,
    eth_getBlockByNumber: { baseFeePerGas: "0x7", number: "0x64", timestamp: "0x1" },
  };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id: number; method: string };
      methods.push(body.method);
      if (body.method === "eth_fillTransaction") {
        // A stock Ethereum node has no such method; viem probes for it once.
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "method not found" },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: results[body.method] ?? null });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    methods,
    stop: () => server.stop(true),
  };
}

function testWalletClient(url: string) {
  const chain = defineChain({
    id: 1,
    name: "baseload-test",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    rpcUrls: { default: { http: [url] } },
  });
  return createWalletClient({
    chain,
    transport: http(url),
    account: privateKeyToAccount(`0x${"11".repeat(32)}`),
  });
}

const CREATE_BATCH: BaseloadMutationParameters = {
  creates: [
    {
      payload: new Uint8Array([1, 2, 3, 4]),
      contentType: "application/octet-stream",
      attributes: [{ key: "index", value: 1 }],
      expiresIn: 120,
    },
  ],
};

describe("baseload advanced-path RPC economy", () => {
  test("a fully specified batch costs one eth_sendRawTransaction", async () => {
    const rpc = startRecordingRpcServer();
    try {
      const txHash = await sendBaseloadMutation(
        testWalletClient(rpc.url),
        CREATE_BATCH,
        {
          maxFeePerGas: 1_000_000_000n,
          maxPriorityFeePerGas: 2n,
          nonce: 7,
          gas: 1_000_000n,
          chainId: 1,
        },
        100n,
      );

      expect(txHash).toBe(TX_HASH);
      expect(rpc.methods).toEqual(["eth_sendRawTransaction"]);
    } finally {
      rpc.stop();
    }
  });

  test("omitting the gas limit and the head costs the lookups they would have saved", async () => {
    const rpc = startRecordingRpcServer();
    try {
      await sendBaseloadMutation(
        testWalletClient(rpc.url),
        CREATE_BATCH,
        { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 2n, nonce: 7, chainId: 1 },
        undefined,
      );

      expect(rpc.methods).toContain("eth_blockNumber");
      expect(rpc.methods).toContain("eth_estimateGas");
      expect(rpc.methods.length).toBeGreaterThan(1);
    } finally {
      rpc.stop();
    }
  });
});

describe("baseload receipt decoding", () => {
  /** A raw JSON-RPC receipt carrying one EntityCreated log, as a node returns it. */
  function receiptWithCreatedEntity(entityKey: string) {
    return {
      status: "0x1",
      blockNumber: "0x64",
      gasUsed: "0x1e8480",
      transactionHash: TX_HASH,
      logs: [
        {
          address: ENGINE_ADDRESS,
          topics: encodeEventTopics({
            abi: ENTITY_EVENTS_ABI,
            eventName: "EntityCreated",
            args: { entityKey: entityKey as `0x${string}`, owner: `0x${"33".repeat(20)}` },
          }),
          data: encodeAbiParameters(
            [
              { type: "uint64", name: "expiresAt" },
              { type: "uint8", name: "creationFlags" },
            ],
            [1_200_000n, 0],
          ),
        },
      ],
    };
  }

  test("reads created entity keys out of a receipt without any RPC call", () => {
    const result = decodeBaseloadMutationReceipt(TX_HASH, receiptWithCreatedEntity(ENTITY_KEY));

    expect(result.txHash).toBe(TX_HASH);
    expect(result.createdEntities).toEqual([ENTITY_KEY]);
    expect(result.deletedEntities).toEqual([]);
    expect(result.updatedEntities).toEqual([]);
  });

  test("ignores logs from other contracts", () => {
    const receipt = receiptWithCreatedEntity(ENTITY_KEY);
    receipt.logs[0]!.address = `0x${"99".repeat(20)}`;

    expect(decodeBaseloadMutationReceipt(TX_HASH, receipt).createdEntities).toEqual([]);
  });

  test("tolerates a receipt with no logs", () => {
    expect(decodeBaseloadMutationReceipt(TX_HASH, { status: "0x1" }).createdEntities).toEqual([]);
  });
});

describe("baseload gas limit learning", () => {
  test("keys batches by their operation mix and size", () => {
    expect(baseloadGasShapeKey({ creates: [] })).toBe("0:0:0:0:0");
    expect(baseloadGasShapeKey(CREATE_BATCH)).toBe("1:0:0:0:0");
    expect(
      baseloadGasShapeKey({ deletes: [{ entityKey: ENTITY_KEY }, { entityKey: SECOND_ENTITY_KEY }] }),
    ).toBe("0:0:2:0:0");
  });

  test("adds headroom to an observed burn and clamps the extremes", () => {
    expect(learnBaseloadGasLimit(1_000_000n)).toBe(1_500_000n);
    expect(learnBaseloadGasLimit(1n)).toBe(200_000n);
    expect(learnBaseloadGasLimit(40_000_000n)).toBe(30_000_000n);
  });

  test("reads receipt quantities in every form a node may send", () => {
    expect(readReceiptQuantity({ gasUsed: "0x1e8480" }, "gasUsed")).toBe(2_000_000n);
    expect(readReceiptQuantity({ gasUsed: 21_000 }, "gasUsed")).toBe(21_000n);
    expect(readReceiptQuantity({ gasUsed: 21_000n }, "gasUsed")).toBe(21_000n);
    expect(readReceiptQuantity({ gasUsed: "nope" }, "gasUsed")).toBeNull();
    expect(readReceiptQuantity({}, "gasUsed")).toBeNull();
  });
});

describe("baseload chain head estimation", () => {
  const readAtMs = Date.UTC(2026, 7, 18, 12, 0, 0);

  test("carries a known height forward at the chain's block rate", () => {
    expect(estimateCurrentBlock(1_000, readAtMs, readAtMs)).toBe(1_000n);
    expect(estimateCurrentBlock(1_000, readAtMs, readAtMs + 10_000)).toBe(1_005n);
    // Part of a block does not count as one.
    expect(estimateCurrentBlock(1_000, readAtMs, readAtMs + 1_999)).toBe(1_000n);
  });

  test("never walks the height backwards", () => {
    expect(estimateCurrentBlock(1_000, readAtMs, readAtMs - 60_000)).toBe(1_000n);
  });

  test("has no estimate before any height is known", () => {
    expect(estimateCurrentBlock(0, 0, readAtMs)).toBeUndefined();
    expect(estimateCurrentBlock(1_000, 0, readAtMs)).toBeUndefined();
  });
});

/**
 * A node stand-in for a whole worker loop: it answers everything a create
 * worker asks for and counts each method, so the loop's RPC bill per operation
 * can be asserted rather than reasoned about.
 */
function startFakeNode(options: { entitiesPerBatch: number }) {
  const methods: string[] = [];
  let sentTransactions = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { id: number; method: string };
      methods.push(body.method);
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: body.id, result });

      switch (body.method) {
        case "eth_chainId":
          return reply("0x1");
        case "eth_blockNumber":
          return reply("0x64");
        case "eth_getBlockByNumber":
          return reply({ number: "0x64", baseFeePerGas: "0x1" });
        case "eth_getBalance":
          return reply("0x56bc75e2d63100000");
        case "eth_getTransactionCount":
          return reply("0x7");
        case "eth_estimateGas":
          return reply("0x1e8480");
        case "eth_sendRawTransaction":
          sentTransactions += 1;
          return reply(txHashForSend(sentTransactions));
        case "eth_getTransactionReceipt": {
          const txHash = (body as unknown as { params: string[] }).params[0]!;
          return reply({
            status: "0x1",
            blockNumber: "0x64",
            gasUsed: "0x1e8480",
            transactionHash: txHash,
            logs: Array.from({ length: options.entitiesPerBatch }, (_unused, index) =>
              entityCreatedLog(`0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`),
            ),
          });
        }
        case "eth_fillTransaction":
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "method not found" },
          });
        default:
          return reply(null);
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    methods,
    countOf: (method: string) => methods.filter((candidate) => candidate === method).length,
    stop: () => server.stop(true),
  };
}

function txHashForSend(index: number): string {
  return `0x${index.toString(16).padStart(2, "0").repeat(32)}`;
}

function entityCreatedLog(entityKey: string) {
  return {
    address: ENGINE_ADDRESS,
    topics: encodeEventTopics({
      abi: ENTITY_EVENTS_ABI,
      eventName: "EntityCreated",
      args: { entityKey: entityKey as `0x${string}`, owner: `0x${"33".repeat(20)}` },
    }),
    data: encodeAbiParameters(
      [
        { type: "uint64", name: "expiresAt" },
        { type: "uint8", name: "creationFlags" },
      ],
      [1_200_000n, 0],
    ),
  };
}

describe("baseload worker loop RPC budget", () => {
  test(
    "spends one send and no lookups per operation after the first",
    async () => {
      const node = startFakeNode({ entitiesPerBatch: 1 });
      const runtime = new BaseloadRuntime({
        rpcUrl: node.url,
        mnemonic: TEST_MNEMONIC,
        payloadProvider: null,
        faucet: null,
        rpcKeys: null,
      });
      try {
        runtime.updateConfig({
          workers: [
            {
              walletNumber: 0,
              behavior: "create",
              entitiesPerRequest: 1,
              opsPerMinute: 60,
              singleCreatePayloadSize: 32,
            },
          ],
        });

        // Let the worker land three transactions.
        const deadline = Date.now() + 25_000;
        while (node.countOf("eth_sendRawTransaction") < 3 && Date.now() < deadline) {
          await Bun.sleep(100);
        }
        runtime.stop();

        const sends = node.countOf("eth_sendRawTransaction");
        expect(sends).toBeGreaterThanOrEqual(3);
        // The nonce is read once for the worker, not once per operation.
        expect(node.countOf("eth_getTransactionCount")).toBe(1);
        // The gas limit is estimated for the first batch shape only.
        expect(node.countOf("eth_estimateGas")).toBeLessThanOrEqual(1);
        // Heights ride in on receipts, so no operation pays for one.
        expect(node.countOf("eth_blockNumber")).toBeLessThanOrEqual(1);
        // The base fee is read at most once per operation, and shared for a block.
        expect(node.countOf("eth_getBlockByNumber")).toBeLessThanOrEqual(sends);
        // What is left is the send plus the receipt polls it takes to see it land.
        // The run is stopped mid-flight, so the last send may have no poll yet.
        const receiptPolls = node.countOf("eth_getTransactionReceipt");
        expect(receiptPolls).toBeGreaterThanOrEqual(sends - 1);
        expect(receiptPolls).toBeLessThanOrEqual(sends * 3);
        // Nothing else reaches the node.
        expect([...new Set(node.methods)].sort()).toEqual([
          "eth_blockNumber",
          "eth_chainId",
          "eth_estimateGas",
          "eth_fillTransaction",
          "eth_getBalance",
          "eth_getBlockByNumber",
          "eth_getTransactionCount",
          "eth_getTransactionReceipt",
          "eth_sendRawTransaction",
        ]);
      } finally {
        runtime.stop();
        node.stop();
      }
    },
    30_000,
  );
});
