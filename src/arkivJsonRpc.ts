/**
 * The `arkiv_*` entity read methods, answered from the experimental entity
 * index instead of a node.
 *
 * Served on `POST /shadow-rpc/experimental` only: `/shadow-rpc` keeps
 * forwarding these methods to a real node, so the two paths are two
 * independent sources for the same questions, and a caller can check one
 * against the other. The wire contract is the UDC node's (arkiv-state-db-
 * experiment, `signed/rpc_reads.rs`) and the SDK's (`RpcSelect`,
 * `RpcQueryOptions`): the same methods (`arkiv_query`, `arkiv_getEntityCount`,
 * `arkiv_getBlockTiming`), the same parameter rules, the same `select` keys and
 * defaults, the same entity JSON, the same result order (oldest first by
 * entity id) and the same error codes and messages. Where the index cannot
 * honour something the node does, it says so instead of approximating:
 *
 * - `blockNumber` without `atBlock` is the **projection head** — the newest
 *   block the projector has folded — never the chain head;
 * - `atBlock` must lie between the index floor and that head (`-32006`);
 * - a `bytes` attribute's value is `null`: the index keeps its keccak256 and
 *   size, never its content (`attributeSchema` still lists it); read the bytes
 *   from a node;
 * - cursors are the index's own (the node's are process-local), so a cursor
 *   from one source is refused by the other;
 * - entities created before the floor are unknown, so a count is a count of
 *   what the index holds.
 */
import { keccak256 } from "viem";
import type { EntityVersion } from "./entityIndex";
import type { EntityCursorPosition, EntityIndexProgress, EntityIndexReader } from "./entityIndexStorage";
import { QueryParseError, parseEntityQuery, queryErrorBody, type QueryAst } from "./entityQueryLanguage";
import { TYPE_TAGS_BY_ID, hexQuantity, wireAttributeValue } from "./entityValues";
import { JSON_RPC_INVALID_PARAMS, JSON_RPC_SERVER_ERROR, JsonRpcError, type JsonRpcMethodHandler } from "./jsonRpc";
import type { ScannerProgress, StoredBlock } from "./storage";

/** The methods the index answers; the node has no `arkiv_getEntity`. */
export const ARKIV_INDEX_METHODS = ["arkiv_query", "arkiv_getEntityCount", "arkiv_getBlockTiming"] as const;

export const JSON_RPC_CURSOR_ERROR = -32005;
export const JSON_RPC_BLOCK_UNAVAILABLE = -32006;

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;
/** Most attribute names one `select.attributes` map may name (the node's cap). */
export const MAX_SELECTED_ATTRIBUTES = 256;

/** The chain-level reads the timing method needs; `ScannerStorage` satisfies it. */
export interface ArkivChainReader {
  getScannerProgress(): Promise<ScannerProgress>;
  getBlockByNumber(blockNumber: bigint): Promise<StoredBlock | undefined>;
}

/**
 * The node refuses every malformed parameter with this one bare message; the
 * index answers alike, so the two compare equal.
 */
function invalidParams(): JsonRpcError {
  return new JsonRpcError(JSON_RPC_INVALID_PARAMS, "InvalidParams");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Projection (`select`)

/** The SDK's `RpcSelect` keys, in the node's response order. */
export const SELECT_FIELDS = [
  "key",
  "owner",
  "creator",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "creationFlags",
  "attributeSchema",
  "attributes",
] as const;

export type AttributeProjection = { mode: "off" } | { mode: "all" } | { mode: "named"; names: Set<string> };

export interface Projection {
  key: boolean;
  owner: boolean;
  creator: boolean;
  createdAt: boolean;
  updatedAt: boolean;
  expiresAt: boolean;
  creationFlags: boolean;
  attributeSchema: boolean;
  attributes: AttributeProjection;
}

/** The node's default: the key and nothing else. */
export function defaultProjection(): Projection {
  return {
    key: true,
    owner: false,
    creator: false,
    createdAt: false,
    updatedAt: false,
    expiresAt: false,
    creationFlags: false,
    attributeSchema: false,
    attributes: { mode: "off" },
  };
}

/** The node's `protocol_name`: what a `select.attributes` map may name. */
function isProtocolName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(name);
}

/**
 * The node's `select` rules: an object whose keys are {@link SELECT_FIELDS}
 * with boolean values, except `attributes`, which may also map attribute names
 * to booleans. Anything else — `payload` and `contentType` included — is
 * `-32602`. `key` is selected unless the selection sets it false.
 */
