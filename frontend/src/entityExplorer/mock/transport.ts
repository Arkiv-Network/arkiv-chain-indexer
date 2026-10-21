/**
 * A viem transport that answers Arkiv's JSON-RPC methods from the in-memory
 * mock chain.
 *
 * Mocking at the transport keeps the SDK in the loop: the explorer builds the
 * same client, the SDK sends the same `arkiv_query` and decodes the same
 * response shape it would from a live node. Pointing the explorer at a real
 * node later only means dropping this transport.
 */

import { custom, type Hex, numberToHex } from "viem";
import {
  ARKIV_ADDRESS,
  BLOCK_SECONDS,
  blockTimestamp,
  currentBlock,
  MOCK_CHAIN_ID,
  MockChain,
  type MockEntity,
  toRpcLog,
} from "./dataset";
import { compileQuery, MockQueryError, type MockValue, QUERY_ERROR } from "./queryLanguage";

/** How far back `atBlock` may reach, standing in for a node's retained range. */
const RETAINED_BLOCKS = 10_000n;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
/** Enough latency that loading states show up as they would against a real node. */
const LATENCY_MS = 180;

type RpcSelect = {
  key?: boolean;
  owner?: boolean;
  creator?: boolean;
  createdAt?: boolean;
  updatedAt?: boolean;
  expiresAt?: boolean;
  creationFlags?: boolean;
  attributeSchema?: boolean;
  attributes?: boolean | Record<string, boolean>;
};

type QueryOptions = {
  select?: RpcSelect;
  limit?: Hex;
  cursor?: string;
  atBlock?: Hex | "latest";
};

type Cursor = { query: string; block: string; offset: number };

let chain: MockChain | undefined;

/** One chain per page load, shared by every client, so all views see the same data. */
function getChain(): MockChain {
  chain ??= new MockChain();
  chain.advance();
  return chain;
}

function rpcError(code: number, message: string, data?: unknown) {
  return Object.assign(new Error(message), { code, data });
}

/** The JSON encoding each type uses on the wire. */
function encodeValue(value: MockValue): unknown {
  switch (value.type) {
    case "i32":
      return Number(value.value);
    case "u64":
    case "u256":
      return numberToHex(value.value);
    default:
      return value.value;
  }
}

function toRpcEntity(entity: MockEntity, select: RpcSelect) {
  const out: Record<string, unknown> = {};
  if (select.key) out.key = entity.key;
  if (select.owner) out.owner = entity.owner;
  if (select.creator) out.creator = entity.creator;
  if (select.createdAt) out.createdAt = numberToHex(entity.createdAt);
  if (select.updatedAt) out.updatedAt = numberToHex(entity.updatedAt);
  if (select.expiresAt) out.expiresAt = numberToHex(entity.expiresAt);
  if (select.creationFlags) {
    out.creationFlags = {
      readonly: (entity.flags & 1) !== 0,
      permissionlessExtension: (entity.flags & 2) !== 0,
      raw: entity.flags,
    };
  }
  if (select.attributeSchema) {
    out.attributeSchema = entity.attributes.map(({ name, type, indexed }) => ({
      name,
      type,
      indexed,
    }));
  }
  if (select.attributes) {
    const names = typeof select.attributes === "object" ? select.attributes : null;
    out.attributes = entity.attributes
      .filter((attribute) => !names || names[attribute.name])
      .map((attribute) => ({
        name: attribute.name,
        type: attribute.type,
        value: encodeValue(attribute),
      }));
  }
  return out;
}

function compile(query: unknown) {
  if (typeof query !== "string") throw rpcError(-32602, "query must be a string");
  try {
    return compileQuery(query);
  } catch (error) {
    if (error instanceof MockQueryError) throw rpcError(error.code, error.message, error.data);
    throw error;
  }
}

function resolveBlock(atBlock: Hex | "latest" | undefined, head: bigint): bigint {
  if (atBlock === undefined || atBlock === "latest") return head;
  const block = BigInt(atBlock);
  if (block > head || head - block > RETAINED_BLOCKS) {
    throw rpcError(QUERY_ERROR.block, `block ${block} is outside the retained range`);
  }
  return block;
}

/** Newest first, so an explorer's first page shows recent activity. */
function byNewest(x: MockEntity, y: MockEntity) {
  if (x.createdAt !== y.createdAt) return x.createdAt > y.createdAt ? -1 : 1;
  return x.key < y.key ? -1 : 1;
}

