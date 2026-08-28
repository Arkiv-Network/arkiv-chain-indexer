/**
 * Read-only Ethereum JSON-RPC served from the indexer's own PostgreSQL data.
 *
 * Except through an explicitly allowlisted passthrough (`jsonRpcPassthrough.ts`,
 * off unless a deployment configures it), the backend never talks to a node:
 * every method here is answered from stored blocks, transactions and scanner
 * state. That shapes the surface:
 *
 * - "Tier 1" methods have exact node semantics over the indexed range:
 *   chain/network identity, block height, sync status, nonces, fee history
 *   and the gas-price oracle.
 * - "Tier 2" methods (blocks, transactions, receipts) return standard-shaped
 *   objects in which every field the scanner does not persist is `null` —
 *   block hashes, roots, signatures, logs. Callers that only need the fields we
 *   have (viem, raw fetch) work; strict formatters may reject the nulls.
 *   `input` stays null by design: calldata is never stored.
 * - Block hashes are stored for every block scanned since the column was
 *   added; older rows carry `null`, and hash-addressed lookups of such blocks
 *   answer `null` ("unknown block") like a node would for a hash it has never
 *   seen.
 * - Receipt logs are stored the same way (`transaction_logs`, no backfill):
 *   receipts of older transactions report `logs: null`, newer ones the real
 *   list, and `eth_getLogs` only sees what is stored.
 * - Writes have no answer in an index at all: a transaction has to reach a
 *   node's mempool. A configured passthrough relays the methods it lists
 *   (`eth_sendRawTransaction`, `eth_sendTransaction` by default) to a real node
 *   and takes precedence over every handler here.
 *
 * `eth_blockNumber` and the `latest` tag mean the *indexed* head
 * (`scanner_state.last_successful_block`), not the chain head; `eth_syncing`
 * exposes the gap.
 */
import { computeSyncStatus, type ScanSample } from "./syncStatus";
import type {
  BlockQueryFilter,
  LogQueryFilter,
  PriorityFeeSample,
  ScannerProgress,
  StoredBlock,
  StoredLog,
  StoredTransaction,
} from "./storage";
import { MAX_FEE_HISTORY_BLOCKS, MAX_LOG_QUERY_BLOCKS } from "./storage";

/** The storage surface the RPC layer needs; `ScannerStorage` satisfies it. */
export interface JsonRpcDataSource {
  getChainId(): Promise<bigint | undefined>;
  getScannerProgress(): Promise<ScannerProgress>;
  getForwardScanSamples(): Promise<ScanSample[]>;
  getMinStoredBlock(): Promise<bigint | undefined>;
  getBlockByNumber(blockNumber: bigint): Promise<StoredBlock | undefined>;
  getBlockByHash(blockHash: string): Promise<StoredBlock | undefined>;
  getBlockHashesByNumber(blockNumbers: readonly bigint[]): Promise<Map<bigint, string | null>>;
  queryBlocks(filter: BlockQueryFilter): Promise<StoredBlock[]>;
  getTransactionsForBlock(blockNumber: bigint): Promise<StoredTransaction[]>;
  getTransactionByHash(hash: string): Promise<StoredTransaction | null>;
  getTransactionByBlockAndPosition(
    blockNumber: bigint,
    position: number,
  ): Promise<StoredTransaction | null>;
  getSentTransactionCount(address: string, upToBlock?: bigint): Promise<bigint>;
  getLogsForTransaction(hash: string): Promise<StoredLog[]>;
  queryLogs(filter: LogQueryFilter): Promise<StoredLog[]>;
  getPriorityFeeSamples(fromBlock: bigint, toBlock: bigint): Promise<PriorityFeeSample[]>;
  getMinPriorityFeePerBlock(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Array<{ blockNumber: bigint; minPriorityFeeWei: bigint }>>;
}

/**
 * A source of answers that is not the index. Implemented by `JsonRpcPassthrough`,
 * which relays to a real node; declared here so this module stays free of any
 * dependency on it.
 */
export interface JsonRpcForwarder {
  /** Methods this forwarder answers. They win over the local handlers. */
  readonly methods: ReadonlySet<string>;
  /** Answer one call, or throw a `JsonRpcError` carrying the failure. */
  forward(method: string, params: unknown[]): Promise<unknown>;
}

export interface JsonRpcOptions {
  /** Gate for transaction/receipt/block-body methods (mirrors the REST feature flag). */
  transactionDataEnabled?: boolean;
  /** Reported by web3_clientVersion. */
  clientVersion?: string;
  /** Upper bound on requests per batch; defaults to 100. */
  maxBatchSize?: number;
  /**
   * Methods answered by a real node instead of the index — transaction
   * submission, and anything else a deployment chooses to hand off. Absent
   * (the default) the endpoint is read-only and node-free.
   */
  passthrough?: JsonRpcForwarder | null;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;
/** Generic server error, also used for "the indexer cannot answer this". */
export const JSON_RPC_SERVER_ERROR = -32000;

export const DEFAULT_CLIENT_VERSION = "arkiv-chain-indexer";
const DEFAULT_MAX_BATCH_SIZE = 100;
/** Blocks the gas-price oracle looks back over (geth's default). */
const GAS_PRICE_ORACLE_BLOCKS = 20n;
/** Percentile of per-block minimum tips the oracle suggests (geth's default). */
const GAS_PRICE_ORACLE_PERCENTILE = 60;

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }

