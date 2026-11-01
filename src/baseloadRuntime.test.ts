import type { BaseloadConfig } from "./baseloadConfig";
import { describe, expect, test } from "bun:test";
import { createWalletClient, ENTITY_EVENTS_ABI, ExpirationTime } from "@arkiv-network/sdk";
import { defineChain, encodeAbiParameters, encodeEventTopics, http, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { BaseloadFees } from "./baseloadTaskHelpers";
import {
  BaseloadReceiptTimeoutError,
  BaseloadRuntime,
  baseloadGasShapeKey,
  decodeBaseloadMutationReceipt,
  isBaseloadTransactionReceiptSuccessful,
  learnBaseloadGasLimit,
  pinBaseloadCreateSalts,
  readBaseloadEntityKeysFromSdkResult,
  estimateCurrentBlock,
  readReceiptQuantity,
  sendBaseloadMutation,
  sendWithFeeBumps,
  toSdkMutationParameters,
  type BaseloadMutationParameters,
  type BaseloadPendingTransaction,
  type SendWithFeeBumpsOptions,
} from "./baseloadRuntime";

const TX_HASH = `0x${"aa".repeat(32)}` as `0x${string}`;
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ENTITY_KEY = `0x${"11".repeat(32)}` as `0x${string}`;
const SECOND_ENTITY_KEY = `0x${"22".repeat(32)}` as `0x${string}`;

describe("baseload runtime SDK entity key handling", () => {
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
  const rawTransactions: `0x${string}`[] = [];
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
      const body = (await request.json()) as { id: number; method: string; params?: unknown[] };
      methods.push(body.method);
      if (body.method === "eth_sendRawTransaction") rawTransactions.push(body.params![0] as `0x${string}`);
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
    rawTransactions,
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

describe("baseload replacement calldata", () => {
  async function sendCopies(batch: BaseloadMutationParameters) {
    const rpc = startRecordingRpcServer();
    try {
      for (const [maxFeePerGas, maxPriorityFeePerGas] of [[14n, 2n], [16n, 3n]] as const) {
        await sendBaseloadMutation(
          testWalletClient(rpc.url),
          batch,
          { maxFeePerGas, maxPriorityFeePerGas, nonce: 7, gas: 1_000_000n, chainId: 1 },
          100n,
        );
      }
      return rpc.rawTransactions.map((raw) => parseTransaction(raw));
    } finally {
      rpc.stop();
    }
  }

  test("every copy of a create batch carries the same calldata, only the fees differ", async () => {
    const [first, second] = await sendCopies(pinBaseloadCreateSalts(CREATE_BATCH));

    expect(second!.data).toBe(first!.data!);
    expect(second!.to).toBe(first!.to!);
    expect(second!.nonce).toBe(7);
    expect([first!.maxFeePerGas, first!.maxPriorityFeePerGas]).toEqual([14n, 2n]);
    expect([second!.maxFeePerGas, second!.maxPriorityFeePerGas]).toEqual([16n, 3n]);
  });

  test("a create left to the SDK draws a new key salt on every build", async () => {
    const [first, second] = await sendCopies(CREATE_BATCH);
    expect(second!.data).not.toBe(first!.data!);
  });

  test("pins a salt once and keeps it", () => {
    const pinned = pinBaseloadCreateSalts(CREATE_BATCH);
    expect(typeof pinned.creates![0]!.salt).toBe("bigint");
    expect(pinBaseloadCreateSalts(pinned)).toEqual(pinned);
    const deletes = { deletes: [{ entityKey: ENTITY_KEY }] };
    expect(pinBaseloadCreateSalts(deletes)).toBe(deletes);
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
function startFakeNode(options: { entitiesPerBatch: number; baseFeePerGas?: string; failReceiptPolls?: number }) {
  const methods: string[] = [];
  let failedReceiptPolls = 0;
  const rawTransactions: `0x${string}`[] = [];
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
          return reply({ number: "0x64", baseFeePerGas: options.baseFeePerGas ?? "0x1" });
        case "eth_getBalance":
          return reply("0x56bc75e2d63100000");
        case "eth_getTransactionCount":
          return reply("0x7");
        case "eth_estimateGas":
          return reply("0x1e8480");
        case "eth_sendRawTransaction":
          rawTransactions.push((body as unknown as { params: `0x${string}`[] }).params[0]!);
          sentTransactions += 1;
          return reply(txHashForSend(sentTransactions));
        case "eth_getTransactionReceipt": {
          if (failedReceiptPolls < (options.failReceiptPolls ?? 0)) {
            failedReceiptPolls += 1;
            return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
          }
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
    rawTransactions,
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

describe("baseload live config persistence", () => {
  test("hands every applied config to the persist hook", async () => {
    const persisted: BaseloadConfig[] = [];
    const runtime = new BaseloadRuntime(
      { rpcUrl: null, mnemonic: TEST_MNEMONIC },
      { persistConfig: (config) => { persisted.push(config); } },
    );
    try {
      runtime.updateConfig({ workers: [{ walletNumber: 3, behavior: "create" }] });
      runtime.updateConfig({ workers: [] });
      await Promise.resolve();
      expect(persisted.map((config) => config.workers.map((worker) => worker.walletNumber))).toEqual([[3], []]);
    } finally {
      runtime.stop();
    }
  });
});

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

describe("baseload receipt poll failures", () => {
  test(
    "keep waiting on the sent transaction instead of resending its nonce",
    async () => {
      // The first three receipt polls are refused with a 429.
      const node = startFakeNode({ entitiesPerBatch: 1, failReceiptPolls: 3 });
      const runtime = new BaseloadRuntime({
        rpcUrl: node.url,
        mnemonic: TEST_MNEMONIC,
        payloadProvider: null,
        faucet: null,
        rpcKeys: null,
      });
      let sawError = false;
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
        const deadline = Date.now() + 20_000;
        while (node.rawTransactions.length < 2 && Date.now() < deadline) {
          if (Object.values(runtime.getState().statuses).some((status) => status.status === "error")) {
            sawError = true;
          }
          await Bun.sleep(50);
        }
        runtime.stop();

        expect(node.countOf("eth_getTransactionReceipt")).toBeGreaterThanOrEqual(4);
        // The first batch outlived the failed polls and landed; the next batch
        // went out with the next nonce rather than as a second try at the first.
        expect(node.rawTransactions.slice(0, 2).map((raw) => parseTransaction(raw).nonce)).toEqual([7, 8]);
        // The worker never fell into its failure path, which re-reads the nonce.
        expect(node.countOf("eth_getTransactionCount")).toBe(1);
        expect(sawError).toBe(false);
      } finally {
        runtime.stop();
        node.stop();
      }
    },
    30_000,
  );
});

describe("baseload first-send fees", () => {
  async function firstSentFees(maxGasPriceGwei: number) {
    // 1 gwei base fee.
    const node = startFakeNode({ entitiesPerBatch: 1, baseFeePerGas: "0x3b9aca00" });
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
            maxGasPriceGwei,
          },
        ],
      });
      const deadline = Date.now() + 15_000;
      while (node.rawTransactions.length < 1 && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      const transaction = parseTransaction(node.rawTransactions[0]!);
      return { maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas };
    } finally {
      runtime.stop();
      node.stop();
    }
  }

  test(
    "offers twice the base fee and the minimal tip, not the worker's cap",
    async () => {
      expect(await firstSentFees(1000)).toEqual({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 2n });
    },
    20_000,
  );

  test(
    "never offers more than the worker's cap",
    async () => {
      expect(await firstSentFees(1.5)).toEqual({ maxFeePerGas: 1_500_000_000n, maxPriorityFeePerGas: 2n });
    },
    20_000,
  );
});

/**
 * A scripted node for {@link sendWithFeeBumps}. A receipt wait passes stall
 * checks 20s apart, with no real time passing, until the caller gives up or one
 * of the waited-for hashes has a receipt; `atStallCheck` lets a test change the
 * chain between checks.
 */
function startFeeBumpNode(options: {
  nonce?: number;
  atStallCheck?: (check: number, node: FeeBumpNode) => void;
  refuseSend?: (index: number) => boolean;
  failReceiptLookups?: number;
}) {
  const node = {
    latestNonce: options.nonce ?? 7,
    receipts: new Map<string, Record<string, unknown>>(),
    sentFees: [] as BaseloadFees[],
    sentHashes: [] as `0x${string}`[],
    stallChecks: 0,
    pendingSeen: [] as BaseloadPendingTransaction[],
    replacementFailures: 0,
    failedReceiptLookups: 0,
    mine(txHash: `0x${string}`, status = "0x1") {
      node.receipts.set(txHash, { status, transactionHash: txHash });
      node.latestNonce += 1;
    },
  };
  const rpc: SendWithFeeBumpsOptions["rpc"] = {
    getLatestNonce: async () => node.latestNonce,
    getTransactionReceipt: async (txHash) => {
      if (node.failedReceiptLookups < (options.failReceiptLookups ?? 0)) {
        node.failedReceiptLookups += 1;
        throw new Error("RPC eth_getTransactionReceipt failed with HTTP 429");
      }
      return node.receipts.get(txHash) ?? null;
    },
    waitForTransactionReceipt: async (txHashes, _signal, onStall) => {
      for (let elapsedMs = 20_000; ; elapsedMs += 20_000) {
        for (const txHash of txHashes) {
          const receipt = node.receipts.get(txHash);
          if (receipt) return { txHash, receipt };
        }
        node.stallChecks += 1;
        if (node.stallChecks > 500) throw new Error("the wait never ended");
        options.atStallCheck?.(node.stallChecks, node);
        if (onStall && !(await onStall(elapsedMs))) {
          throw new BaseloadReceiptTimeoutError(txHashes[txHashes.length - 1]!, elapsedMs);
        }
      }
    },
  };
  const send = async (fees: BaseloadFees) => {
    const index = node.sentFees.length;
    node.sentFees.push(fees);
    if (options.refuseSend?.(index)) throw new Error("replacement refused");
    const txHash = txHashForSend(index + 1) as `0x${string}`;
    node.sentHashes.push(txHash);
    return txHash;
  };
  return { node, rpc, send };
}

type FeeBumpNode = ReturnType<typeof startFeeBumpNode>["node"];

/** The worker's own stall policy: give a copy up after 60s, unless no bump is left. */
function workerLikeStall(node: FeeBumpNode) {
  return async (elapsedMs: number, pending: BaseloadPendingTransaction) => {
    node.pendingSeen.push(pending);
    return pending.bumpsExhausted || elapsedMs < 60_000;
  };
}

function runFeeBumps(
  harness: ReturnType<typeof startFeeBumpNode>,
  overrides: Partial<SendWithFeeBumpsOptions> = {},
) {
  return sendWithFeeBumps({
    rpc: harness.rpc,
    address: "0x0000000000000000000000000000000000000001",
    nonce: 7,
    fees: { maxFeePerGas: 14n, maxPriorityFeePerGas: 2n },
    maxFeeCapWei: 1_000_000_000_000n,
    send: harness.send,
    signal: new AbortController().signal,
    onStall: workerLikeStall(harness.node),
    onReplacementFailed: () => {
      harness.node.replacementFailures += 1;
    },
    ...overrides,
  });
}

describe("baseload fee-bumped replacements", () => {
  test("replaces a stuck transaction twice with bumped fees, then only waits", async () => {
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 40) node.mine(node.sentHashes[2]!);
      },
    });
    // A caller that would give every copy up at once still gets two bumps only.
    const landed = await runFeeBumps(harness, {
      onStall: async (_elapsedMs, pending) => {
        harness.node.pendingSeen.push(pending);
        return false;
      },
    });

    expect(harness.node.sentFees).toEqual([
      { maxFeePerGas: 14n, maxPriorityFeePerGas: 2n },
      { maxFeePerGas: 16n, maxPriorityFeePerGas: 3n },
      { maxFeePerGas: 18n, maxPriorityFeePerGas: 4n },
    ]);
    expect(landed.txHash).toBe(harness.node.sentHashes[2]!);
    // Every stall check after the second bump timed out was only a wait.
    const waits = harness.node.pendingSeen.slice(3);
    expect(waits.length).toBeGreaterThan(30);
    for (const pending of waits) {
      expect(pending).toMatchObject({ feeBumps: 2, bumpsExhausted: true, txHash: harness.node.sentHashes[2]! });
    }
  });

  test("bumps only after each copy has waited out the timeout", async () => {
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 12) node.mine(node.sentHashes[2]!);
      },
    });
    await runFeeBumps(harness);

    // Three checks per copy (20s, 40s, 60s), the third giving it up.
    expect(harness.node.pendingSeen.map((pending) => [pending.feeBumps, pending.bumpsExhausted])).toEqual([
      [0, false], [0, false], [0, false],
      [1, false], [1, false], [1, false],
      [2, false], [2, false], [2, false],
      [2, true], [2, true],
    ]);
    expect(harness.node.sentFees).toHaveLength(3);
  });

  test("completes when the original transaction, not its replacement, is mined", async () => {
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 4) node.mine(node.sentHashes[0]!);
      },
    });
    const landed = await runFeeBumps(harness);

    expect(harness.node.sentHashes).toHaveLength(2);
    expect(landed).toEqual({
      txHash: harness.node.sentHashes[0]!,
      receipt: { status: "0x1", transactionHash: harness.node.sentHashes[0]! },
    });
  });

  test("does not bump a nonce that one of its copies has already spent", async () => {
    // Mined right before the check that would give the copy up.
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 3) node.mine(node.sentHashes[0]!);
      },
    });
    const landed = await runFeeBumps(harness, {
      onStall: async (elapsedMs) => elapsedMs < 60_000,
    });

    expect(harness.node.sentHashes).toHaveLength(1);
    expect(landed.txHash).toBe(harness.node.sentHashes[0]!);
  });

  test("gives the nonce up when a transaction it never sent spends it", async () => {
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 15) node.latestNonce += 1;
      },
    });

    await expect(runFeeBumps(harness)).rejects.toThrow(/Nonce 7 was spent by none of/);
    expect(harness.node.sentFees).toHaveLength(3);
  });

  test("stops bumping where the worker's cap leaves no room to replace", async () => {
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 6) node.mine(node.sentHashes[0]!);
      },
    });
    await runFeeBumps(harness, {
      fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 2n },
      maxFeeCapWei: 1_000n,
    });

    expect(harness.node.sentFees).toHaveLength(1);
    expect(harness.node.pendingSeen.at(-1)).toMatchObject({ feeBumps: 0, bumpsExhausted: true });
  });

  test("keeps waiting on the copies already sent when a replacement is refused", async () => {
    const harness = startFeeBumpNode({
      refuseSend: (index) => index === 1,
      atStallCheck: (check, node) => {
        if (check === 8) node.mine(node.sentHashes[0]!);
      },
    });
    const landed = await runFeeBumps(harness);

    expect(harness.node.replacementFailures).toBe(1);
    // The second bump climbs from the refused one's fees: it may have landed in the pool.
    expect(harness.node.sentFees).toEqual([
      { maxFeePerGas: 14n, maxPriorityFeePerGas: 2n },
      { maxFeePerGas: 16n, maxPriorityFeePerGas: 3n },
      { maxFeePerGas: 18n, maxPriorityFeePerGas: 4n },
    ]);
    expect(landed.txHash).toBe(harness.node.sentHashes[0]!);
  });

  test("neither bumps nor gives up a spent nonce whose receipt lookup failed", async () => {
    const harness = startFeeBumpNode({
      failReceiptLookups: 1,
      atStallCheck: (check, node) => {
        if (check === 3) node.mine(node.sentHashes[0]!);
      },
    });
    const landed = await runFeeBumps(harness);

    expect(harness.node.failedReceiptLookups).toBe(1);
    expect(harness.node.sentHashes).toHaveLength(1);
    expect(landed.txHash).toBe(harness.node.sentHashes[0]!);
  });

  test("sends no replacement once the worker is stopped", async () => {
    const controller = new AbortController();
    const harness = startFeeBumpNode({
      atStallCheck: (check) => {
        if (check === 3) controller.abort();
      },
    });

    await expect(runFeeBumps(harness, { signal: controller.signal })).rejects.toThrow(/Task stopped/);
    expect(harness.node.sentFees).toHaveLength(1);
  });

  test("reports a mined copy that reverted", async () => {
    const harness = startFeeBumpNode({
      atStallCheck: (check, node) => {
        if (check === 4) node.mine(node.sentHashes[1]!, "0x0");
      },
    });

    await expect(runFeeBumps(harness)).rejects.toThrow(/was mined but reverted/);
  });
});
