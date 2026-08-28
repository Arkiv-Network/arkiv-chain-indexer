import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHODS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR,
  handleJsonRpcBody,
  handleJsonRpcText,
  quantity,
  type JsonRpcDataSource,
  type JsonRpcResponse,
} from "./jsonRpc";
import { createBlockServer, type HealthResponseBody } from "./server";
import type {
  BlockQueryFilter,
  PriorityFeeSample,
  ScannerProgress,
  ScannerStorage,
  StoredBlock,
  StoredTransaction,
} from "./storage";
import type { InspectedTransaction } from "./blockInspector";
import type { BlockMetrics } from "./types";
import { closeTestPools, createIsolatedStorage, hasPostgresForTests } from "./testPostgres";

// ---------------------------------------------------------------------------
// In-memory data source

interface FakeChain {
  chainId?: bigint;
  progress?: ScannerProgress;
  blocks?: StoredBlock[];
  transactions?: StoredTransaction[];
}

function fakeBlock(overrides: Partial<StoredBlock> & { blockNumber: number }): StoredBlock {
  return {
    blockDate: new Date(1_700_000_000_000 + overrides.blockNumber * 2000).toISOString(),
    blockTimeSeconds: "2",
    baseBlockFeeWei: "1000",
    totalGasUsed: "0",
    maxGasInBlock: "30000000",
    transactionCount: 0,
    averageFeePriceWei: "0",
    averageTransactionFeeWei: "0",
    averageTransactionGasUsed: "0",
    averagePriorityFeeWeightedWei: "0",
    averagePriorityFeeWei: "0",
    ...overrides,
  };
}

function fakeTransaction(
  overrides: Partial<StoredTransaction> & { blockNumber: number; position: number },
): StoredTransaction {
  const hashSeed = `${overrides.blockNumber}-${overrides.position}`;
  return {
    blockNumberDecimal: String(overrides.blockNumber),
    blockDate: "2024-01-01T00:00:00.000Z",
    baseBlockFeeWei: "1000",
    hash: `0x${hashSeed.replace(/\D/g, "").padEnd(64, "a").slice(0, 64)}`,
    from: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    to: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
    type: "2",
    nonce: "7",
    valueWei: "0",
    gasLimit: "100000",
    gasUsed: "21000",
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
    cumulativeGasUsed: "21000",
    gasPriceWei: "1010",
    maxFeePerGasWei: "2000",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "1010",
    priorityFeeWei: "10",
    transactionFeeWei: "21210000",
    status: "1",
    contractAddress: null,
    ...overrides,
  };
}