  toBody(): JsonRpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

type Hex = `0x${string}`;

type MethodHandler = (params: unknown[], context: MethodContext) => Promise<unknown>;

interface MethodContext {
  storage: JsonRpcDataSource;
  options: Required<JsonRpcOptions>;
}

/**
 * Every method the endpoint answers from the index, in the order the docs list
 * them. A configured `JsonRpcForwarder` adds to this and overrides it.
 */
export const JSON_RPC_METHODS = [
  "web3_clientVersion",
  "net_version",
  "net_listening",
  "eth_chainId",
  "eth_blockNumber",
  "eth_syncing",
  "eth_accounts",
  "eth_mining",
  "eth_hashrate",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_getBlockTransactionCountByNumber",
  "eth_getUncleCountByBlockNumber",
  "eth_getUncleCountByBlockHash",
  "eth_getUncleByBlockNumberAndIndex",
  "eth_getUncleByBlockHashAndIndex",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getBlockTransactionCountByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
] as const;

export type JsonRpcMethod = (typeof JSON_RPC_METHODS)[number];

/** Methods that read stored transaction rows and so honour the transaction-data gate. */
const TRANSACTION_DATA_METHODS: ReadonlySet<string> = new Set<JsonRpcMethod>([
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionByBlockNumberAndIndex",
  "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionReceipt",
  "eth_getLogs",
]);

// ---------------------------------------------------------------------------
// Entry points

/**
 * Handle a raw request body. Parse failures and malformed envelopes come back
 * as JSON-RPC error responses (id null), never as thrown errors, so the HTTP
 * layer can always reply 200 with a JSON-RPC body the way nodes do.
 */
export async function handleJsonRpcText(
  text: string,
  storage: JsonRpcDataSource,
  options: JsonRpcOptions = {},
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse(null, new JsonRpcError(JSON_RPC_PARSE_ERROR, "Parse error"));
  }
  return handleJsonRpcBody(body, storage, options);
}

export async function handleJsonRpcBody(
  body: unknown,
  storage: JsonRpcDataSource,
  options: JsonRpcOptions = {},
): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  const resolved = resolveOptions(options);
  const context: MethodContext = { storage, options: resolved };

  if (Array.isArray(body)) {
    if (body.length === 0) {
      return errorResponse(null, new JsonRpcError(JSON_RPC_INVALID_REQUEST, "Empty batch"));
    }
    if (body.length > resolved.maxBatchSize) {
      return errorResponse(
        null,
        new JsonRpcError(
          JSON_RPC_INVALID_REQUEST,
          `Batch too large: at most ${resolved.maxBatchSize} requests per batch`,
        ),
      );
    }
    return Promise.all(body.map((entry) => handleSingle(entry, context)));
  }
  return handleSingle(body, context);
}