export function parseProjection(select: unknown): Projection {
  if (select === undefined) return defaultProjection();
  if (!isPlainObject(select)) throw invalidParams();
  const projection = defaultProjection();
  for (const [field, value] of Object.entries(select)) {
    if (!(SELECT_FIELDS as readonly string[]).includes(field)) throw invalidParams();
    if (field === "attributes" && isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > MAX_SELECTED_ATTRIBUTES) throw invalidParams();
      const names = new Set<string>();
      for (const [name, wanted] of entries) {
        if (!isProtocolName(name) || typeof wanted !== "boolean") throw invalidParams();
        if (wanted) names.add(name);
      }
      projection.attributes = { mode: "named", names };
      continue;
    }
    if (typeof value !== "boolean") throw invalidParams();
    if (field === "attributes") projection.attributes = value ? { mode: "all" } : { mode: "off" };
    else projection[field as Exclude<(typeof SELECT_FIELDS)[number], "attributes">] = value;
  }
  return projection;
}

/** A stable encoding of a projection, which a cursor is bound to. */
export function projectionFingerprint(projection: Projection): Uint8Array {
  const bytes: number[] = [
    projection.key,
    projection.owner,
    projection.creator,
    projection.createdAt,
    projection.updatedAt,
    projection.expiresAt,
    projection.creationFlags,
    projection.attributeSchema,
  ].map((flag) => (flag ? 1 : 0));
  switch (projection.attributes.mode) {
    case "off":
      bytes.push(0);
      break;
    case "all":
      bytes.push(1);
      break;
    case "named":
      bytes.push(2);
      for (const name of [...projection.attributes.names].sort()) {
        bytes.push(...Buffer.from(name, "utf8"), 0);
      }
  }
  return Uint8Array.from(bytes);
}

// ---------------------------------------------------------------------------
// Cursors. The node's are 66-character hex tokens into a process-local cache;
// the index's have the same shape but carry their position, bound to the
// query, block and selection that produced them.

const BINDING_LENGTH = 16;
/** Creation block (u64), transaction position (u32), operation index (u32). */
const CURSOR_LENGTH = BINDING_LENGTH + 8 + 4 + 4;
const CURSOR_MESSAGE =
  "query rejected (cursor): the cursor expired, is malformed, or belongs to another query, block or selection";

export function cursorError(): JsonRpcError {
  return new JsonRpcError(JSON_RPC_CURSOR_ERROR, CURSOR_MESSAGE);
}

/** Ties a cursor to its query, block and projection. */
export function cursorBinding(query: string, block: bigint, fingerprint: Uint8Array): Buffer {
  const queryBytes = Buffer.from(query, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(queryBytes.length));
  const height = Buffer.alloc(8);
  height.writeBigUInt64BE(block);
  const preimage = Buffer.concat([Buffer.from("arkiv.index.cursor", "ascii"), length, queryBytes, height, Buffer.from(fingerprint)]);
  return Buffer.from(keccak256(preimage).slice(2), "hex").subarray(0, BINDING_LENGTH);
}

export function encodeCursor(position: EntityCursorPosition, binding: Buffer): string {
  const raw = Buffer.alloc(CURSOR_LENGTH);
  binding.copy(raw, 0);
  raw.writeBigUInt64BE(position.createdAt, BINDING_LENGTH);
  raw.writeUInt32BE(position.position, BINDING_LENGTH + 8);
  raw.writeUInt32BE(position.opIndex, BINDING_LENGTH + 12);
  return `0x${raw.toString("hex")}`;
}

const MAX_CURSOR_CREATED_AT = (1n << 63n) - 1n;

/** Any cursor this request cannot resume — malformed, foreign, or the node's — is the node's `-32005`. */
export function decodeCursor(token: unknown, binding: Buffer): EntityCursorPosition {
  if (typeof token !== "string" || !/^0x[0-9a-f]{64}$/.test(token)) throw cursorError();
  const raw = Buffer.from(token.slice(2), "hex");
  if (!raw.subarray(0, BINDING_LENGTH).equals(binding)) throw cursorError();
  const createdAt = raw.readBigUInt64BE(BINDING_LENGTH);
  // The index binds this to a bigint column; a forged value past 2^63 - 1
  // would surface as a driver error instead of a cursor error.
  if (createdAt > MAX_CURSOR_CREATED_AT) throw cursorError();
  return { createdAt, position: raw.readUInt32BE(BINDING_LENGTH + 8), opIndex: raw.readUInt32BE(BINDING_LENGTH + 12) };
}