function fakeSource(chain: FakeChain): JsonRpcDataSource {
  const blocks = [...(chain.blocks ?? [])].sort((a, b) => a.blockNumber - b.blockNumber);
  const transactions = chain.transactions ?? [];
  const progress: ScannerProgress = chain.progress ?? {
    ...(blocks.length > 0 ? { lastSuccessfulBlock: BigInt(blocks[blocks.length - 1]!.blockNumber) } : {}),
  };
  return {
    getChainId: async () => chain.chainId,
    getScannerProgress: async () => progress,
    getForwardScanSamples: async () => [],
    getMinStoredBlock: async () => (blocks[0] ? BigInt(blocks[0].blockNumber) : undefined),
    getBlockByNumber: async (blockNumber) => blocks.find((block) => BigInt(block.blockNumber) === blockNumber),
    queryBlocks: async (filter: BlockQueryFilter) =>
      blocks
        .filter(
          (block) =>
            (filter.blockGt === undefined || BigInt(block.blockNumber) > filter.blockGt) &&
            (filter.blockLt === undefined || BigInt(block.blockNumber) < filter.blockLt),
        )
        .slice(0, filter.limit ?? blocks.length),
    getTransactionsForBlock: async (blockNumber) =>
      transactions
        .filter((tx) => BigInt(tx.blockNumber) === blockNumber)
        .sort((a, b) => a.position - b.position),
    getTransactionByHash: async (hash) =>
      transactions.find((tx) => tx.hash.toLowerCase() === hash.toLowerCase()) ?? null,
    getTransactionByBlockAndPosition: async (blockNumber, position) =>
      transactions.find((tx) => BigInt(tx.blockNumber) === blockNumber && tx.position === position) ?? null,
    getSentTransactionCount: async (address, upToBlock) => {
      const nonces = transactions
        .filter(
          (tx) =>
            tx.from?.toLowerCase() === address.toLowerCase() &&
            (upToBlock === undefined || BigInt(tx.blockNumber) <= upToBlock) &&
            tx.nonce !== null,
        )
        .map((tx) => BigInt(tx.nonce!));
      return nonces.length === 0 ? 0n : nonces.reduce((a, b) => (a > b ? a : b)) + 1n;
    },
    getPriorityFeeSamples: async (fromBlock, toBlock): Promise<PriorityFeeSample[]> =>
      transactions
        .filter((tx) => BigInt(tx.blockNumber) >= fromBlock && BigInt(tx.blockNumber) <= toBlock)
        .sort(
          (a, b) =>
            a.blockNumber - b.blockNumber ||
            Number(BigInt(a.priorityFeeWei) - BigInt(b.priorityFeeWei)) ||
            a.position - b.position,
        )
        .map((tx) => ({
          blockNumber: BigInt(tx.blockNumber),
          priorityFeeWei: BigInt(tx.priorityFeeWei),
          gasUsed: BigInt(tx.gasUsed),
        })),
    getMinPriorityFeePerBlock: async (fromBlock, toBlock) => {
      const mins = new Map<bigint, bigint>();
      for (const tx of transactions) {
        const block = BigInt(tx.blockNumber);
        if (block < fromBlock || block > toBlock) continue;
        const fee = BigInt(tx.priorityFeeWei);
        const current = mins.get(block);
        if (current === undefined || fee < current) mins.set(block, fee);
      }
      return [...mins.entries()]
        .sort((a, b) => Number(a[0] - b[0]))
        .map(([blockNumber, minPriorityFeeWei]) => ({ blockNumber, minPriorityFeeWei }));
    },
  };
}

async function call(
  source: JsonRpcDataSource,
  method: string,
  params: unknown[] = [],
  options: Parameters<typeof handleJsonRpcBody>[2] = {},
): Promise<JsonRpcResponse> {
  const response = await handleJsonRpcBody({ jsonrpc: "2.0", id: 1, method, params }, source, options);
  if (Array.isArray(response)) throw new Error("expected a single response");
  return response;
}

async function result(source: JsonRpcDataSource, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await call(source, method, params);
  if (response.error) throw new Error(`${method} failed: ${response.error.message}`);
  return response.result;
}

// ---------------------------------------------------------------------------