async function handleSingle(request: unknown, context: MethodContext): Promise<JsonRpcResponse> {
  if (!isPlainObject(request)) {
    return errorResponse(null, new JsonRpcError(JSON_RPC_INVALID_REQUEST, "Invalid request"));
  }
  const id = normaliseId(request.id);
  if (request.jsonrpc !== undefined && request.jsonrpc !== "2.0") {
    return errorResponse(
      id,
      new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Invalid request: "jsonrpc" must be "2.0"'),
    );
  }
  const method = request.method;
  if (typeof method !== "string") {
    return errorResponse(
      id,
      new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Invalid request: "method" must be a string'),
    );
  }
  const rawParams = request.params;
  // An explicit `"params": null` means "no parameters" the same way omitting
  // the member does. The spec only blesses omission, but plenty of clients
  // send the null and nodes accept it, so rejecting it would only break
  // callers that work fine against a real node.
  const omittedParams = rawParams === undefined || rawParams === null;
  if (!omittedParams && !Array.isArray(rawParams)) {
    return errorResponse(
      id,
      new JsonRpcError(JSON_RPC_INVALID_PARAMS, "Invalid params: expected a positional array"),
    );
  }
  const params: unknown[] = omittedParams ? [] : (rawParams as unknown[]);

  // A configured passthrough outranks the local table: listing a method there
  // means "let the node answer this one", whether or not we could have.
  const passthrough = context.options.passthrough;
  const forwarder = passthrough && passthrough.methods.has(method) ? passthrough : null;
  const handler: MethodHandler | undefined = forwarder
    ? (forwardedParams) => forwarder.forward(method, forwardedParams)
    : METHODS[method];
  if (!handler) {
    return errorResponse(
      id,
      new JsonRpcError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
    );
  }
  // The gate protects stored transaction rows; a forwarded call never reads them.
  if (!forwarder && !context.options.transactionDataEnabled && TRANSACTION_DATA_METHODS.has(method)) {
    return errorResponse(
      id,
      new JsonRpcError(JSON_RPC_SERVER_ERROR, `${method} is unavailable: transaction data is disabled`),
    );
  }

  try {
    const result = await handler(params, context);
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (error instanceof JsonRpcError) {
      return errorResponse(id, error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(id, new JsonRpcError(JSON_RPC_INTERNAL_ERROR, `Internal error: ${message}`));
  }
}

function resolveOptions(options: JsonRpcOptions): Required<JsonRpcOptions> {
  return {
    transactionDataEnabled: options.transactionDataEnabled ?? true,
    clientVersion: options.clientVersion ?? DEFAULT_CLIENT_VERSION,
    maxBatchSize: options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    passthrough: options.passthrough ?? null,
  };
}

function errorResponse(id: JsonRpcId, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: error.toBody() };
}

function normaliseId(id: unknown): JsonRpcId {
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Methods

const METHODS: Record<string, MethodHandler> = {
  web3_clientVersion: async (params, { options }) => {
    expectParamCount(params, 0);
    return options.clientVersion;
  },

  net_version: async (params, { storage }) => {
    expectParamCount(params, 0);
    return (await requireChainId(storage)).toString(10);
  },

  net_listening: async (params) => {
    expectParamCount(params, 0);
    return true;
  },

  eth_chainId: async (params, { storage }) => {
    expectParamCount(params, 0);
    return quantity(await requireChainId(storage));
  },

  eth_blockNumber: async (params, { storage }) => {
    expectParamCount(params, 0);
    const head = await indexedHead(storage);
    return quantity(head ?? 0n);
  },

  eth_syncing: async (params, { storage }) => {
    expectParamCount(params, 0);
    const [progress, samples] = await Promise.all([
      storage.getScannerProgress(),
      storage.getForwardScanSamples(),
    ]);
    const sync = computeSyncStatus({ now: new Date(), ...progress, samples });
    if (sync.state === "synced" || progress.latestObservedBlock === undefined) {
      return false;
    }
    const startingBlock = (await storage.getMinStoredBlock()) ?? 0n;
    return {
      startingBlock: quantity(startingBlock),
      currentBlock: quantity(progress.lastSuccessfulBlock ?? 0n),
      highestBlock: quantity(progress.latestObservedBlock),
    };
  },

  eth_accounts: async (params) => {
    expectParamCount(params, 0);
    return [];
  },

  eth_mining: async (params) => {
    expectParamCount(params, 0);
    return false;
  },

  eth_hashrate: async (params) => {
    expectParamCount(params, 0);
    return "0x0";
  },

  eth_maxPriorityFeePerGas: async (params, { storage }) => {
    expectParamCount(params, 0);
    return quantity(await suggestPriorityFee(storage));
  },

  eth_gasPrice: async (params, { storage }) => {
    expectParamCount(params, 0);
    const head = await indexedHead(storage);
    const headBlock = head === undefined ? undefined : await storage.getBlockByNumber(head);
    const baseFee = headBlock ? BigInt(headBlock.baseBlockFeeWei) : 0n;
    return quantity(baseFee + (await suggestPriorityFee(storage)));
  },

  eth_feeHistory: async (params, { storage }) => {
    expectParamCount(params, 2, 3);
    const requestedCount = parseQuantityParam(params[0], "blockCount");
    const percentiles = parseRewardPercentiles(params[2]);
    if (requestedCount < 1n) {
      throw invalidParams("blockCount must be at least 1");
    }
    const newest = await resolveBlockTag(params[1], storage);
    if (newest === undefined) {
      return emptyFeeHistory(percentiles !== undefined);
    }
    const count = requestedCount > BigInt(MAX_FEE_HISTORY_BLOCKS) ? BigInt(MAX_FEE_HISTORY_BLOCKS) : requestedCount;
    const oldestRequested = newest - count + 1n;
    const oldest = oldestRequested < 0n ? 0n : oldestRequested;

    const blocks = await storage.queryBlocks({
      blockGt: oldest - 1n,
      blockLt: newest + 2n, // one extra: the next block's base fee closes the array
      limit: MAX_FEE_HISTORY_BLOCKS + 1,
      order: "asc",
    });
    const window = blocks.filter((block) => BigInt(block.blockNumber) <= newest);
    if (window.length === 0) {
      return emptyFeeHistory(percentiles !== undefined);
    }
    const nextBlock = blocks.find((block) => BigInt(block.blockNumber) === newest + 1n);
    const firstStored = window[0]!;
    const lastStored = window[window.length - 1]!;

    const baseFeePerGas = window.map((block) => quantity(BigInt(block.baseBlockFeeWei)));
    // The spec wants count+1 base fees, the last being the block after
    // `newest`. Without EIP-1559 parameters for this chain we cannot derive
    // it, so fall back to repeating the newest base fee when the next block
    // is not stored yet.
    baseFeePerGas.push(quantity(BigInt((nextBlock ?? lastStored).baseBlockFeeWei)));
    const gasUsedRatio = window.map((block) => gasRatio(block));

    const result: Record<string, unknown> = {
      oldestBlock: quantity(BigInt(firstStored.blockNumber)),
      baseFeePerGas,
      gasUsedRatio,
    };
    if (percentiles !== undefined) {
      const samples = await storage.getPriorityFeeSamples(
        BigInt(firstStored.blockNumber),
        BigInt(lastStored.blockNumber),
      );
      result.reward = rewardsPerBlock(window, samples, percentiles);
    }
    return result;
  },

  eth_getTransactionCount: async (params, { storage }) => {
    expectParamCount(params, 1, 2);
    const address = parseAddressParam(params[0], "address");
    const tag = params[1] ?? "latest";
    if (tag === "earliest") {
      return "0x0";
    }
    const block = await resolveBlockTag(tag, storage);
    if (block === undefined) {
      return "0x0";
    }
    return quantity(await storage.getSentTransactionCount(address, block));
  },

  eth_getBlockTransactionCountByNumber: async (params, { storage }) => {
    expectParamCount(params, 1);
    const block = await resolveStoredBlock(params[0], storage);
    return block ? quantity(BigInt(block.transactionCount)) : null;
  },

  eth_getUncleCountByBlockNumber: async (params, { storage }) => {
    expectParamCount(params, 1);
    const block = await resolveStoredBlock(params[0], storage);
    return block ? "0x0" : null;
  },

  eth_getUncleCountByBlockHash: async (params, { storage }) => {
    expectParamCount(params, 1);
    const block = await storage.getBlockByHash(parseHashParam(params[0], "blockHash"));
    // Post-merge chains have no uncles; only "unknown block" changes the answer.
    return block ? "0x0" : null;
  },

  eth_getUncleByBlockNumberAndIndex: async (params) => {
    expectParamCount(params, 2);
    return null;
  },

  eth_getUncleByBlockHashAndIndex: async (params) => {
    expectParamCount(params, 2);
    return null;
  },

  eth_getBlockByNumber: async (params, { storage }) => {
    expectParamCount(params, 1, 2);
    const fullTransactions = parseBooleanParam(params[1] ?? false, "fullTransactionObjects");
    const block = await resolveStoredBlock(params[0], storage);
    if (!block) return null;
    const transactions = await storage.getTransactionsForBlock(BigInt(block.blockNumber));
    const chainId = await storage.getChainId();
    return blockObject(block, transactions, fullTransactions, chainId);
  },

  eth_getBlockByHash: async (params, { storage }) => {
    expectParamCount(params, 1, 2);
    const fullTransactions = parseBooleanParam(params[1] ?? false, "fullTransactionObjects");
    const block = await storage.getBlockByHash(parseHashParam(params[0], "blockHash"));
    if (!block) return null;
    const transactions = await storage.getTransactionsForBlock(BigInt(block.blockNumber));
    const chainId = await storage.getChainId();
    return blockObject(block, transactions, fullTransactions, chainId);
  },

  eth_getTransactionByHash: async (params, { storage }) => {
    expectParamCount(params, 1);
    const hash = parseHashParam(params[0], "transactionHash");
    const transaction = await storage.getTransactionByHash(hash);
    if (!transaction) return null;
    return transactionObject(transaction, await storage.getChainId(), await blockHashOf(transaction, storage));
  },

  eth_getTransactionByBlockNumberAndIndex: async (params, { storage }) => {
    expectParamCount(params, 2);
    const index = parseIndexParam(params[1], "index");
    const block = await resolveStoredBlock(params[0], storage);
    if (!block) return null;
    const transaction = await storage.getTransactionByBlockAndPosition(BigInt(block.blockNumber), index);
    if (!transaction) return null;
    return transactionObject(transaction, await storage.getChainId(), block.blockHash ?? null);
  },

  eth_getTransactionByBlockHashAndIndex: async (params, { storage }) => {
    expectParamCount(params, 2);
    const index = parseIndexParam(params[1], "index");
    const block = await storage.getBlockByHash(parseHashParam(params[0], "blockHash"));
    if (!block) return null;
    const transaction = await storage.getTransactionByBlockAndPosition(BigInt(block.blockNumber), index);
    if (!transaction) return null;
    return transactionObject(transaction, await storage.getChainId(), block.blockHash ?? null);
  },

  eth_getBlockTransactionCountByHash: async (params, { storage }) => {
    expectParamCount(params, 1);
    const block = await storage.getBlockByHash(parseHashParam(params[0], "blockHash"));
    return block ? quantity(BigInt(block.transactionCount)) : null;
  },

  eth_getTransactionReceipt: async (params, { storage }) => {
    expectParamCount(params, 1);
    const hash = parseHashParam(params[0], "transactionHash");
    const transaction = await storage.getTransactionByHash(hash);
    if (!transaction) return null;
    const blockHash = await blockHashOf(transaction, storage);
    const logs =
      transaction.logCount === null
        ? null
        : transaction.logCount === 0
          ? []
          : (await storage.getLogsForTransaction(hash)).map((log) => logObject(log, blockHash));
    return receiptObject(transaction, blockHash, logs);
  },

  eth_getLogs: async (params, { storage }) => {
    expectParamCount(params, 1);
    const filter = params[0];
    if (!isPlainObject(filter)) {
      throw invalidParams("filter must be an object");
    }
    let fromBlock: bigint;
    let toBlock: bigint;
    if (filter.blockHash !== undefined) {
      if (filter.fromBlock !== undefined || filter.toBlock !== undefined) {
        throw invalidParams("blockHash cannot be combined with fromBlock/toBlock");
      }
      const block = await storage.getBlockByHash(parseHashParam(filter.blockHash, "blockHash"));
      if (!block) {
        throw new JsonRpcError(JSON_RPC_SERVER_ERROR, "unknown block");
      }
      fromBlock = toBlock = BigInt(block.blockNumber);
    } else {
      const head = await indexedHead(storage);
      if (head === undefined) return [];
      const from = await resolveBlockTag(filter.fromBlock ?? "latest", storage);
      const to = await resolveBlockTag(filter.toBlock ?? "latest", storage);
      if (from === undefined || to === undefined) return [];
      fromBlock = from;
      toBlock = to > head ? head : to;
    }
    if (toBlock < fromBlock) {
      return [];
    }
    if (toBlock - fromBlock + 1n > BigInt(MAX_LOG_QUERY_BLOCKS)) {
      throw new JsonRpcError(
        JSON_RPC_SERVER_ERROR,
        `block range too large: at most ${MAX_LOG_QUERY_BLOCKS} blocks per eth_getLogs call`,
      );
    }
    const query: LogQueryFilter = { fromBlock, toBlock };
    const addresses = parseAddressFilter(filter.address);
    if (addresses) query.addresses = addresses;
    const topics = parseTopicsFilter(filter.topics);
    if (topics) query.topics = topics;
    let logs: StoredLog[];
    try {
      logs = await storage.queryLogs(query);
    } catch (error) {
      throw new JsonRpcError(JSON_RPC_SERVER_ERROR, error instanceof Error ? error.message : String(error));
    }
    // One lookup for every block in the result, not one per block: a wide
    // query can touch thousands of distinct blocks and serial round trips
    // dominated the call.
    const blockHashes = await storage.getBlockHashesByNumber(logs.map((log) => log.blockNumber));
    return logs.map((log) => logObject(log, blockHashes.get(log.blockNumber) ?? null));
  },
};

// ---------------------------------------------------------------------------
// Chain state helpers

async function requireChainId(storage: JsonRpcDataSource): Promise<bigint> {
  const chainId = await storage.getChainId();
  if (chainId === undefined) {
    throw new JsonRpcError(
      JSON_RPC_SERVER_ERROR,
      "Chain id unknown: the scanner has not stored one yet (it does so on startup)",
    );
  }
  return chainId;
}

/** The newest block the scanner has fully stored, or undefined on an empty database. */
async function indexedHead(storage: JsonRpcDataSource): Promise<bigint | undefined> {
  const progress = await storage.getScannerProgress();
  return progress.lastSuccessfulBlock;
}

/**
 * Turn a block parameter (tag, hex quantity, or EIP-1898 object) into a
 * stored block number. `latest`/`pending`/`safe`/`finalized` all mean the
 * indexed head: the scanner only stores blocks it has read receipts for, so
 * everything stored is as final as this endpoint can promise. Returns
 * undefined when the database holds no blocks yet.
 */
async function resolveBlockTag(param: unknown, storage: JsonRpcDataSource): Promise<bigint | undefined> {
  if (isPlainObject(param)) {
    if (param.blockHash !== undefined) {
      const block = await storage.getBlockByHash(parseHashParam(param.blockHash, "blockHash"));
      if (!block) {
        throw new JsonRpcError(JSON_RPC_SERVER_ERROR, "header for hash not found");
      }
      return BigInt(block.blockNumber);
    }
    if (param.blockNumber !== undefined) {
      return resolveBlockTag(param.blockNumber, storage);
    }
    throw invalidParams("block parameter object needs blockNumber or blockHash");
  }
  if (typeof param !== "string") {
    throw invalidParams("block parameter must be a tag or hex quantity");
  }
  switch (param) {
    case "latest":
    case "pending":
    case "safe":
    case "finalized":
      return indexedHead(storage);
    case "earliest":
      return storage.getMinStoredBlock();
    default:
      return parseQuantityParam(param, "blockNumber");
  }
}

async function resolveStoredBlock(
  param: unknown,
  storage: JsonRpcDataSource,
): Promise<StoredBlock | undefined> {
  const blockNumber = await resolveBlockTag(param, storage);
  if (blockNumber === undefined) return undefined;
  return storage.getBlockByNumber(blockNumber);
}

/** The header hash of the block a stored transaction sits in, when that block row carries one. */
async function blockHashOf(transaction: StoredTransaction, storage: JsonRpcDataSource): Promise<string | null> {
  const block = await storage.getBlockByNumber(BigInt(transaction.blockNumberDecimal));
  return block?.blockHash ?? null;
}

/**
 * geth's oracle: the cheapest tip that landed in each of the last 20 blocks,
 * then the 60th percentile across those. Blocks without stored transactions
 * contribute nothing; with no data at all the suggestion is zero.
 */
async function suggestPriorityFee(storage: JsonRpcDataSource): Promise<bigint> {
  const head = await indexedHead(storage);
  if (head === undefined) return 0n;
  const from = head - GAS_PRICE_ORACLE_BLOCKS + 1n;
  const rows = await storage.getMinPriorityFeePerBlock(from < 0n ? 0n : from, head);
  if (rows.length === 0) return 0n;
  const tips = rows.map((row) => row.minPriorityFeeWei).sort(compareBigInt);
  const index = Math.min(
    tips.length - 1,
    Math.floor(((tips.length - 1) * GAS_PRICE_ORACLE_PERCENTILE) / 100),
  );
  return tips[index]!;
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// eth_feeHistory helpers

function emptyFeeHistory(withReward: boolean): Record<string, unknown> {
  return {
    oldestBlock: "0x0",
    baseFeePerGas: [],
    gasUsedRatio: [],
    ...(withReward ? { reward: [] } : {}),
  };
}

function gasRatio(block: StoredBlock): number {
  const limit = Number(block.maxGasInBlock);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Number(block.totalGasUsed) / limit;
}

/**
 * Per-block reward percentiles, geth's algorithm: transactions sorted by tip
 * ascending, walk the cumulative gas used until it reaches `p%` of the block's
 * gas used, and report that transaction's tip. Empty blocks report zeros.
 */
function rewardsPerBlock(
  blocks: StoredBlock[],
  samples: PriorityFeeSample[],
  percentiles: number[],
): Hex[][] {
  const samplesByBlock = new Map<bigint, PriorityFeeSample[]>();
  for (const sample of samples) {
    const list = samplesByBlock.get(sample.blockNumber);
    if (list) {
      list.push(sample);
    } else {
      samplesByBlock.set(sample.blockNumber, [sample]);
    }
  }
  return blocks.map((block) => {
    const sorted = samplesByBlock.get(BigInt(block.blockNumber)) ?? [];
    if (sorted.length === 0) {
      return percentiles.map(() => "0x0" as Hex);
    }
    const blockGasUsed = Number(block.totalGasUsed);
    let index = 0;
    let cumulativeGas = Number(sorted[0]!.gasUsed);
    return percentiles.map((percentile) => {
      const threshold = (blockGasUsed * percentile) / 100;
      while (cumulativeGas < threshold && index < sorted.length - 1) {
        index += 1;
        cumulativeGas += Number(sorted[index]!.gasUsed);
      }
      return quantity(sorted[index]!.priorityFeeWei);
    });
  });
}

function parseRewardPercentiles(param: unknown): number[] | undefined {
  if (param === undefined || param === null) return undefined;
  if (!Array.isArray(param)) {
    throw invalidParams("rewardPercentiles must be an array of numbers");
  }
  let previous = -1;
  return param.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw invalidParams("rewardPercentiles entries must be numbers between 0 and 100");
    }
    if (value < previous) {
      throw invalidParams("rewardPercentiles must be monotonically increasing");
    }
    previous = value;
    return value;
  });
}