// ---------------------------------------------------------------------------
// Options

export interface QueryOptions {
  /** Undefined: the projection head. */
  atBlock: bigint | undefined;
  /** The raw `select`, `limit` and `cursor`, checked after the block (the node's order). */
  select: unknown;
  limit: unknown;
  /** Present when the request carried a `cursor` key, whatever its value. */
  cursor: { token: unknown } | undefined;
}

const QUERY_OPTION_FIELDS = ["atBlock", "select", "limit", "cursor"] as const;

/** The node's quantity: a JSON integer, or `0x` hex without leading zeros. */
export function parseQuantity(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw invalidParams();
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw invalidParams();
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n) throw invalidParams();
  return parsed;
}

export function resolveLimit(requested: bigint | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE;
  if (requested < 1n || requested > BigInt(MAX_PAGE_SIZE)) throw invalidParams();
  return Number(requested);
}

/**
 * The second `arkiv_query` parameter's shape and `atBlock`, which the node
 * checks before the block itself; `select` and `limit` are checked after it
 * (see {@link parseProjection} and {@link resolveLimit}).
 */
export function parseQueryOptions(raw: unknown): QueryOptions {
  const options = raw === undefined ? {} : raw;
  if (!isPlainObject(options)) throw invalidParams();
  if (Object.keys(options).some((field) => !(QUERY_OPTION_FIELDS as readonly string[]).includes(field))) {
    throw invalidParams();
  }
  return {
    atBlock: "atBlock" in options ? parseQuantity(options.atBlock) : undefined,
    select: options.select,
    limit: options.limit,
    cursor: "cursor" in options ? { token: options.cursor } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Entity → wire

export function projectEntity(entity: EntityVersion, projection: Projection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (projection.key) out.key = entity.entityKey;
  if (projection.owner) out.owner = entity.owner;
  if (projection.creator) out.creator = entity.creator;
  if (projection.createdAt) out.createdAt = hexQuantity(BigInt(entity.createdAt));
  if (projection.updatedAt) out.updatedAt = hexQuantity(BigInt(entity.updatedAt));
  if (projection.expiresAt) out.expiresAt = hexQuantity(entity.expiresAt);
  if (projection.creationFlags) {
    out.creationFlags =
      entity.creationFlags === null
        ? null
        : {
            raw: entity.creationFlags,
            readonly: (entity.creationFlags & 1) !== 0,
            permissionlessExtension: (entity.creationFlags & 2) !== 0,
          };
  }
  if (projection.attributeSchema) {
    out.attributeSchema = entity.attributes.map((attribute) => ({
      name: attribute.name,
      type: TYPE_TAGS_BY_ID.get(attribute.typeId) ?? "unknown",
      indexed: attribute.indexed,
    }));
  }
  if (projection.attributes.mode !== "off") {
    const wanted = projection.attributes;
    out.attributes = entity.attributes
      .filter((attribute) => wanted.mode === "all" || wanted.names.has(attribute.name))
      .map((attribute) => {
        const tag = TYPE_TAGS_BY_ID.get(attribute.typeId);
        return {
          name: attribute.name,
          type: tag ?? "unknown",
          // bytes answers null: the index never holds the content.
          value: tag ? wireAttributeValue(tag, attribute) : null,
        };
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Methods

function parseQuery(text: string): QueryAst {
  try {
    return parseEntityQuery(text);
  } catch (error) {
    if (error instanceof QueryParseError) {
      const body = queryErrorBody(error, text);
      throw new JsonRpcError(body.code, body.message, body.data);
    }
    throw error;
  }
}

interface ResolvedBlock {
  block: bigint;
  atHead: boolean;
}

function blockUnavailable(message: string): JsonRpcError {
  return new JsonRpcError(JSON_RPC_BLOCK_UNAVAILABLE, `query rejected (block): ${message}`);
}

/** The block a read evaluates at: the projection head when none is asked for, else a block the index covers. */
function resolveBlock(progress: EntityIndexProgress, requested: bigint | undefined): ResolvedBlock {
  if (progress.readiness?.ready === false) throw new JsonRpcError(JSON_RPC_SERVER_ERROR, `the entity index is incomplete: ${progress.readiness.reason}`);
  const head = progress.projectedThroughBlock;
  if (head === undefined) {
    throw new JsonRpcError(
      JSON_RPC_SERVER_ERROR,
      "the entity index has not projected any block yet; try again once the projector has caught up",
    );
  }
  if (requested === undefined) return { block: head, atHead: true };
  if (requested > head) throw blockUnavailable(`block ${requested} is above the entity index head ${head}`);
  if (progress.floorBlock !== undefined && requested < progress.floorBlock) {
    throw blockUnavailable(`block ${requested} is below the entity index floor ${progress.floorBlock}`);
  }
  return { block: requested, atHead: requested === head };
}

function cursorPosition(entity: EntityVersion): EntityCursorPosition {
  return { createdAt: BigInt(entity.createdAt), position: entity.createdPosition, opIndex: entity.createdOpIndex };
}

/** Build the handlers for {@link ARKIV_INDEX_METHODS}. */
export function createArkivIndexMethods(
  index: EntityIndexReader,
  chain: ArkivChainReader,
): Record<(typeof ARKIV_INDEX_METHODS)[number], JsonRpcMethodHandler> {
  return {
    arkiv_query: async (params) => {
      if (params.length < 1 || params.length > 2 || typeof params[0] !== "string") throw invalidParams();
      const query = params[0];
      const ast = parseQuery(query);
      const options = parseQueryOptions(params.length === 2 ? params[1] : undefined);
      const progress = await index.getProgress();
      const { block, atHead } = resolveBlock(progress, options.atBlock);
      const projection = parseProjection(options.select);
      const limit = resolveLimit(options.limit === undefined ? undefined : parseQuantity(options.limit));
      const binding = cursorBinding(query, block, projectionFingerprint(projection));
      let after: EntityCursorPosition | undefined;
      if (options.cursor) {
        // A cursor pins a block, so the node refuses one without `atBlock`.
        if (options.atBlock === undefined) throw cursorError();
        after = decodeCursor(options.cursor.token, binding);
      }
      const page = await index.queryEntities(ast, {
        block,
        atHead,
        limit,
        ...(after ? { after } : {}),
      });
      const last = page.entities[page.entities.length - 1];
      return {
        data: page.entities.map((entity) => projectEntity(entity, projection)),
        blockNumber: hexQuantity(block),
        ...(page.hasMore && last ? { cursor: encodeCursor(cursorPosition(last), binding) } : {}),
      };
    },

    arkiv_getEntityCount: async (params) => {
      if (params.length > 1) throw invalidParams();
      const request = params[0] === undefined || params[0] === null ? {} : params[0];
      if (!isPlainObject(request)) throw invalidParams();
      // The node takes the block as a JSON integer only (a hex string is -32602).
      let requested: bigint | undefined;
      if (request.block !== undefined && request.block !== null) {
        if (typeof request.block !== "number" || !Number.isSafeInteger(request.block) || request.block < 0) {
          throw invalidParams();
        }
        requested = BigInt(request.block);
      }
      const { block, atHead } = resolveBlock(await index.getProgress(), requested);
      let ast: QueryAst = { kind: "all" };
      if (request.query !== undefined && request.query !== null) {
        if (typeof request.query !== "string") throw invalidParams();
        ast = parseQuery(request.query);
      }
      return index.countEntities(ast, block, atHead);
    },

    arkiv_getBlockTiming: async (params) => {
      if (params.length !== 0) throw invalidParams();
      // The projection head, as an `atBlock`-less read is: a caller that pins
      // a read to `current_block` must land on a block the index can answer
      // for, and the chain head the scanner has reached may be a few blocks
      // ahead.
      const progress = await index.getProgress();
      const head = resolveBlock(progress, undefined).block;
      const block = await chain.getBlockByNumber(head);
      if (!block) {
        throw new JsonRpcError(JSON_RPC_SERVER_ERROR, "the entity index has not projected any block yet");
      }
      const currentBlockTime = Math.floor(Date.parse(block.blockDate) / 1000);
      const previous = head > 0n ? await chain.getBlockByNumber(head - 1n) : undefined;
      const duration = previous ? Math.max(0, currentBlockTime - Math.floor(Date.parse(previous.blockDate) / 1000)) : 0;
      return { current_block: Number(head), current_block_time: currentBlockTime, duration };
    },
  };
}
