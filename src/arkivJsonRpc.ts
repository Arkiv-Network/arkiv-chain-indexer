/**
 * The `arkiv_*` entity read methods, answered from the experimental entity
 * index instead of a node.
 *
 * Served on `POST /shadow-rpc/experimental` only: `/shadow-rpc` keeps
 * forwarding these methods to a real node, so the two paths are two
 * independent sources for the same questions, and a caller can check one
 * against the other. The wire contract is the node's (`arkiv-rpc-types`,
 * `arkiv-reth-rpc` in `~/arkiv-network/arkiv`): the same parameter shapes,
 * the same projection rules, the same error codes and, where it matters, the
 * same messages. Where the index cannot honour something the node does, it
 * says so instead of approximating:
 *
 * - `latest` (and the reported `blockNumber`) is the **projection head** — the
 *   newest block the projector has folded — never the chain head;
 * - `atBlock` must lie between the index floor and that head (`-32006`);
 * - `select.payload` is refused (`-32000`): payload bytes are never stored;
 * - `creationFlags` is `null` for entities whose creation the index only knows
 *   from calldata (created before receipt logs were stored);
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

/** The methods the index answers; the same four the passthrough forwards by default. */
export const ARKIV_INDEX_METHODS = ["arkiv_query", "arkiv_getEntity", "arkiv_getEntityCount", "arkiv_getBlockTiming"] as const;

export const JSON_RPC_CURSOR_ERROR = -32005;
export const JSON_RPC_BLOCK_UNAVAILABLE = -32006;

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;

/** The chain-level reads the timing method needs; `ScannerStorage` satisfies it. */
export interface ArkivChainReader {
  getScannerProgress(): Promise<ScannerProgress>;
  getBlockByNumber(blockNumber: bigint): Promise<StoredBlock | undefined>;
}

// ---------------------------------------------------------------------------
// Projection (`select`)

export type AttributeProjection = { mode: "off" } | { mode: "all" } | { mode: "named"; names: Set<string> };

export interface Projection {
  key: boolean;
  owner: boolean;
  creator: boolean;
  createdAt: boolean;
  updatedAt: boolean;
  expiresAt: boolean;
  creationFlags: boolean;
  contentType: boolean;
  payload: boolean;
  attributeSchema: boolean;
  attributes: AttributeProjection;
}

const SELECT_FIELDS = [
  "key",
  "owner",
  "creator",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "creationFlags",
  "contentType",
  "payload",
  "attributeSchema",
  "attributes",
] as const;

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
    contentType: false,
    payload: false,
    attributeSchema: false,
    attributes: { mode: "off" },
  };
}

/** What `arkiv_getEntity` answers with: everything but the schema list. */
function fullProjection(): Projection {
  return {
    key: true,
    owner: true,
    creator: true,
    createdAt: true,
    updatedAt: true,
    expiresAt: true,
    creationFlags: true,
    contentType: true,
    payload: true,
    attributeSchema: false,
    attributes: { mode: "all" },
  };
}

function invalidParams(message: string): JsonRpcError {
  return new JsonRpcError(JSON_RPC_INVALID_PARAMS, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a sequence";
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return "a map";
}

export function parseProjection(select: unknown): Projection {
  if (select === undefined || select === null) return defaultProjection();
  if (!isPlainObject(select)) {
    throw invalidParams(`invalid options param: invalid type: ${describeJsonType(select)}, expected struct Select`);
  }
  const projection = defaultProjection();
  projection.key = false;
  for (const [field, value] of Object.entries(select)) {
    if (!(SELECT_FIELDS as readonly string[]).includes(field)) {
      throw invalidParams(
        `invalid options param: unknown field \`${field}\`, expected one of ${SELECT_FIELDS.map((name) => `\`${name}\``).join(", ")}`,
      );
    }
    if (field === "attributes") {
      if (typeof value === "boolean") {
        projection.attributes = value ? { mode: "all" } : { mode: "off" };
      } else if (isPlainObject(value)) {
        const names = new Set<string>();
        for (const [name, wanted] of Object.entries(value)) {
          if (typeof wanted !== "boolean") {
            throw invalidParams(
              `invalid options param: invalid type: ${describeJsonType(wanted)}, expected a boolean for attribute \`${name}\``,
            );
          }
          if (wanted) names.add(name);
        }
        projection.attributes = { mode: "named", names };
      } else {
        throw invalidParams(
          `invalid options param: invalid type: ${describeJsonType(value)}, expected a boolean or a map of attribute names to booleans`,
        );
      }
      continue;
    }
    if (typeof value !== "boolean") {
      throw invalidParams(`invalid options param: invalid type: ${describeJsonType(value)}, expected a boolean`);
    }
    projection[field as Exclude<(typeof SELECT_FIELDS)[number], "attributes">] = value;
  }
  return projection;
}