// ---------------------------------------------------------------------------
// Object mappers (Tier 2 — unknown fields are null, see the module comment)

function blockObject(
  block: StoredBlock,
  transactions: StoredTransaction[],
  fullTransactions: boolean,
  chainId: bigint | undefined,
): Record<string, unknown> {
  const blockHash = block.blockHash ?? null;
  return {
    number: quantity(BigInt(block.blockNumber)),
    hash: blockHash,
    parentHash: block.parentHash ?? null,
    nonce: null,
    sha3Uncles: null,
    logsBloom: null,
    transactionsRoot: null,
    stateRoot: null,
    receiptsRoot: null,
    miner: null,
    difficulty: "0x0",
    totalDifficulty: null,
    extraData: null,
    size: null,
    gasLimit: quantity(BigInt(block.maxGasInBlock)),
    gasUsed: quantity(BigInt(block.totalGasUsed)),
    timestamp: quantity(BigInt(Math.floor(Date.parse(block.blockDate) / 1000))),
    baseFeePerGas: quantity(BigInt(block.baseBlockFeeWei)),
    mixHash: null,
    transactions: fullTransactions
      ? transactions.map((transaction) => transactionObject(transaction, chainId, blockHash))
      : transactions.map((transaction) => transaction.hash.toLowerCase()),
    uncles: [],
  };
}

