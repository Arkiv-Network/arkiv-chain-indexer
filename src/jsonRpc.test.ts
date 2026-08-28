import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHODS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_PARSE_ERROR,
  JSON_RPC_SERVER_ERROR,
  JsonRpcError,
  handleJsonRpcBody,
  handleJsonRpcText,
  quantity,
  type JsonRpcDataSource,
  type JsonRpcForwarder,
  type JsonRpcResponse,
} from "./jsonRpc";
import { createBlockServer, type HealthResponseBody } from "./server";
import { JsonRpcPassthrough } from "./jsonRpcPassthrough";
import type {
  BlockQueryFilter,
  PriorityFeeSample,
  ScannerProgress,
  ScannerStorage,
  StoredAccountBalance,
  StoredBlock,
  StoredLog,
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
  logs?: StoredLog[];
  balances?: StoredAccountBalance[];
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
    logCount: null,
    ...overrides,
  };
}

function fakeSource(chain: FakeChain): JsonRpcDataSource {
  const blocks = [...(chain.blocks ?? [])].sort((a, b) => a.blockNumber - b.blockNumber);
  const transactions = chain.transactions ?? [];
  const logs = chain.logs ?? [];
  const balances = chain.balances ?? [];
  const progress: ScannerProgress = chain.progress ?? {
    ...(blocks.length > 0 ? { lastSuccessfulBlock: BigInt(blocks[blocks.length - 1]!.blockNumber) } : {}),
  };
  return {
    getBalanceAt: async (address, upToBlock) =>
      balances
        .filter(
          (balance) =>
            balance.address === address.toLowerCase() && BigInt(balance.blockNumber) <= upToBlock,
        )
        .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)))[0],
    getMinBalanceBlock: async () =>
      balances.length === 0
        ? undefined
        : balances
            .map((balance) => BigInt(balance.blockNumber))
            .reduce((lowest, blockNumber) => (blockNumber < lowest ? blockNumber : lowest)),
    getChainId: async () => chain.chainId,
    getScannerProgress: async () => progress,
    getForwardScanSamples: async () => [],
    getMinStoredBlock: async () => (blocks[0] ? BigInt(blocks[0].blockNumber) : undefined),
    getBlockByNumber: async (blockNumber) => blocks.find((block) => BigInt(block.blockNumber) === blockNumber),
    getBlockByHash: async (blockHash) =>
      blocks.find((block) => block.blockHash?.toLowerCase() === blockHash.toLowerCase()),
    getBlockHashesByNumber: async (blockNumbers) => {
      const hashes = new Map<bigint, string | null>();
      for (const blockNumber of blockNumbers) {
        const block = blocks.find((candidate) => BigInt(candidate.blockNumber) === blockNumber);
        if (block) hashes.set(blockNumber, block.blockHash ?? null);
      }
      return hashes;
    },
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
    getLogsForTransaction: async (hash) =>
      logs.filter((log) => log.hash === hash.toLowerCase()).sort((a, b) => a.logIndex - b.logIndex),
    queryLogs: async (filter) => {
      if (filter.toBlock - filter.fromBlock + 1n > 10_000n) throw new Error("Log queries are limited to 10000 blocks");
      const matched = logs
        .filter(
          (log) =>
            log.blockNumber >= filter.fromBlock &&
            log.blockNumber <= filter.toBlock &&
            (!filter.addresses?.length || filter.addresses.includes(log.address)) &&
            (filter.topics ?? []).every((options, index) => !options?.length || (log.topics[index] !== undefined && options.includes(log.topics[index]!))),
        )
        .sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.position - b.position || a.logIndex - b.logIndex);
      if (matched.length > (filter.limit ?? 10_000)) throw new Error("Query returned more than 10000 logs; narrow the block range or filter");
      return matched;
    },
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

  test("an explicit null params is treated as no parameters, the way nodes do", async () => {
    const response = (await handleJsonRpcBody(
      { jsonrpc: "2.0", id: 4, method: "eth_chainId", params: null },
      source,
    )) as JsonRpcResponse;
    expect(response).toEqual({ jsonrpc: "2.0", id: 4, result: "0x539" });
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

  test("zero-padded quantities are accepted on input, the way nodes decode them", async () => {
    for (const padded of ["0x03", "0x0003", `0x${"0".repeat(20)}3`]) {
      expect(await result(source, "eth_getBlockTransactionCountByNumber", [padded])).toBe("0x2");
    }
    // Canonical output is unaffected: the answer is still minimal hex.
    expect(await result(source, "eth_getBlockTransactionCountByNumber", ["0x09"])).toBe("0x4");
  });

  test("unknown block hashes read as unknown blocks; malformed hashes are invalid params", async () => {
    const hash = `0x${"1".repeat(64)}`;
    expect(await result(source, "eth_getBlockByHash", [hash, false])).toBeNull();
    expect(await result(source, "eth_getBlockTransactionCountByHash", [hash])).toBeNull();
    expect(await result(source, "eth_getTransactionByBlockHashAndIndex", [hash, "0x0"])).toBeNull();
    expect(await result(source, "eth_getUncleCountByBlockHash", [hash])).toBeNull();
    const tagged = await call(source, "eth_getBlockTransactionCountByNumber", [{ blockHash: hash }]);
    expect(tagged.error?.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(tagged.error?.message).toContain("header for hash not found");
    const malformed = await call(source, "eth_getBlockByHash", ["0x12", false]);
    expect(malformed.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("uncles never exist", async () => {
    expect(await result(source, "eth_getUncleCountByBlockNumber", ["latest"])).toBe("0x0");
    expect(await result(source, "eth_getUncleCountByBlockNumber", ["0x5"])).toBeNull();
    expect(await result(source, "eth_getUncleByBlockNumberAndIndex", ["latest", "0x0"])).toBeNull();
    expect(await result(source, "eth_getUncleByBlockHashAndIndex", [`0x${"2".repeat(64)}`, "0x0"])).toBeNull();
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
  const BLOCK_7_HASH = `0x${"7".repeat(64)}`;
  const txA = fakeTransaction({
    blockNumber: 7,
    position: 0,
    hash: `0x${"a".repeat(64)}`,
    contractAddress: "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc",
    logCount: 2,
  });
  const REGISTRY = "0x4400000000000000000000000000000000000044";
  const CREATED = `0x${"b2".repeat(32)}`;
  const EXTENDED = `0x${"40".repeat(32)}`;
  const ENTITY = `0x${"e1".repeat(32)}`;
  const OWNER_TOPIC = `0x${"00".repeat(12)}${"aa".repeat(20)}`;
  const logA0: StoredLog = { blockNumber: 7n, position: 0, logIndex: 0, hash: txA.hash, address: REGISTRY, topics: [CREATED, ENTITY, OWNER_TOPIC], data: "0x01" };
  const logA1: StoredLog = { blockNumber: 7n, position: 0, logIndex: 1, hash: txA.hash, address: REGISTRY, topics: [EXTENDED, ENTITY, OWNER_TOPIC], data: "0x02" };
  const logOther: StoredLog = { blockNumber: 8n, position: 0, logIndex: 0, hash: `0x${"9".repeat(64)}`, address: `0x${"55".repeat(20)}`, topics: [CREATED], data: "0x" };
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
        blockHash: BLOCK_7_HASH,
        parentHash: `0x${"6".repeat(64)}`,
        blockDate: "2024-05-01T00:00:00.000Z",
        baseBlockFeeWei: "1000",
        totalGasUsed: "42000",
        maxGasInBlock: "30000000",
        transactionCount: 2,
      }),
      fakeBlock({ blockNumber: 8, blockHash: null, transactionCount: 0 }),
    ],
    transactions: [txA, txB],
    logs: [logA0, logA1, logOther],
  });

  test("eth_getLogs filters by range, address and positional topics", async () => {
    const all = (await result(source, "eth_getLogs", [{ fromBlock: "0x1", toBlock: "latest" }])) as Array<Record<string, unknown>>;
    expect(all.map((log) => [log.blockNumber, log.logIndex, log.blockHash])).toEqual([
      ["0x7", "0x0", BLOCK_7_HASH],
      ["0x7", "0x1", BLOCK_7_HASH],
      ["0x8", "0x0", null],
    ]);
    expect(all[0]).toEqual({
      address: REGISTRY,
      topics: [CREATED, ENTITY, OWNER_TOPIC],
      data: "0x01",
      blockNumber: "0x7",
      transactionHash: txA.hash,
      transactionIndex: "0x0",
      blockHash: BLOCK_7_HASH,
      logIndex: "0x0",
      removed: false,
    });
    // Default range is latest..latest.
    expect((await result(source, "eth_getLogs", [{}])) as unknown[]).toHaveLength(1);
    // toBlock beyond the indexed head is clamped, not an error.
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x7", toBlock: "0x7fffffff" }])) as unknown[]).toHaveLength(3);
    // Address (single and list) and topics (single, alternatives, null wildcard).
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", address: REGISTRY }])) as unknown[]).toHaveLength(2);
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", address: [REGISTRY, `0x${"55".repeat(20)}`] }])) as unknown[]).toHaveLength(3);
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", topics: [EXTENDED] }])) as unknown[]).toHaveLength(1);
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", topics: [[CREATED, EXTENDED], ENTITY] }])) as unknown[]).toHaveLength(2);
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", topics: [null, ENTITY] }])) as unknown[]).toHaveLength(2);
    expect((await result(source, "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", topics: [null, `0x${"77".repeat(32)}`] }])) as unknown[]).toHaveLength(0);
    // blockHash addressing.
    expect((await result(source, "eth_getLogs", [{ blockHash: BLOCK_7_HASH }])) as unknown[]).toHaveLength(2);
    // Empty and reversed ranges.
    expect(await result(source, "eth_getLogs", [{ fromBlock: "0x8", toBlock: "0x7" }])).toEqual([]);

    for (const [params, code] of [
      [[{ blockHash: `0x${"1".repeat(64)}` }], JSON_RPC_SERVER_ERROR],
      [[{ blockHash: BLOCK_7_HASH, fromBlock: "0x1" }], JSON_RPC_INVALID_PARAMS],
      [[{ address: "0x12" }], JSON_RPC_INVALID_PARAMS],
      [[{ topics: "0x12" }], JSON_RPC_INVALID_PARAMS],
      [[{ topics: [null, null, null, null, null] }], JSON_RPC_INVALID_PARAMS],
      [["latest"], JSON_RPC_INVALID_PARAMS],
    ] as const) {
      const response = await call(source, "eth_getLogs", [...params]);
      expect(response.error?.code).toBe(code);
    }
  });

  test("eth_getLogs resolves every block hash in one batched lookup", async () => {
    const base = fakeSource({
      chainId: 1337n,
      blocks: [
        fakeBlock({ blockNumber: 7, blockHash: BLOCK_7_HASH, transactionCount: 2 }),
        fakeBlock({ blockNumber: 8, blockHash: null, transactionCount: 0 }),
      ],
      transactions: [txA, txB],
      logs: [logA0, logA1, logOther],
    });
    let batched = 0;
    let perBlock = 0;
    const counted: JsonRpcDataSource = {
      ...base,
      getBlockByNumber: async (blockNumber) => {
        perBlock += 1;
        return base.getBlockByNumber(blockNumber);
      },
      getBlockHashesByNumber: async (blockNumbers) => {
        batched += 1;
        return base.getBlockHashesByNumber(blockNumbers);
      },
    };

    const logs = (await result(counted, "eth_getLogs", [
      { fromBlock: "0x0", toBlock: "latest" },
    ])) as Array<Record<string, unknown>>;

    // Logs sit in two distinct blocks; the hashes cost one query, not one each,
    // and the block with no stored hash still reports null rather than dropping out.
    expect(logs.map((log) => [log.blockNumber, log.blockHash])).toEqual([
      ["0x7", BLOCK_7_HASH],
      ["0x7", BLOCK_7_HASH],
      ["0x8", null],
    ]);
    expect(batched).toBe(1);
    expect(perBlock).toBe(0);
  });

  test("hash-addressed lookups resolve through the stored block hash", async () => {
    const block = (await result(source, "eth_getBlockByHash", [BLOCK_7_HASH.toUpperCase().replace("0X", "0x"), true])) as Record<
      string,
      unknown
    >;
    expect(block.number).toBe("0x7");
    expect(block.hash).toBe(BLOCK_7_HASH);
    expect(block.parentHash).toBe(`0x${"6".repeat(64)}`);
    expect((block.transactions as Array<Record<string, unknown>>).map((tx) => tx.blockHash)).toEqual([
      BLOCK_7_HASH,
      BLOCK_7_HASH,
    ]);
    expect(await result(source, "eth_getBlockTransactionCountByHash", [BLOCK_7_HASH])).toBe("0x2");
    expect(await result(source, "eth_getUncleCountByBlockHash", [BLOCK_7_HASH])).toBe("0x0");
    const byIndex = (await result(source, "eth_getTransactionByBlockHashAndIndex", [BLOCK_7_HASH, "0x2"])) as Record<
      string,
      unknown
    >;
    expect(byIndex.hash).toBe(txB.hash);
    expect(byIndex.blockHash).toBe(BLOCK_7_HASH);
    expect(await result(source, "eth_getTransactionByBlockHashAndIndex", [BLOCK_7_HASH, "0x1"])).toBeNull();
    // EIP-1898 block parameter objects.
    expect(await result(source, "eth_getBlockTransactionCountByNumber", [{ blockHash: BLOCK_7_HASH }])).toBe("0x2");
    // A block stored before hashes were kept still reads fine by number, with hash null.
    const unhashed = (await result(source, "eth_getBlockByNumber", ["0x8", false])) as Record<string, unknown>;
    expect(unhashed.hash).toBeNull();
  });

  test("eth_getBlockByNumber lists hashes or full objects and nulls unknown header fields", async () => {
    const block = (await result(source, "eth_getBlockByNumber", ["0x7", false])) as Record<string, unknown>;
    expect(block).toMatchObject({
      number: "0x7",
      hash: BLOCK_7_HASH,
      parentHash: `0x${"6".repeat(64)}`,
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

    const full = (await result(source, "eth_getBlockByNumber", ["0x7", true])) as Record<string, unknown>;
    const transactions = full.transactions as Array<Record<string, unknown>>;
    expect(transactions.map((tx) => tx.hash)).toEqual([txA.hash, txB.hash]);
    expect(transactions[0]).toMatchObject({ transactionIndex: "0x0", chainId: "0x539" });
    expect(transactions[1]).toMatchObject({ transactionIndex: "0x2" });

    expect(await result(source, "eth_getBlockByNumber", ["0x9", false])).toBeNull();
    const defaulted = (await result(source, "eth_getBlockByNumber", ["0x7"])) as Record<string, unknown>;
    expect(defaulted.transactions).toEqual([txA.hash, txB.hash]);
    const bad = await call(source, "eth_getBlockByNumber", ["0x7", "yes"]);
    expect(bad.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
  });

  test("eth_getTransactionByHash maps stored fields and nulls the rest", async () => {
    const tx = (await result(source, "eth_getTransactionByHash", [txA.hash])) as Record<string, unknown>;
    expect(tx).toEqual({
      hash: txA.hash,
      blockHash: BLOCK_7_HASH,
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

  test("eth_getTransactionReceipt maps receipt fields and stored logs", async () => {
    const receipt = (await result(source, "eth_getTransactionReceipt", [txA.hash])) as Record<string, unknown>;
    expect(receipt).toEqual({
      transactionHash: txA.hash,
      transactionIndex: "0x0",
      blockHash: BLOCK_7_HASH,
      blockNumber: "0x7",
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x3f2",
      contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
      logs: [
        {
          address: REGISTRY,
          topics: [CREATED, ENTITY, OWNER_TOPIC],
          data: "0x01",
          blockNumber: "0x7",
          transactionHash: txA.hash,
          transactionIndex: "0x0",
          blockHash: BLOCK_7_HASH,
          logIndex: "0x0",
          removed: false,
        },
        {
          address: REGISTRY,
          topics: [EXTENDED, ENTITY, OWNER_TOPIC],
          data: "0x02",
          blockNumber: "0x7",
          transactionHash: txA.hash,
          transactionIndex: "0x0",
          blockHash: BLOCK_7_HASH,
          logIndex: "0x1",
          removed: false,
        },
      ],
      logsBloom: null,
      status: "0x1",
      type: "0x2",
    });
    // Stored before logs were kept → null; stored with no events → [].
    const failed = (await result(source, "eth_getTransactionReceipt", [txB.hash])) as Record<string, unknown>;
    expect(failed.status).toBe("0x0");
    expect(failed.logs).toBeNull();
    const quiet = fakeSource({ blocks: [fakeBlock({ blockNumber: 1 })], transactions: [fakeTransaction({ blockNumber: 1, position: 0, logCount: 0 })] });
    const noEvents = (await result(quiet, "eth_getTransactionReceipt", [`0x${"10".padEnd(64, "a")}`])) as Record<string, unknown>;
    expect(noEvents.logs).toEqual([]);
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

const BLOCK_1_HASH = `0x${"ab".repeat(32)}`;

// ---------------------------------------------------------------------------

describe("eth_getBalance", () => {
  const HOLDER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc";

  function balance(blockNumber: number, address: string, balanceWei: string): StoredAccountBalance {
    return {
      blockNumber: blockNumber.toString(),
      blockDate: new Date(1_700_000_000_000 + blockNumber * 2000).toISOString(),
      address,
      balanceWei,
    };
  }

  const source = fakeSource({
    blocks: [fakeBlock({ blockNumber: 3 }), fakeBlock({ blockNumber: 5 }), fakeBlock({ blockNumber: 9 })],
    balances: [balance(3, HOLDER, "100"), balance(9, HOLDER, "250")],
  });

  test("answers with the newest reading at or before the tag", async () => {
    expect(await result(source, "eth_getBalance", [HOLDER, "latest"])).toBe("0xfa");
    expect(await result(source, "eth_getBalance", [HOLDER])).toBe("0xfa");
    expect(await result(source, "eth_getBalance", [HOLDER, "0x9"])).toBe("0xfa");
    // Between readings the older one still stands: it is the last thing the
    // node told us this account was worth.
    expect(await result(source, "eth_getBalance", [HOLDER, "0x5"])).toBe("0x64");
    expect(await result(source, "eth_getBalance", [HOLDER, "0x3"])).toBe("0x64");
    expect(await result(source, "eth_getBalance", [HOLDER.toUpperCase().replace("0X", "0x")])).toBe("0xfa");
  });

  test("an unindexed account is an error, never 0x0", async () => {
    // The whole point: a caller must not be able to mistake "we never saw this
    // account" for "this account is empty".
    const stranger = await call(source, "eth_getBalance", [STRANGER, "latest"]);
    expect(stranger.result).toBeUndefined();
    expect(stranger.error?.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(stranger.error?.message).toContain(STRANGER);
    expect(stranger.error?.message).toContain("balances are recorded from block 3 onwards");

    // Same for a block older than this account's first reading.
    const tooEarly = await call(source, "eth_getBalance", [HOLDER, "0x2"]);
    expect(tooEarly.result).toBeUndefined();
    expect(tooEarly.error?.code).toBe(JSON_RPC_SERVER_ERROR);
  });

  test("says so plainly when balances are not indexed at all", async () => {
    const untracked = fakeSource({ blocks: [fakeBlock({ blockNumber: 1 })] });
    const response = await call(untracked, "eth_getBalance", [HOLDER, "latest"]);
    expect(response.error?.code).toBe(JSON_RPC_SERVER_ERROR);
    expect(response.error?.message).toBe(
      "eth_getBalance is unavailable: account balances are not indexed",
    );
  });

  test("rejects a malformed address and a wrong parameter count", async () => {
    expect((await call(source, "eth_getBalance", ["0x1234"])).error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect((await call(source, "eth_getBalance", [])).error?.code).toBe(JSON_RPC_INVALID_PARAMS);
    expect((await call(source, "eth_getBalance", [HOLDER, "latest", "extra"])).error?.code).toBe(
      JSON_RPC_INVALID_PARAMS,
    );
  });
});

describe("passthrough", () => {
  const source = fakeSource({
    chainId: 1337n,
    blocks: [fakeBlock({ blockNumber: 7 })],
  });

  /** Records what it was asked to answer so tests can assert the hand-off. */
  function fakeForwarder(
    methods: string[],
    answer: (method: string, params: unknown[]) => unknown = () => "0xforwarded",
  ): JsonRpcForwarder & { calls: Array<{ method: string; params: unknown[] }> } {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    return {
      calls,
      methods: new Set(methods),
      forward: async (method, params) => {
        calls.push({ method, params });
        return answer(method, params);
      },
    };
  }

  test("a listed method is answered by the forwarder, with its params intact", async () => {
    const passthrough = fakeForwarder(["eth_sendRawTransaction"]);
    const response = await call(source, "eth_sendRawTransaction", ["0xdeadbeef"], { passthrough });
    expect(response.result).toBe("0xforwarded");
    expect(passthrough.calls).toEqual([{ method: "eth_sendRawTransaction", params: ["0xdeadbeef"] }]);
  });

  test("a listed method outranks the local handler", async () => {
    const passthrough = fakeForwarder(["eth_blockNumber"], () => "0xdeadbeef");
    expect((await call(source, "eth_blockNumber", [], { passthrough })).result).toBe("0xdeadbeef");
    // ... and the same source without the passthrough still answers from the index.
    expect(await result(source, "eth_blockNumber")).toBe("0x7");
  });

  test("unlisted methods keep their usual answers", async () => {
    const passthrough = fakeForwarder(["eth_sendRawTransaction"]);
    expect((await call(source, "eth_chainId", [], { passthrough })).result).toBe("0x539");
    expect((await call(source, "eth_call", [], { passthrough })).error?.code).toBe(
      JSON_RPC_METHOD_NOT_FOUND,
    );
    expect(passthrough.calls).toEqual([]);
  });

  test("the transaction-data gate does not apply to a forwarded method", async () => {
    const passthrough = fakeForwarder(["eth_getTransactionCount"], () => "0x2a");
    const options = { transactionDataEnabled: false, passthrough };
    expect((await call(source, "eth_getTransactionCount", ["0x0", "latest"], options)).result).toBe("0x2a");
    // Its unforwarded neighbour is still gated.
    expect((await call(source, "eth_getLogs", [{}], options)).error?.code).toBe(JSON_RPC_SERVER_ERROR);
  });

  test("the node's verdict reaches the caller; an unexpected throw does not", async () => {
    const rejecting = fakeForwarder(["eth_sendRawTransaction"], () => {
      throw new JsonRpcError(-32000, "already known");
    });
    const rejected = await call(source, "eth_sendRawTransaction", ["0x01"], { passthrough: rejecting });
    expect(rejected.error).toEqual({ code: -32000, message: "already known" });

    const broken = fakeForwarder(["eth_sendRawTransaction"], () => {
      throw new TypeError("undefined is not a function");
    });
    const failed = await call(source, "eth_sendRawTransaction", ["0x01"], { passthrough: broken });
    expect(failed.error?.code).toBe(JSON_RPC_INTERNAL_ERROR);
  });

  test("a batch mixes indexed and forwarded answers", async () => {
    const passthrough = fakeForwarder(["eth_sendRawTransaction"], () => `0x${"11".repeat(32)}`);
    const batch = (await handleJsonRpcBody(
      [
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x02f8"] },
        { jsonrpc: "2.0", id: 3, method: "eth_chainId" },
      ],
      source,
      { passthrough },
    )) as JsonRpcResponse[];
    expect(batch.map((entry) => entry.result)).toEqual(["0x7", `0x${"11".repeat(32)}`, "0x539"]);
  });

  test("an explicit null params forwards as an empty list", async () => {
    const passthrough = fakeForwarder(["eth_sendTransaction"]);
    const response = (await handleJsonRpcBody(
      { jsonrpc: "2.0", id: 1, method: "eth_sendTransaction", params: null },
      source,
      { passthrough },
    )) as JsonRpcResponse;
    expect(response.result).toBe("0xforwarded");
    expect(passthrough.calls[0]!.params).toEqual([]);
  });
});

describe.skipIf(!hasPostgresForTests())("JSON-RPC over PostgreSQL", () => {
  async function seededStorage(): Promise<ScannerStorage> {
    const { storage, cleanup } = await createIsolatedStorage("jsonrpc");
    cleanups.push(cleanup);
    await storage.saveChainId(600606n);
    const sender = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
    const other = "0xDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDdDd";
    await storage.saveBlockMetrics(
      blockMetricsFixture({
        blockNumber: 1n,
        blockHash: BLOCK_1_HASH,
        parentHash: `0x${"0".repeat(64)}`,
        totalGasUsed: "42000",
        transactionCount: 2,
      }),
      { kind: "lastSuccessfulBlock" },
      [
        inspectedTransactionFixture({
          position: 0,
          hash: txHash(1),
          nonce: "0",
          priorityFeeWei: "30",
          logs: [
            { logIndex: 0, address: "0x4400000000000000000000000000000000000044", topics: [`0x${"b2".repeat(32)}`, `0x${"e1".repeat(32)}`], data: "0x01" },
            { logIndex: 1, address: "0x4400000000000000000000000000000000000044", topics: [`0x${"40".repeat(32)}`, `0x${"e1".repeat(32)}`], data: "0x" },
          ],
        }),
        inspectedTransactionFixture({ position: 2, hash: txHash(2), nonce: "1", priorityFeeWei: "5", logs: [] }),
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
    expect((await storage.getBlockByNumber(1n))?.blockHash).toBe(BLOCK_1_HASH);
    expect((await storage.getBlockByNumber(1n))?.parentHash).toBe(`0x${"0".repeat(64)}`);
    expect((await storage.getBlockByNumber(2n))?.blockHash).toBeNull();
    expect((await storage.getBlockByHash(BLOCK_1_HASH.toUpperCase().replace("0X", "0x")))?.blockNumber).toBe(1);
    expect(await storage.getBlockByHash(`0x${"cd".repeat(32)}`)).toBeUndefined();

    // Batched hash lookup: stored-but-unhashed blocks map to null, unknown
    // numbers are absent, and repeats collapse into one row.
    expect(await storage.getBlockHashesByNumber([1n, 2n, 4n, 1n])).toEqual(
      new Map<bigint, string | null>([
        [1n, BLOCK_1_HASH],
        [2n, null],
      ]),
    );
    expect(await storage.getBlockHashesByNumber([])).toEqual(new Map());

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

    // Logs: counted on the transaction row, rows in transaction_logs, null when the receipt had none.
    expect((await storage.getTransactionByHash(txHash(1)))?.logCount).toBe(2);
    expect((await storage.getTransactionByHash(txHash(2)))?.logCount).toBe(0);
    expect((await storage.getTransactionByHash(txHash(3)))?.logCount).toBeNull();
    expect(await storage.getLogsForTransaction(txHash(1).toUpperCase().replace("0X", "0x"))).toEqual([
      { blockNumber: 1n, position: 0, logIndex: 0, hash: txHash(1), address: "0x4400000000000000000000000000000000000044", topics: [`0x${"b2".repeat(32)}`, `0x${"e1".repeat(32)}`], data: "0x01" },
      { blockNumber: 1n, position: 0, logIndex: 1, hash: txHash(1), address: "0x4400000000000000000000000000000000000044", topics: [`0x${"40".repeat(32)}`, `0x${"e1".repeat(32)}`], data: "0x" },
    ]);
    expect(await storage.getLogsForTransaction(txHash(2))).toEqual([]);
    expect((await storage.queryLogs({ fromBlock: 0n, toBlock: 10n })).length).toBe(2);
    expect((await storage.queryLogs({ fromBlock: 0n, toBlock: 10n, topics: [[`0x${"40".repeat(32)}`]] })).length).toBe(1);
    expect((await storage.queryLogs({ fromBlock: 0n, toBlock: 10n, topics: [undefined, [`0x${"e1".repeat(32)}`]] })).length).toBe(2);
    expect((await storage.queryLogs({ fromBlock: 0n, toBlock: 10n, addresses: [`0x${"55".repeat(20)}`] })).length).toBe(0);
    await expect(storage.queryLogs({ fromBlock: 0n, toBlock: 10n, limit: 1 })).rejects.toThrow("more than 1 logs");
    await expect(storage.queryLogs({ fromBlock: 0n, toBlock: 20_000n })).rejects.toThrow("limited to 10000 blocks");

    // Re-saving a block without a hash keeps the stored one.
    await storage.saveBlockMetrics(blockMetricsFixture({ blockNumber: 1n, transactionCount: 2 }), { kind: "lastSuccessfulBlock" }, []);
    expect((await storage.getBlockByNumber(1n))?.blockHash).toBe(BLOCK_1_HASH);
    // Replacing a block's transactions replaces its logs too.
    expect(await storage.queryLogs({ fromBlock: 1n, toBlock: 1n })).toEqual([]);
  });

  test("POST /shadow-rpc serves batches from storage; other verbs are rejected", async () => {
    const storage = await seededStorage();
    const server = createBlockServer(storage, { port: 0, hostname: "127.0.0.1" });
    try {
      const base = `http://${server.hostname}:${server.port}`;
      const response = await fetch(`${base}/shadow-rpc`, {
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
          { jsonrpc: "2.0", id: 8, method: "eth_getBlockByHash", params: [BLOCK_1_HASH, false] },
          { jsonrpc: "2.0", id: 9, method: "eth_getTransactionReceipt", params: [txHash(1)] },
          { jsonrpc: "2.0", id: 10, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", topics: [null, `0x${"e1".repeat(32)}`] }] },
        ]),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const batch = (await response.json()) as JsonRpcResponse[];
      expect(batch.map((entry) => entry.error)).toEqual(Array(10).fill(undefined));
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
      expect((batch[3]!.result as { hash: string }).hash).toBe(BLOCK_1_HASH);
      expect((batch[7]!.result as { number: string }).number).toBe("0x1");
      expect((batch[8]!.result as { blockHash: string }).blockHash).toBe(BLOCK_1_HASH);
      expect((batch[4]!.result as { blockHash: string | null; logs: unknown }).blockHash).toBeNull();
      expect((batch[4]!.result as { logs: unknown }).logs).toBeNull();
      expect(((batch[8]!.result as { logs: Array<{ logIndex: string; blockHash: string }> }).logs).map((l) => [l.logIndex, l.blockHash])).toEqual([["0x0", BLOCK_1_HASH], ["0x1", BLOCK_1_HASH]]);
      expect((batch[9]!.result as unknown[]).length).toBe(2);

      const parseError = await fetch(`${base}/shadow-rpc`, { method: "POST", body: "nope" });
      expect(parseError.status).toBe(200);
      expect(((await parseError.json()) as JsonRpcResponse).error?.code).toBe(JSON_RPC_PARSE_ERROR);

      const get = await fetch(`${base}/shadow-rpc`);
      expect(get.status).toBe(405);

      // `/rpc` was renamed, not aliased: the old path must not quietly keep
      // serving, or the name that hides what this endpoint is stays alive.
      const renamed = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      expect(renamed.status).toBe(405);

      const health = (await (await fetch(`${base}/health`)).json()) as HealthResponseBody;
      expect(health.features.jsonRpc).toBe(true);
      // No upstream configured: the endpoint forwards nothing, and says so.
      expect(health.features.jsonRpcPassthrough).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("POST /shadow-rpc forwards submissions to the configured node", async () => {
    const seen: Array<{ method: string; params: unknown[]; apiKey: string | null }> = [];
    // Stands in for the real node: it knows one transaction and rejects the other.
    const node = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const body = (await request.json()) as { id: number; method: string; params: unknown[] };
        seen.push({ method: body.method, params: body.params, apiKey: request.headers.get("x-api-key") });
        const error =
          body.params[0] === "0xbad" ? { code: -32000, message: "nonce too low" } : undefined;
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          ...(error ? { error } : { result: `0x${"cd".repeat(32)}` }),
        });
      },
    });
    const storage = await seededStorage();
    const server = createBlockServer(storage, {
      port: 0,
      hostname: "127.0.0.1",
      jsonRpcPassthrough: new JsonRpcPassthrough({
        url: `http://${node.hostname}:${node.port}`,
        apiKey: "hub-key",
      }),
    });
    const post = (body: unknown) =>
      fetch(`http://${server.hostname}:${server.port}/shadow-rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const batch = (await (
        await post([
          { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
          { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x02f8"] },
          { jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: ["0xbad"] },
          { jsonrpc: "2.0", id: 4, method: "eth_call", params: [{}, "latest"] },
        ])
      ).json()) as JsonRpcResponse[];
      // Indexed reads and forwarded writes share one batch.
      expect(batch[0]!.result).toBe("0x3");
      expect(batch[1]!.result).toBe(`0x${"cd".repeat(32)}`);
      // The node's rejection is the answer, not a generic failure.
      expect(batch[2]!.error).toEqual({ code: -32000, message: "nonce too low" });
      // Nothing else leaked through the hole.
      expect(batch[3]!.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
      expect(seen.map((call) => call.method)).toEqual([
        "eth_sendRawTransaction",
        "eth_sendRawTransaction",
      ]);
      expect(seen[0]!.apiKey).toBe("hub-key");

      const health = (await (await fetch(`http://${server.hostname}:${server.port}/health`)).json()) as HealthResponseBody;
      expect(health.features.jsonRpcPassthrough).toEqual(["eth_sendRawTransaction"]);
    } finally {
      server.stop(true);
      node.stop(true);
    }
  });

  test("transaction methods are gated when transaction data is disabled", async () => {
    const storage = await seededStorage();
    const server = createBlockServer(storage, { port: 0, hostname: "127.0.0.1", transactionDataEnabled: false });
    try {
      const response = await fetch(`http://${server.hostname}:${server.port}/shadow-rpc`, {
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