/** The node's stable encoding of a projection, which a cursor is bound to. */
export function projectionFingerprint(projection: Projection): Uint8Array {
  const bytes: number[] = [
    projection.key,
    projection.owner,
    projection.creator,
    projection.createdAt,
    projection.updatedAt,
    projection.expiresAt,
    projection.creationFlags,
    projection.contentType,
    projection.payload,
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
// Cursors — the node's shape: base64url of a request binding plus a position.

const CURSOR_PREFIX = "b64:";
const BINDING_LENGTH = 8;
/** Creation block (u64), transaction position (u32) and the 32-byte entity key. */
const POSITION_LENGTH = 8 + 4 + 32;

function u64be(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

/** Ties a cursor to its query, block and projection, as the node does. */
export function cursorBinding(query: string, block: bigint, fingerprint: Uint8Array): Buffer {
  const queryBytes = Buffer.from(query, "utf8");
  const preimage = Buffer.concat([
    Buffer.from("arkiv.cursor", "ascii"),
    u64be(BigInt(queryBytes.length)),
    queryBytes,
    u64be(block),
    Buffer.from(fingerprint),
  ]);
  return Buffer.from(keccak256(preimage).slice(2), "hex").subarray(0, BINDING_LENGTH);
}

export function encodeCursor(position: EntityCursorPosition, binding: Buffer): string {
  const raw = Buffer.alloc(BINDING_LENGTH + POSITION_LENGTH);
  binding.copy(raw, 0);
  raw.writeBigUInt64BE(position.createdAt, BINDING_LENGTH);
  raw.writeUInt32BE(position.position, BINDING_LENGTH + 8);
  Buffer.from(position.entityKey.slice(2), "hex").copy(raw, BINDING_LENGTH + 12);
  return `${CURSOR_PREFIX}${raw.toString("base64url")}`;
}

/** The node's cursor carries an 8-byte entity id after the binding; the index has no such id. */
const NODE_POSITION_LENGTH = 8;

const CURSOR_MALFORMED = "cursor is malformed — pass back the cursor from the previous page";
const CURSOR_MISMATCHED = "cursor belongs to a different query, block or select — start a new page-through";
const CURSOR_FROM_NODE = "cursor was issued by a node, not by the entity index — page through one source from its first page";

function cursorError(message: string): JsonRpcError {
  return new JsonRpcError(JSON_RPC_CURSOR_ERROR, message, { message });
}

export function decodeCursor(text: string, binding: Buffer): EntityCursorPosition {
  if (!text.startsWith(CURSOR_PREFIX)) throw cursorError(CURSOR_MALFORMED);
  const encoded = text.slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw cursorError(CURSOR_MALFORMED);
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length === BINDING_LENGTH + NODE_POSITION_LENGTH) {
    // A well-formed node cursor. Its binding is computed exactly as ours, so a
    // foreign one is told apart the way the node tells it; one that matches
    // this very request cannot be resumed here, and says why.
    if (!raw.subarray(0, BINDING_LENGTH).equals(binding)) throw cursorError(CURSOR_MISMATCHED);
    throw cursorError(CURSOR_FROM_NODE);
  }
  if (raw.length !== BINDING_LENGTH + POSITION_LENGTH) throw cursorError(CURSOR_MALFORMED);
  if (!raw.subarray(0, BINDING_LENGTH).equals(binding)) throw cursorError(CURSOR_MISMATCHED);
  return {
    createdAt: raw.readBigUInt64BE(BINDING_LENGTH),
    position: raw.readUInt32BE(BINDING_LENGTH + 8),
    entityKey: `0x${raw.subarray(BINDING_LENGTH + 12).toString("hex")}`,
  };
}

// ---------------------------------------------------------------------------
// Options

export interface QueryOptions {
  atBlock: bigint | "latest";
  projection: Projection;
  limit: number;
  cursor: string | undefined;
}

const QUERY_OPTION_FIELDS = ["atBlock", "select", "limit", "cursor"] as const;

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

/** A chain quantity in either spelling: a hex string or a JSON number. A bare string is read as hex, as the node reads it. */
function parseFlexibleQuantity(value: unknown, what: string): bigint {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw invalidParams(`invalid options param: invalid value: ${describeJsonType(value)}, expected u64 for ${what}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const stripped = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]+$/.test(stripped)) {
      throw invalidParams(`invalid options param: invalid hex quantity ${JSON.stringify(value)} for ${what}`);
    }
    return BigInt(`0x${stripped}`);
  }
  throw invalidParams(`invalid options param: invalid type: ${describeJsonType(value)}, expected a hex quantity for ${what}`);
}

export function resolveLimit(requested: bigint | undefined): number {
  if (requested === undefined) return DEFAULT_PAGE_SIZE;
  if (requested === 0n) throw invalidParams("limit must be at least 1");
  if (requested > BigInt(MAX_PAGE_SIZE)) {
    throw invalidParams(`limit ${requested} exceeds the node maximum of ${MAX_PAGE_SIZE}`);
  }
  return Number(requested);
}

function parseAtBlock(value: unknown): bigint | "latest" {
  if (value === undefined || value === null) return "latest";
  if (typeof value !== "string") {
    throw invalidParams(`invalid options param: invalid type: ${describeJsonType(value)}, expected a string`);
  }
  if (value === "latest") return "latest";
  if (HEX_QUANTITY.test(value)) return BigInt(value);
  if (["earliest", "pending", "safe", "finalized"].includes(value)) {
    throw invalidParams(`atBlock tag ${value} not supported; use a hex block number or 'latest'`);
  }
  throw invalidParams(`invalid options param: invalid block number ${JSON.stringify(value)}, expected a hex quantity or 'latest'`);
}

export function parseQueryOptions(raw: unknown): QueryOptions {
  if (raw === undefined || raw === null) {
    return { atBlock: "latest", projection: defaultProjection(), limit: DEFAULT_PAGE_SIZE, cursor: undefined };
  }
  if (!isPlainObject(raw)) {
    throw invalidParams(`invalid options param: invalid type: ${describeJsonType(raw)}, expected struct QueryOptions`);
  }
  for (const field of Object.keys(raw)) {
    if (!(QUERY_OPTION_FIELDS as readonly string[]).includes(field)) {
      throw invalidParams(
        `invalid options param: unknown field \`${field}\`, expected one of ${QUERY_OPTION_FIELDS.map((name) => `\`${name}\``).join(", ")}`,
      );
    }
  }
  const limit = raw.limit === undefined || raw.limit === null ? undefined : parseFlexibleQuantity(raw.limit, "limit");
  if (raw.cursor !== undefined && raw.cursor !== null && typeof raw.cursor !== "string") {
    throw invalidParams(`invalid options param: invalid type: ${describeJsonType(raw.cursor)}, expected a string`);
  }
  return {
    atBlock: parseAtBlock(raw.atBlock),
    projection: parseProjection(raw.select),
    limit: resolveLimit(limit),
    cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
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
            readonly: (entity.creationFlags & 1) !== 0,
            permissionlessExtension: (entity.creationFlags & 2) !== 0,
            raw: entity.creationFlags,
          };
  }
  if (projection.contentType) out.contentType = entity.contentType;
  if (projection.attributeSchema) {
    out.attributeSchema = entity.attributes.map((attribute) => ({
      name: attribute.name,
      type: TYPE_TAGS_BY_ID.get(attribute.typeId) ?? "unknown",
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
          value: tag ? wireAttributeValue(tag, attribute) : attribute.valueText,
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
      const body = queryErrorBody(error);
      throw new JsonRpcError(body.code, body.message, body.data);
    }
    throw error;
  }
}

interface ResolvedBlock {
  block: bigint;
  atHead: boolean;
}

function blockUnavailable(requested: bigint, latest: bigint, reason: string): JsonRpcError {
  const message = `block ${requested} is unavailable: ${reason}`;
  return new JsonRpcError(JSON_RPC_BLOCK_UNAVAILABLE, message, {
    requested: Number(requested),
    latest: Number(latest),
    message,
  });
}

/** The block a read evaluates at: the projection head for `latest`, else a block the index covers. */
function resolveBlock(progress: EntityIndexProgress, requested: bigint | "latest"): ResolvedBlock {
  const head = progress.projectedThroughBlock;
  if (head === undefined) {
    throw new JsonRpcError(
      JSON_RPC_SERVER_ERROR,
      "the entity index has not projected any block yet; try again once the projector has caught up",
    );
  }
  if (requested === "latest") return { block: head, atHead: true };
  if (requested > head) throw blockUnavailable(requested, head, "ahead of the entity index head");
  if (progress.floorBlock !== undefined && requested < progress.floorBlock) {
    throw blockUnavailable(requested, head, `before the entity index floor (block ${progress.floorBlock})`);
  }
  return { block: requested, atHead: requested === head };
}

function refusePayload(projection: Projection): void {
  if (projection.payload) {
    throw new JsonRpcError(
      JSON_RPC_SERVER_ERROR,
      "payload is not available from the entity index: payload bytes are never stored; select it through a node",
    );
  }
}

function parseEntityKeyParam(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw invalidParams("invalid params: expected a 32-byte hex entity key");
  }
  return value.toLowerCase();
}

function parseBlockNumberParam(value: unknown, what: string): bigint | "latest" {
  if (value === undefined || value === null) return "latest";
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  throw invalidParams(`invalid ${what}: invalid type: ${describeJsonType(value)}, expected u64`);
}

function cursorPosition(entity: EntityVersion): EntityCursorPosition {
  return { createdAt: BigInt(entity.createdAt), position: entity.createdPosition, entityKey: entity.entityKey };
}

/** Build the handlers for {@link ARKIV_INDEX_METHODS}. */
export function createArkivIndexMethods(
  index: EntityIndexReader,
  chain: ArkivChainReader,
): Record<(typeof ARKIV_INDEX_METHODS)[number], JsonRpcMethodHandler> {
  return {
    arkiv_query: async (params) => {
      if (params.length < 1 || params.length > 2) {
        throw invalidParams(`invalid params: expected 1 to 2 parameter(s), got ${params.length}`);
      }
      if (typeof params[0] !== "string") {
        throw invalidParams(`invalid query param: invalid type: ${describeJsonType(params[0])}, expected a string`);
      }
      const query = params[0];
      const options = parseQueryOptions(params[1]);
      const ast = parseQuery(query);
      refusePayload(options.projection);
      const progress = await index.getProgress();
      const { block, atHead } = resolveBlock(progress, options.atBlock);
      const binding = cursorBinding(query, block, projectionFingerprint(options.projection));
      const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor, binding);
      const page = await index.queryEntities(ast, {
        block,
        atHead,
        limit: options.limit,
        ...(after ? { after } : {}),
      });
      const last = page.entities[page.entities.length - 1];
      return {
        data: page.entities.map((entity) => projectEntity(entity, options.projection)),
        blockNumber: hexQuantity(block),
        ...(page.hasMore && last ? { cursor: encodeCursor(cursorPosition(last), binding) } : {}),
      };
    },

    arkiv_getEntity: async (params) => {
      if (params.length < 1 || params.length > 2) {
        throw invalidParams(`invalid params: expected 1 to 2 parameter(s), got ${params.length}`);
      }
      const key = parseEntityKeyParam(params[0]);
      const requested = parseBlockNumberParam(params[1], "block param");
      const { block, atHead } = resolveBlock(await index.getProgress(), requested);
      const entity = await index.getEntity(key, block, atHead);
      if (!entity) return null;
      // Everything the node returns except the payload, which the index does
      // not hold; the field is absent rather than null, as an unselected one is.
      const projection = fullProjection();
      projection.payload = false;
      return projectEntity(entity, projection);
    },

    arkiv_getEntityCount: async (params) => {
      if (params.length > 1) {
        throw invalidParams(`invalid params: expected 0 to 1 parameter(s), got ${params.length}`);
      }
      const request = params[0];
      let ast: QueryAst = { kind: "all" };
      let requested: bigint | "latest" = "latest";
      if (request !== undefined && request !== null) {
        if (!isPlainObject(request)) {
          throw invalidParams(`invalid params: invalid type: ${describeJsonType(request)}, expected struct CountRequest`);
        }
        if (request.query !== undefined && request.query !== null) {
          if (typeof request.query !== "string") {
            throw invalidParams(`invalid params: invalid type: ${describeJsonType(request.query)}, expected a string`);
          }
          ast = parseQuery(request.query);
        }
        requested = parseBlockNumberParam(request.block, "params");
      }
      const { block, atHead } = resolveBlock(await index.getProgress(), requested);
      return index.countEntities(ast, block, atHead);
    },

    arkiv_getBlockTiming: async (params) => {
      if (params.length !== 0) {
        throw invalidParams(`invalid params: expected 0 parameter(s), got ${params.length}`);
      }
      // The projection head, as `latest` is: a caller that pins a read to
      // `current_block` must land on a block the index can answer for, and
      // the chain head the scanner has reached may be a few blocks ahead.
      const head = (await index.getProgress()).projectedThroughBlock;
      const block = head === undefined ? undefined : await chain.getBlockByNumber(head);
      if (head === undefined || !block) {
        throw new JsonRpcError(JSON_RPC_SERVER_ERROR, "the entity index has not projected any block yet");
      }
      const currentBlockTime = Math.floor(Date.parse(block.blockDate) / 1000);
      const previous = head > 0n ? await chain.getBlockByNumber(head - 1n) : undefined;
      const duration = previous ? Math.max(0, currentBlockTime - Math.floor(Date.parse(previous.blockDate) / 1000)) : 0;
      return { current_block: Number(head), current_block_time: currentBlockTime, duration };
    },
  };
}