describe("JSON-RPC envelope", () => {
  const source = fakeSource({ chainId: 1337n });

  test("parse errors come back as -32700 with a null id", async () => {
    const response = await handleJsonRpcText("{not json", source);
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" },
    });
  });

  test("non-object requests are invalid", async () => {
    const response = await handleJsonRpcBody("eth_chainId", source);
    expect((response as JsonRpcResponse).error?.code).toBe(JSON_RPC_INVALID_REQUEST);
  });

  test("unknown methods return -32601 and echo the id", async () => {
    const response = await call(source, "eth_sendRawTransaction", ["0x00"]);
    expect(response.id).toBe(1);
    expect(response.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
  });

  test("named params are rejected", async () => {
    const response = await handleJsonRpcBody(
      { jsonrpc: "2.0", id: "a", method: "eth_chainId", params: { x: 1 } },
      source,
    );
    expect((response as JsonRpcResponse).error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("string ids and missing params are preserved / defaulted", async () => {
    const response = (await handleJsonRpcBody(
      { jsonrpc: "2.0", id: "abc", method: "eth_chainId" },
      source,
    )) as JsonRpcResponse;
    expect(response).toEqual({ jsonrpc: "2.0", id: "abc", result: "0x539" });
  });

  test("batches are answered in order, mixing results and errors", async () => {
    const response = await handleJsonRpcBody(
      [
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "nope", params: [] },
        "garbage",
      ],
      source,
    );
    expect(Array.isArray(response)).toBe(true);
    const batch = response as JsonRpcResponse[];
    expect(batch.map((entry) => entry.id)).toEqual([1, 2, null]);
    expect(batch[0]!.result).toBe("0x539");
    expect(batch[1]!.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    expect(batch[2]!.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
  });

  test("empty and oversized batches are rejected", async () => {
    const empty = (await handleJsonRpcBody([], source)) as JsonRpcResponse;
    expect(empty.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
    const big = (await handleJsonRpcBody(
      Array.from({ length: 3 }, (_, id) => ({ jsonrpc: "2.0", id, method: "eth_chainId" })),
      source,
      { maxBatchSize: 2 },
    )) as JsonRpcResponse;
    expect(big.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
  });

  test("wrong parameter counts are invalid params", async () => {
    const response = await call(source, "eth_chainId", ["extra"]);
    expect(response.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("every advertised method is dispatchable", async () => {
    for (const method of JSON_RPC_METHODS) {
      const response = await call(source, method, []);
      expect(response.error?.code).not.toBe(JSON_RPC_METHOD_NOT_FOUND);
    }
  });
});

describe("identity and constant methods", () => {
  test("chain id, net_version and constants", async () => {
    const source = fakeSource({ chainId: 1337n });
    expect(await result(source, "eth_chainId")).toBe("0x539");
    expect(await result(source, "net_version")).toBe("1337");
    expect(await result(source, "net_listening")).toBe(true);
    expect(await result(source, "eth_accounts")).toEqual([]);
    expect(await result(source, "eth_mining")).toBe(false);
    expect(await result(source, "eth_hashrate")).toBe("0x0");
    expect(await result(source, "web3_clientVersion")).toBe("arkiv-chain-indexer");
    const custom = await call(source, "web3_clientVersion", [], { clientVersion: "x/1" });
    expect(custom.result).toBe("x/1");
  });

  test("chain id unknown until the scanner stores it", async () => {
    const response = await call(fakeSource({}), "eth_chainId");
    expect(response.error?.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(response.error?.message).toContain("Chain id unknown");
  });

  test("quantity encoding is minimal hex", () => {
    expect(quantity(0n)).toBe("0x0");
    expect(quantity(255n)).toBe("0xff");
    expect(quantity(4096n)).toBe("0x1000");
    expect(() => quantity(-1n)).toThrow();
  });
});

describe("eth_blockNumber and eth_syncing", () => {
  test("block number is the indexed head, 0x0 on an empty database", async () => {
    expect(await result(fakeSource({}), "eth_blockNumber")).toBe("0x0");
    const source = fakeSource({ blocks: [fakeBlock({ blockNumber: 5 }), fakeBlock({ blockNumber: 42 })] });
    expect(await result(source, "eth_blockNumber")).toBe("0x2a");
  });

  test("synced when within a few blocks of the observed head", async () => {
    const source = fakeSource({
      blocks: [fakeBlock({ blockNumber: 100 })],
      progress: {
        lastSuccessfulBlock: 100n,
        latestObservedBlock: 101n,
        latestObservedAt: new Date().toISOString(),
      },
    });
    expect(await result(source, "eth_syncing")).toBe(false);
  });

  test("reports the gap while catching up", async () => {
    const source = fakeSource({
      blocks: [fakeBlock({ blockNumber: 10 }), fakeBlock({ blockNumber: 100 })],
      progress: {
        lastSuccessfulBlock: 100n,
        latestObservedBlock: 5000n,
        latestObservedAt: new Date().toISOString(),
      },
    });
    expect(await result(source, "eth_syncing")).toEqual({
      startingBlock: "0xa",
      currentBlock: "0x64",
      highestBlock: "0x1388",
    });
  });

  test("unknown head reads as not syncing", async () => {
    expect(await result(fakeSource({}), "eth_syncing")).toBe(false);
  });
});

describe("block tags", () => {
  const source = fakeSource({
    blocks: [fakeBlock({ blockNumber: 3, transactionCount: 2 }), fakeBlock({ blockNumber: 9, transactionCount: 4 })],
  });

  test("latest-family tags resolve to the indexed head, earliest to the first stored block", async () => {
    for (const tag of ["latest", "pending", "safe", "finalized"]) {
      expect(await result(source, "eth_getBlockTransactionCountByNumber", [tag])).toBe("0x4");
    }
    expect(await result(source, "eth_getBlockTransactionCountByNumber", ["earliest"])).toBe("0x2");
    expect(await result(source, "eth_getBlockTransactionCountByNumber", ["0x3"])).toBe("0x2");
    expect(await result(source, "eth_getBlockTransactionCountByNumber", [{ blockNumber: "0x9" }])).toBe("0x4");
  });

  test("unstored blocks are null, malformed tags are invalid params", async () => {
    expect(await result(source, "eth_getBlockTransactionCountByNumber", ["0x5"])).toBeNull();
    expect(await result(source, "eth_getBlockTransactionCountByNumber", ["0x1000"])).toBeNull();
    for (const bad of ["12", "0x", "0x0g", "newest", 3.5, { blockTag: "x" }]) {
      const response = await call(source, "eth_getBlockTransactionCountByNumber", [bad]);
      expect(response.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    }
  });

  test("block-hash addressing is a clear server error", async () => {
    const hash = `0x${"1".repeat(64)}`;
    for (const [method, params] of [
      ["eth_getBlockByHash", [hash, false]],
      ["eth_getBlockTransactionCountByHash", [hash]],
      ["eth_getTransactionByBlockHashAndIndex", [hash, "0x0"]],
      ["eth_getBlockTransactionCountByNumber", [{ blockHash: hash }]],
    ] as const) {
      const response = await call(source, method, [...params]);
      expect(response.error?.code).toBe(JSON_RPC_SERVER_ERROR);
      expect(response.error?.message).toContain("not indexed");
    }
    const malformed = await call(source, "eth_getBlockByHash", ["0x12", false]);
    expect(malformed.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("uncles never exist", async () => {
    const hash = `0x${"2".repeat(64)}`;
    expect(await result(source, "eth_getUncleCountByBlockNumber", ["latest"])).toBe("0x0");
    expect(await result(source, "eth_getUncleCountByBlockNumber", ["0x5"])).toBeNull();
    expect(await result(source, "eth_getUncleCountByBlockHash", [hash])).toBe("0x0");
    expect(await result(source, "eth_getUncleByBlockNumberAndIndex", ["latest", "0x0"])).toBeNull();
    expect(await result(source, "eth_getUncleByBlockHashAndIndex", [hash, "0x0"])).toBeNull();
  });
});

describe("eth_getTransactionCount", () => {
  const sender = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
  const source = fakeSource({
    blocks: [fakeBlock({ blockNumber: 1 }), fakeBlock({ blockNumber: 2 }), fakeBlock({ blockNumber: 3 })],
    transactions: [
      fakeTransaction({ blockNumber: 1, position: 0, nonce: "0" }),
      fakeTransaction({ blockNumber: 1, position: 1, nonce: "1" }),
      fakeTransaction({ blockNumber: 3, position: 0, nonce: "2" }),
    ],
  });

  test("is the highest stored nonce plus one, at latest or a given block", async () => {
    expect(await result(source, "eth_getTransactionCount", [sender])).toBe("0x3");
    expect(await result(source, "eth_getTransactionCount", [sender.toLowerCase(), "latest"])).toBe("0x3");
    expect(await result(source, "eth_getTransactionCount", [sender, "0x1"])).toBe("0x2");
    expect(await result(source, "eth_getTransactionCount", [sender, "0x2"])).toBe("0x2");
    expect(await result(source, "eth_getTransactionCount", [sender, "earliest"])).toBe("0x0");
  });

  test("unknown senders have sent nothing; bad addresses are rejected", async () => {
    expect(await result(source, "eth_getTransactionCount", [`0x${"c".repeat(40)}`])).toBe("0x0");
    const response = await call(source, "eth_getTransactionCount", ["0x1234"]);
    expect(response.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });
});

describe("blocks, transactions and receipts", () => {
  const txA = fakeTransaction({
    blockNumber: 7,
    position: 0,
    hash: `0x${"a".repeat(64)}`,
    contractAddress: "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc",
  });
  const txB = fakeTransaction({
    blockNumber: 7,
    position: 2, // position 1 was the filtered system transaction
    hash: `0x${"b".repeat(64)}`,
    type: "0",
    maxFeePerGasWei: null,
    maxPriorityFeePerGasWei: null,
    gasPriceWei: "1500",
    status: "0",
  });
  const source = fakeSource({
    chainId: 1337n,
    blocks: [
      fakeBlock({
        blockNumber: 7,
        blockDate: "2024-05-01T00:00:00.000Z",
        baseBlockFeeWei: "1000",
        totalGasUsed: "42000",
        maxGasInBlock: "30000000",
        transactionCount: 2,
      }),
    ],
    transactions: [txA, txB],
  });

  test("eth_getBlockByNumber lists hashes or full objects and nulls unknown header fields", async () => {
    const block = (await result(source, "eth_getBlockByNumber", ["0x7", false])) as Record<string, unknown>;
    expect(block).toMatchObject({
      number: "0x7",
      hash: null,
      parentHash: null,
      miner: null,
      stateRoot: null,
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0xa410",
      timestamp: quantity(BigInt(Date.parse("2024-05-01T00:00:00.000Z") / 1000)),
      baseFeePerGas: "0x3e8",
      uncles: [],
    });
    expect(block.transactions).toEqual([txA.hash, txB.hash]);

    const full = (await result(source, "eth_getBlockByNumber", ["latest", true])) as Record<string, unknown>;
    const transactions = full.transactions as Array<Record<string, unknown>>;
    expect(transactions.map((tx) => tx.hash)).toEqual([txA.hash, txB.hash]);
    expect(transactions[0]).toMatchObject({ transactionIndex: "0x0", chainId: "0x539" });
    expect(transactions[1]).toMatchObject({ transactionIndex: "0x2" });

    expect(await result(source, "eth_getBlockByNumber", ["0x8", false])).toBeNull();
    const defaulted = (await result(source, "eth_getBlockByNumber", ["0x7"])) as Record<string, unknown>;
    expect(defaulted.transactions).toEqual([txA.hash, txB.hash]);
    const bad = await call(source, "eth_getBlockByNumber", ["0x7", "yes"]);
    expect(bad.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("eth_getTransactionByHash maps stored fields and nulls the rest", async () => {
    const tx = (await result(source, "eth_getTransactionByHash", [txA.hash])) as Record<string, unknown>;
    expect(tx).toEqual({
      hash: txA.hash,
      blockHash: null,
      blockNumber: "0x7",
      transactionIndex: "0x0",
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      nonce: "0x7",
      value: "0x0",
      gas: "0x186a0",
      gasPrice: "0x3f2",
      maxFeePerGas: "0x7d0",
      maxPriorityFeePerGas: "0xa",
      type: "0x2",
      input: null,
      chainId: "0x539",
      v: null,
      r: null,
      s: null,
    });

    const legacy = (await result(source, "eth_getTransactionByHash", [txB.hash.toUpperCase().replace("0X", "0x")])) as Record<
      string,
      unknown
    >;
    expect(legacy.type).toBe("0x0");
    expect(legacy.gasPrice).toBe("0x5dc");
    expect("maxFeePerGas" in legacy).toBe(false);

    expect(await result(source, "eth_getTransactionByHash", [`0x${"f".repeat(64)}`])).toBeNull();
    const bad = await call(source, "eth_getTransactionByHash", ["0xabc"]);
    expect(bad.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("eth_getTransactionByBlockNumberAndIndex uses the original position", async () => {
    const tx = (await result(source, "eth_getTransactionByBlockNumberAndIndex", ["0x7", "0x2"])) as Record<
      string,
      unknown
    >;
    expect(tx.hash).toBe(txB.hash);
    expect(await result(source, "eth_getTransactionByBlockNumberAndIndex", ["0x7", "0x1"])).toBeNull();
    expect(await result(source, "eth_getTransactionByBlockNumberAndIndex", ["0x9", "0x0"])).toBeNull();
  });

  test("eth_getTransactionReceipt maps receipt fields and nulls logs", async () => {
    const receipt = (await result(source, "eth_getTransactionReceipt", [txA.hash])) as Record<string, unknown>;
    expect(receipt).toEqual({
      transactionHash: txA.hash,
      transactionIndex: "0x0",
      blockHash: null,
      blockNumber: "0x7",
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3f2",
      contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      logs: null,
      logsBloom: null,
      status: "0x1",
      type: "0x2",
    });
    const failed = (await result(source, "eth_getTransactionReceipt", [txB.hash])) as Record<string, unknown>;
    expect(failed.status).toBe("0x0");
    expect(await result(source, "eth_getTransactionReceipt", [`0x${"f".repeat(64)}`])).toBeNull();
  });

  test("transaction methods honour the transaction-data gate", async () => {
    const gated = await call(source, "eth_getTransactionByHash", [txA.hash], { transactionDataEnabled: false });
    expect(gated.error?.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(gated.error?.message).toContain("transaction data is disabled");
    const open = await call(source, "eth_chainId", [], { transactionDataEnabled: false });
    expect(open.result).toBe("0x539");
  });
});

describe("fee methods", () => {
  // Three blocks: 10 has tips 5/20/50 (gas 30k/50k/20k), 11 is empty, 12 has a single tip 8.
  const source = fakeSource({
    blocks: [
      fakeBlock({ blockNumber: 10, baseBlockFeeWei: "100", totalGasUsed: "100000", maxGasInBlock: "200000" }),
      fakeBlock({ blockNumber: 11, baseBlockFeeWei: "110", totalGasUsed: "0", maxGasInBlock: "200000" }),
      fakeBlock({ blockNumber: 12, baseBlockFeeWei: "120", totalGasUsed: "50000", maxGasInBlock: "200000" }),
      fakeBlock({ blockNumber: 13, baseBlockFeeWei: "130", totalGasUsed: "0", maxGasInBlock: "200000" }),
    ],
    transactions: [
      fakeTransaction({ blockNumber: 10, position: 0, priorityFeeWei: "50", gasUsed: "20000" }),
      fakeTransaction({ blockNumber: 10, position: 1, priorityFeeWei: "5", gasUsed: "30000" }),
      fakeTransaction({ blockNumber: 10, position: 2, priorityFeeWei: "20", gasUsed: "50000" }),
      fakeTransaction({ blockNumber: 12, position: 0, priorityFeeWei: "8", gasUsed: "50000" }),
    ],
  });

  test("eth_feeHistory walks gas-weighted percentiles like geth", async () => {
    const history = (await result(source, "eth_feeHistory", ["0x3", "0xc", [10, 50, 90]])) as Record<string, unknown>;
    expect(history.oldestBlock).toBe("0xa");
    // count+1 base fees; the block after 0xc is stored, so its fee closes the array.
    expect(history.baseFeePerGas).toEqual(["0x64", "0x6e", "0x78", "0x82"]);
    expect(history.gasUsedRatio).toEqual([0.5, 0, 0.25]);
    // Block 10 sorted by tip: (5, 30k) (20, 50k) (50, 20k) over 100k gas used.
    // 10% → 10k ≤ 30k → tip 5; 50% → 50k > 30k → 80k → tip 20; 90% → 90k > 80k → tip 50.
    expect(history.reward).toEqual([
      ["0x5", "0x14", "0x32"],
      ["0x0", "0x0", "0x0"],
      ["0x8", "0x8", "0x8"],
    ]);
  });

  test("eth_feeHistory omits reward without percentiles and repeats the newest base fee at the tip", async () => {
    const history = (await result(source, "eth_feeHistory", ["0x2", "latest"])) as Record<string, unknown>;
    expect(history.oldestBlock).toBe("0xc");
    expect(history.baseFeePerGas).toEqual(["0x78", "0x82", "0x82"]);
    expect("reward" in history).toBe(false);
  });

  test("eth_feeHistory clamps to stored blocks and validates params", async () => {
    const history = (await result(source, "eth_feeHistory", [100, "0xb", []])) as Record<string, unknown>;
    expect(history.oldestBlock).toBe("0xa");
    expect((history.baseFeePerGas as string[]).length).toBe(3);
    expect(history.reward).toEqual([[], []]);

    const beyond = (await result(source, "eth_feeHistory", ["0x2", "0x64"])) as Record<string, unknown>;
    expect(beyond).toEqual({ oldestBlock: "0x0", baseFeePerGas: [], gasUsedRatio: [] });

    for (const params of [
      ["0x0", "latest"],
      ["0x1", "latest", [50, 10]],
      ["0x1", "latest", [101]],
      ["0x1", "latest", ["50"]],
      ["0x1"],
    ]) {
      const response = await call(source, "eth_feeHistory", params);
      expect(response.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    }
  });

  test("eth_maxPriorityFeePerGas takes the 60th percentile of per-block minimum tips", async () => {
    // Minimum tips over the window: block 10 → 5, block 12 → 8. Sorted [5, 8]; index floor(1*0.6)=0 → 5.
    expect(await result(source, "eth_maxPriorityFeePerGas")).toBe("0x5");
    // eth_gasPrice = latest base fee (130) + suggested tip (5).
    expect(await result(source, "eth_gasPrice")).toBe("0x87");
  });

  test("fee oracle is zero on an empty chain", async () => {
    const empty = fakeSource({});
    expect(await result(empty, "eth_maxPriorityFeePerGas")).toBe("0x0");
    expect(await result(empty, "eth_gasPrice")).toBe("0x0");
    expect(await result(empty, "eth_feeHistory", ["0x1", "latest", [50]])).toEqual({
      oldestBlock: "0x0",
      baseFeePerGas: [],
      gasUsedRatio: [],
      reward: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Postgres-backed: storage queries plus the HTTP route

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

afterAll(async () => {
  await closeTestPools();
});

function blockMetricsFixture(overrides: Partial<BlockMetrics> & { blockNumber: bigint }): BlockMetrics {
  return {
    blockDate: new Date(1_700_000_000_000 + Number(overrides.blockNumber) * 2000).toISOString(),
    blockTimeSeconds: "2",
    baseBlockFeeWei: "100",
    totalGasUsed: "0",
    totalInputDataSizeBytes: "0",
    totalInputDataCompressedSizeBytes: "0",
    maxGasInBlock: "30000000",
    transactionCount: 0,
    blockRewardWei: "0",
    burntFeesWei: "0",
    totalTransactionFeeWei: "0",
    feePriceSumWei: "0",
    priorityFeeSumWei: "0",
    priorityFeeWeightedNumeratorWei: "0",
    priorityFeeGasWeightedNumeratorWei: "0",
    averageFeePriceWei: "0",
    averageTransactionFeeWei: "0",
    averageTransactionGasUsed: "0",
    averageTransactionInputDataSizeBytes: "0",
    averageTransactionInputDataCompressedSizeBytes: "0",
    averagePriorityFeeWeightedWei: "0",
    averagePriorityFeeWei: "0",
    ...overrides,
  };
}

function inspectedTransactionFixture(
  overrides: Partial<InspectedTransaction> & { position: number; hash: `0x${string}` },
): InspectedTransaction {
  return {
    from: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
    to: "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb",
    type: "2",
    nonce: "0",
    valueWei: "0",
    gasLimit: "100000",
    gasUsed: "21000",
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
    cumulativeGasUsed: "21000",
    gasPriceWei: "110",
    maxFeePerGasWei: "200",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "110",
    priorityFeeWei: "10",
    transactionFeeWei: "2310000",
    status: "1",
    contractAddress: null,
    ...overrides,
  };
}

function txHash(seed: number): `0x${string}` {
  return `0x${seed.toString(16).padStart(64, "0")}`;
}

describe.skipIf(!hasPostgresForTests())("JSON-RPC over PostgreSQL", () => {
  async function seededStorage(): Promise<ScannerStorage> {
    const { storage, cleanup } = await createIsolatedStorage("jsonrpc");
    cleanups.push(cleanup);
    await storage.saveChainId(600606n);
    const sender = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    const other = "0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd";
    await storage.saveBlockMetrics(
      blockMetricsFixture({ blockNumber: 1n, totalGasUsed: "42000", transactionCount: 2 }),
      { kind: "lastSuccessfulBlock" },
      [
        inspectedTransactionFixture({ position: 0, hash: txHash(1), nonce: "0", priorityFeeWei: "30" }),
        inspectedTransactionFixture({ position: 2, hash: txHash(2), nonce: "1", priorityFeeWei: "5" }),
      ],
    );
    await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 2n }), { kind: "lastSuccessfulBlock" }, []);
    await storage.saveBlockMetrics(
      blockMetricsFixture({ blockNumber: 3n, totalGasUsed: "21000", transactionCount: 1 }),
      { kind: "lastSuccessfulBlock" },
      [
        inspectedTransactionFixture({ position: 0, hash: txHash(3), nonce: "0", from: other, priorityFeeWei: "12" }),
      ],
    );
    return storage;
  }

  test("storage helpers answer nonce, block listing and fee queries", async () => {
    const storage = await seededStorage();
    expect(await storage.getChainId()).toBe(600606n);
    const sender = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(await storage.getSentTransactionCount(sender)).toBe(2n);
    expect(await storage.getSentTransactionCount(sender.toUpperCase().replace("0X", "0x"), 1n)).toBe(2n);
    expect(await storage.getSentTransactionCount(`0x${"e".repeat(40)}`)).toBe(0n);

    const listed = await storage.getTransactionsForBlock(1n);
    expect(listed.map((tx) => tx.position)).toEqual([0, 2]);
    expect((await storage.getTransactionByBlockAndPosition(1n, 2))?.hash).toBe(txHash(2));
    expect(await storage.getTransactionByBlockAndPosition(1n, 1)).toBeNull();
    expect((await storage.getBlockByNumber(3n))?.transactionCount).toBe(1);
    expect(await storage.getBlockByNumber(4n)).toBeUndefined();

    const samples = await storage.getPriorityFeeSamples(1n, 3n);
    expect(samples).toEqual([
      { blockNumber: 1n, priorityFeeWei: 5n, gasUsed: 21000n },
      { blockNumber: 1n, priorityFeeWei: 30n, gasUsed: 21000n },
      { blockNumber: 3n, priorityFeeWei: 12n, gasUsed: 21000n },
    ]);
    await expect(storage.getPriorityFeeSamples(0n, 5000n)).rejects.toThrow("limited to 1024 blocks");

    expect(await storage.getMinPriorityFeePerBlock(1n, 3n)).toEqual([
      { blockNumber: 1n, minPriorityFeeWei: 5n },
      { blockNumber: 3n, minPriorityFeeWei: 12n },
    ]);
  });

  test("POST /rpc serves batches from storage; other verbs are rejected", async () => {
    const storage = await seededStorage();
    const server = createBlockServer(storage, { port: 0, hostname: "127.0.0.1" });
    try {
      const base = `http://${server.hostname}:${server.port}`;
      const response = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
          { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
          { jsonrpc: "2.0", id: 3, method: "eth_getTransactionCount", params: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "latest"] },
          { jsonrpc: "2.0", id: 4, method: "eth_getBlockByNumber", params: ["0x1", false] },
          { jsonrpc: "2.0", id: 5, method: "eth_getTransactionReceipt", params: [txHash(3)] },
          { jsonrpc: "2.0", id: 6, method: "eth_feeHistory", params: ["0x3", "latest", [50]] },
          { jsonrpc: "2.0", id: 7, method: "web3_clientVersion", params: [] },
        ]),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const batch = (await response.json()) as JsonRpcResponse[];
      expect(batch.map((entry) => entry.error)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
      expect(batch[0]!.result).toBe("0x92a1e");
      expect(batch[1]!.result).toBe("0x3");
      expect(batch[2]!.result).toBe("0x2");
      expect((batch[3]!.result as { transactions: string[] }).transactions).toEqual([txHash(1), txHash(2)]);
      expect((batch[4]!.result as { blockNumber: string; status: string }).blockNumber).toBe("0x3");
      expect(batch[5]!.result).toEqual({
        oldestBlock: "0x1",
        baseFeePerGas: ["0x64", "0x64", "0x64", "0x64"],
        gasUsedRatio: [42000 / 30000000, 0, 21000 / 30000000],
        reward: [["0x5"], ["0x0"], ["0xc"]],
      });
      expect(batch[6]!.result).toMatch(/^arkiv-chain-indexer\/v\d+\.\d+\.\d+/);

      const parseError = await fetch(`${base}/rpc`, { method: "POST", body: "nope" });
      expect(parseError.status).toBe(200);
      expect(((await parseError.json()) as JsonRpcResponse).error?.code).toBe(JSON_RPC_PARSE_ERROR);

      const get = await fetch(`${base}/rpc`);
      expect(get.status).toBe(405);

      const health = (await (await fetch(`${base}/health`)).json()) as HealthResponseBody;
      expect(health.features.jsonRpc).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("transaction methods are gated when transaction data is disabled", async () => {
    const storage = await seededStorage();
    const server = createBlockServer(storage, { port: 0, hostname: "127.0.0.1", transactionDataEnabled: false });
    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/rpc`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash(1)] }),
      });
      const body = (await response.json()) as JsonRpcResponse;
      expect(body.error?.code).toBe(JSON_RPC_SERVER_ERROR);
    } finally {
      server.stop(true);
    }
  });
});