function transactionObject(
  transaction: StoredTransaction,
  chainId: bigint | undefined,
  blockHash: string | null,
): Record<string, unknown> {
  const type = decimalToQuantity(transaction.type) ?? "0x0";
  const isDynamicFee = transaction.maxFeePerGasWei !== null;
  return {
    hash: transaction.hash.toLowerCase(),
    blockHash,
    blockNumber: quantity(BigInt(transaction.blockNumberDecimal)),
    transactionIndex: quantity(BigInt(transaction.position)),
    from: lowerOrNull(transaction.from),
    to: lowerOrNull(transaction.to),
    nonce: decimalToQuantity(transaction.nonce),
    value: quantity(BigInt(transaction.valueWei)),
    gas: quantity(BigInt(transaction.gasLimit)),
    // Nodes report the effective price for mined dynamic-fee transactions.
    gasPrice: decimalToQuantity(transaction.gasPriceWei) ?? quantity(BigInt(transaction.effectiveGasPriceWei)),
    ...(isDynamicFee
      ? {
          maxFeePerGas: decimalToQuantity(transaction.maxFeePerGasWei),
          maxPriorityFeePerGas: decimalToQuantity(transaction.maxPriorityFeePerGasWei),
        }
      : {}),
    type,
    // Calldata is never persisted by the scanner, so input stays null.
    input: null,
    chainId: chainId === undefined ? null : quantity(chainId),
    v: null,
    r: null,
    s: null,
  };
}