function matching(query: string, block: bigint) {
  const predicate = compile(query);
  return [...getChain().entities.values()]
    .filter((entity) => entity.createdAt <= block && predicate(entity))
    .sort(byNewest);
}

function arkivQuery(query: string, options: QueryOptions = {}) {
  const head = currentBlock();
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Number(BigInt(options.limit));
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw rpcError(-32602, `limit must be between 1 and ${MAX_LIMIT}`);
  }

  let offset = 0;
  let block = resolveBlock(options.atBlock, head);
  if (options.cursor) {
    let cursor: Cursor;
    try {
      cursor = JSON.parse(atob(options.cursor.replace(/^b64:/, "")));
    } catch {
      throw rpcError(QUERY_ERROR.cursor, "malformed cursor");
    }
    if (cursor.query !== query || (options.atBlock && BigInt(cursor.block) !== block)) {
      throw rpcError(QUERY_ERROR.cursor, "cursor belongs to another query or block");
    }
    block = BigInt(cursor.block);
    offset = cursor.offset;
  }

  const select = options.select ?? { key: true };
  const rows = matching(query, block);
  const page = rows.slice(offset, offset + limit);
  const next = offset + limit < rows.length;
  return {
    data: page.map((entity) => toRpcEntity(entity, select)),
    blockNumber: numberToHex(block),
    ...(next && {
      cursor: `b64:${btoa(JSON.stringify({ query, block: block.toString(), offset: offset + limit } satisfies Cursor))}`,
    }),
  };
}

type LogFilter = {
  address?: Hex | Hex[];
  topics?: (Hex | Hex[] | null)[];
  fromBlock?: Hex;
  toBlock?: Hex;
};

function getLogs(filter: LogFilter = {}) {
  const head = currentBlock();
  const from = filter.fromBlock && filter.fromBlock !== ("latest" as Hex) ? BigInt(filter.fromBlock) : head;
  const to = filter.toBlock && filter.toBlock !== ("latest" as Hex) ? BigInt(filter.toBlock) : head;
  const addresses = [filter.address ?? []].flat().map((address) => address.toLowerCase());
  if (addresses.length && !addresses.includes(ARKIV_ADDRESS)) return [];
  return getChain()
    .logs.filter(
      (log) =>
        log.blockNumber >= from &&
        log.blockNumber <= to &&
        (filter.topics ?? []).every((wanted, index) => {
          if (wanted === null || wanted === undefined) return true;
          const options = [wanted].flat().map((topic) => topic.toLowerCase());
          return options.includes(log.topics[index]?.toLowerCase());
        }),
    )
    .sort((x, y) =>
      x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
    )
    .map(toRpcLog);
}

async function handle(method: string, params: unknown[] = []): Promise<unknown> {
  switch (method) {
    case "eth_chainId":
      return numberToHex(MOCK_CHAIN_ID);
    case "eth_blockNumber":
      getChain();
      return numberToHex(currentBlock());
    case "arkiv_getBlockTiming": {
      const head = currentBlock();
      getChain();
      return {
        current_block: Number(head),
        current_block_time: blockTimestamp(head),
        duration: BLOCK_SECONDS,
      };
    }
    case "arkiv_query":
      return arkivQuery(params[0] as string, params[1] as QueryOptions | undefined);
    case "arkiv_getEntity": {
      const entity = getChain().entities.get(String(params[0]).toLowerCase() as Hex);
      return entity
        ? toRpcEntity(entity, {
            key: true,
            owner: true,
            creator: true,
            createdAt: true,
            updatedAt: true,
            expiresAt: true,
            creationFlags: true,
            attributes: true,
          })
        : null;
    }
    case "arkiv_getEntityCount": {
      const options = params[0] as { query?: string } | undefined;
      return options?.query ? matching(options.query, currentBlock()).length : getChain().entities.size;
    }
    case "eth_getLogs":
      return getLogs(params[0] as LogFilter);
    default:
      // eth_newFilter lands here too, which makes viem's watchEvent fall back to getLogs.
      throw rpcError(-32601, `the mock node does not implement ${method}`);
  }
}

export function mockTransport() {
  return custom(
    {
      async request({ method, params }) {
        await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
        return handle(method, params as unknown[]);
      },
    },
    // Errors are deterministic here, and viem would otherwise retry -32005 (cursor) as a rate limit.
    { retryCount: 0 },
  );
}