function logObject(log: StoredLog, blockHash: string | null): Record<string, unknown> {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: quantity(log.blockNumber),
    transactionHash: log.hash,
    transactionIndex: quantity(BigInt(log.position)),
    blockHash,
    logIndex: quantity(BigInt(log.logIndex)),
    removed: false,
  };
}

function receiptObject(
  transaction: StoredTransaction,
  blockHash: string | null,
  logs: Record<string, unknown>[] | null,
): Record<string, unknown> {
  return {
    transactionHash: transaction.hash.toLowerCase(),
    transactionIndex: quantity(BigInt(transaction.position)),
    blockHash,
    blockNumber: quantity(BigInt(transaction.blockNumberDecimal)),
    from: lowerOrNull(transaction.from),
    to: lowerOrNull(transaction.to),
    cumulativeGasUsed: decimalToQuantity(transaction.cumulativeGasUsed),
    gasUsed: quantity(BigInt(transaction.gasUsed)),
    effectiveGasPrice: quantity(BigInt(transaction.effectiveGasPriceWei)),
    contractAddress: lowerOrNull(transaction.contractAddress),
    // Null only for transactions stored before logs were kept, so a caller
    // cannot mistake "unknown" for "no events".
    logs,
    logsBloom: null,
    status: decimalToQuantity(transaction.status),
    type: decimalToQuantity(transaction.type) ?? "0x0",
  };
}

// ---------------------------------------------------------------------------
// Encoding and parameter validation

/** JSON-RPC quantity encoding: `0x` + minimal hex digits. */
export function quantity(value: bigint): Hex {
  if (value < 0n) {
    throw new Error("Quantities cannot be negative");
  }
  return `0x${value.toString(16)}`;
}

function decimalToQuantity(value: string | null): Hex | null {
  return value === null ? null : quantity(BigInt(value));
}

function lowerOrNull(value: string | null): string | null {
  return value === null ? null : value.toLowerCase();
}

function invalidParams(message: string): JsonRpcError {
  return new JsonRpcError(JSON_RPC_INVALID_PARAMS, `Invalid params: ${message}`);
}

function expectParamCount(params: unknown[], min: number, max: number = min): void {
  if (params.length < min || params.length > max) {
    const expected = min === max ? `${min}` : `${min} to ${max}`;
    throw invalidParams(`expected ${expected} parameter(s), got ${params.length}`);
  }
}

/**
 * Quantities accepted on input. The canonical encoding carries no leading
 * zeros, but nodes decode padded hex (`0x01`) without complaint and clients do
 * send it, so being stricter than the node only breaks callers that work
 * against one. A bare `0x` stays invalid. Output is always canonical — see
 * `quantity()`.
 */
const QUANTITY_PATTERN = /^0x[0-9a-f]+$/i;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

function parseQuantityParam(value: unknown, name: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw invalidParams(`${name} must be a non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw invalidParams(`${name} must be a hex quantity`);
  }
  return BigInt(value);
}

function parseIndexParam(value: unknown, name: string): number {
  const parsed = parseQuantityParam(value, name);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidParams(`${name} is out of range`);
  }
  return Number(parsed);
}

function parseAddressParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw invalidParams(`${name} must be a 20-byte hex address`);
  }
  return value.toLowerCase();
}

function parseHashParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw invalidParams(`${name} must be a 32-byte hex hash`);
  }
  return value.toLowerCase();
}

function parseAddressFilter(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => parseAddressParam(entry, "address"));
}

/**
 * eth_getLogs topics: each position is null (any), a single topic, or a list
 * of alternatives. Returns undefined when nothing is constrained.
 */
function parseTopicsFilter(value: unknown): Array<string[] | undefined> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw invalidParams("topics must be an array");
  }
  if (value.length > 4) {
    throw invalidParams("topics supports at most 4 positions");
  }
  const topics = value.map((entry): string[] | undefined => {
    if (entry === null || entry === undefined) return undefined;
    const list = Array.isArray(entry) ? entry : [entry];
    if (list.length === 0) return undefined;
    return list.map((topic) => parseHashParam(topic, "topic"));
  });
  return topics.some((entry) => entry !== undefined) ? topics : undefined;
}

function parseBooleanParam(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidParams(`${name} must be a boolean`);
  }
  return value;
}
