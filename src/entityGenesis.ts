/**
 * Importing the entities a chain was born with, for the experimental entity
 * index behind `POST /shadow-rpc/experimental`.
 *
 * A seeded genesis (arkiv-prefill: `arkiv-cli seed-genesis`, then `arkiv-reth
 * init-state`) bakes a dataset into block 0's state. No transaction created
 * those entities and no receipt announced them — block 0 is a header and a
 * state — so the fold in `entityIndex.ts`, which replays operations, never
 * sees them, and an index built from operations alone opens with a hole the
 * size of the dataset.
 *
 * This module fills the hole from the node. `arkiv_query("*")` pinned at
 * block 0 pages every genesis entity newest-first — the node's entity-id
 * order, and ids were handed out in seed order, `0..N-1` — and each entity
 * becomes a version-0 row with `created_at = 0`, the genesis marker (block 0
 * never carries a transaction), and `created_position` = its id, so the
 * index's `(created_at, created_position, key)` order reproduces the node's
 * and its cursors page correctly. The walk resumes from a stored cursor: the
 * node binds a cursor to the query text, the block and the `select`, all of
 * which are constants here, so a cursor is as good after a restart as before.
 *
 * The payload is never selected: payload bytes are never stored, and a
 * hundred-million-entity seed would be a hundred gigabytes of them. A
 * genesis row's `payload_size` is 0 when it came over RPC.
 *
 * The scale limit is the node's, not the index's: its query paging collects
 * every matching id before it slices a page, so each page costs O(N) — fine
 * up to a million entities, hopeless at a hundred million. For such a seed
 * `scripts/importGenesisState.ts` reads the seed's state dump offline instead
 * (see `entityGenesisDump.ts`); both paths write the same rows.
 */
import type { EntityVersion, StoredEntityAttribute } from "./entityIndex";
import {
  compareUtf8,
  fromWireAttributeValue,
  TYPE_IDS,
  U64_MAX,
  type AttributeTypeTag,
} from "./entityValues";

/** The node's page-size ceiling. */
export const GENESIS_PAGE_SIZE = 200;

/** Everything a node can say about an entity except its payload. */
export const GENESIS_SELECT: Readonly<Record<string, boolean>> = Object.freeze({
  key: true,
  owner: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
  expiresAt: true,
  creationFlags: true,
  contentType: true,
  attributes: true,
});

/** The largest entity id a genesis row can carry: `created_position` is a Postgres int4. */
export const MAX_GENESIS_POSITION = 2 ** 31 - 1;

export interface GenesisPage {
  data: unknown[];
  /** Hex quantity; a walk pinned at block 0 expects `0x0`. */
  blockNumber: string;
  /** Absent on the last page. */
  cursor?: string;
}

export interface GenesisChain {
  chainId: bigint;
  /** Block 0's hash, when the node reports the block. */
  genesisHash: string | null;
  /** Block 0's state root, when the node reports the block. */
  stateRoot: string | null;
}

/** Where genesis entities come from; a node over JSON-RPC in production, an in-memory fake in tests. */
export interface GenesisSource {
  /** Where the source reads from, with any credentials stripped (for logs and progress reports). */
  url?: string;
  describe(): Promise<GenesisChain>;
  /** `arkiv_getEntityCount` at block 0. */
  count(): Promise<number>;
  /** One page of `arkiv_query("*")` at block 0, resuming after `cursor`. */
  page(cursor: string | undefined, limit: number): Promise<GenesisPage>;
}

/** The node cannot answer for block 0 at all (state pruned, or not an Arkiv node). */
export class GenesisSourceUnavailable extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "GenesisSourceUnavailable";
  }
}

/** The node's answer cannot be turned into rows without guessing; the import stops rather than diverge. */
export class GenesisEntityError extends Error {
  constructor(
    readonly entityKey: string | undefined,
    message: string,
  ) {
    super(entityKey ? `entity ${entityKey}: ${message}` : message);
    this.name = "GenesisEntityError";
  }
}

/** Any other JSON-RPC error the node returned; not retried. */
export class GenesisRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: the node answered ${code} ${message}`);
    this.name = "GenesisRpcError";
  }
}

// ---------------------------------------------------------------------------
// The RPC source

export interface RpcGenesisSourceOptions {
  /** JSON-RPC endpoint of the node (or of a key-injecting proxy in front of one). */
  url: string;
  /** Sent as `x-api-key`. */
  apiKey?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Per request; a page at block 0 on a big seed can take a while. */
  timeoutMs?: number;
  /** Attempts per request before a transport failure is reported. */
  attempts?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ATTEMPTS = 5;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_BLOCK_UNAVAILABLE = -32006;

function retryAfterMs(header: string | null): number {
  if (header === null) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHexQuantity(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

/** A URL without its user info, safe to print. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function createRpcGenesisSource(options: RpcGenesisSourceOptions): GenesisSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  let nextId = 1;

  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      const id = nextId++;
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt >= attempts) {
          throw new Error(`${method}: the node could not be reached after ${attempts} attempts: ${String(error)}`);
        }
        const delay = 1000 * 2 ** (attempt - 1);
        log(`entity index: genesis ${method} could not reach the node (attempt ${attempt}); retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        const delay = Math.max(1000 * 2 ** (attempt - 1), retryAfterMs(response.headers.get("retry-after")));
        await response.body?.cancel();
        log(`entity index: genesis ${method} got HTTP ${response.status}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`${method}: the node answered HTTP ${response.status}`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${method}: the node answered malformed JSON`);
      }
      if (!isPlainObject(body)) throw new Error(`${method}: the node answered something other than a JSON-RPC response`);
      if (isPlainObject(body.error)) {
        const code = typeof body.error.code === "number" ? body.error.code : 0;
        const message = typeof body.error.message === "string" ? body.error.message : "unknown error";
        if (code === JSON_RPC_BLOCK_UNAVAILABLE || code === JSON_RPC_METHOD_NOT_FOUND) {
          throw new GenesisSourceUnavailable(code, `${method}: ${message}`);
        }
        throw new GenesisRpcError(method, code, message, body.error.data);
      }
      if (body.id !== id) throw new Error(`${method}: the node answered with a mismatched id`);
      return body.result;
    }
  };

  return {
    url: redactUrl(options.url),
    async describe() {
      const chainId = await call("eth_chainId", []);
      if (!isHexQuantity(chainId)) throw new Error("eth_chainId: the node answered something other than a hex quantity");
      const block = await call("eth_getBlockByNumber", ["0x0", false]);
      const genesisHash = isPlainObject(block) && typeof block.hash === "string" ? block.hash.toLowerCase() : null;
      const stateRoot = isPlainObject(block) && typeof block.stateRoot === "string" ? block.stateRoot.toLowerCase() : null;
      return { chainId: BigInt(chainId), genesisHash, stateRoot };
    },
    async count() {
      const result = await call("arkiv_getEntityCount", [{ block: 0 }]);
      const count = typeof result === "number" ? result : isHexQuantity(result) ? Number(BigInt(result)) : NaN;
      if (!Number.isInteger(count) || count < 0) {
        throw new Error("arkiv_getEntityCount: the node answered something other than a count");
      }
      return count;
    },
    async page(cursor, limit) {
      const result = await call("arkiv_query", [
        "*",
        { atBlock: "0x0", select: GENESIS_SELECT, limit, ...(cursor === undefined ? {} : { cursor }) },
      ]);
      if (!isPlainObject(result) || !Array.isArray(result.data) || !isHexQuantity(result.blockNumber)) {
        throw new GenesisEntityError(undefined, "arkiv_query answered something other than an entity page");
      }
      if (result.cursor !== undefined && (typeof result.cursor !== "string" || !result.cursor)) {
        throw new GenesisEntityError(undefined, "arkiv_query answered with an invalid cursor");
      }
      return {
        data: result.data,
        blockNumber: result.blockNumber,
        ...(typeof result.cursor === "string" ? { cursor: result.cursor } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Wire entity → version 0

const ENTITY_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * One entity as the node describes it at block 0, as the version it is in
 * the index: version 0 of a history that starts at block 0, at `position`
 * (its entity id) among the genesis entities. Anything the index cannot
 * store faithfully — a creation block other than 0, an attribute of a type
 * it does not know, a value that is not of its type — is refused, because a
 * silently different row is worse than a stopped import.
 */
export function genesisEntityToVersion(entity: unknown, position: number): EntityVersion {
  if (!isPlainObject(entity)) throw new GenesisEntityError(undefined, "an entity is not an object");
  const entityKey = typeof entity.key === "string" && ENTITY_KEY_PATTERN.test(entity.key) ? entity.key.toLowerCase() : undefined;
  if (!entityKey) throw new GenesisEntityError(undefined, "an entity has no 32-byte key");
  const refuse = (message: string): GenesisEntityError => new GenesisEntityError(entityKey, message);
  if (!Number.isInteger(position) || position < 0 || position > MAX_GENESIS_POSITION) {
    throw refuse(`position ${position} is outside the index's range`);
  }
  const address = (field: "owner" | "creator"): string => {
    const value = entity[field];
    if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) throw refuse(`${field} is not an address`);
    return value.toLowerCase();
  };
  const quantity = (field: "createdAt" | "updatedAt" | "expiresAt"): bigint => {
    const value = entity[field];
    if (!isHexQuantity(value)) throw refuse(`${field} is not a hex quantity`);
    return BigInt(value);
  };
  if (quantity("createdAt") !== 0n) throw refuse("createdAt is not block 0; not a genesis entity");
  if (quantity("updatedAt") !== 0n) throw refuse("updatedAt is not block 0; not a genesis entity");
  const expiresAt = quantity("expiresAt");
  if (expiresAt <= 0n || expiresAt > U64_MAX) throw refuse("expiresAt is outside the u64 range");

  let creationFlags: number | null = null;
  const flags = entity.creationFlags;
  if (flags !== undefined && flags !== null) {
    if (!isPlainObject(flags)) throw refuse("creationFlags is not an object");
    const raw = flags.raw;
    if (typeof raw === "number") {
      if (!Number.isInteger(raw) || raw < 0 || raw > 255) throw refuse("creationFlags.raw is not a byte");
      creationFlags = raw;
    } else {
      creationFlags = (flags.readonly === true ? 1 : 0) | (flags.permissionlessExtension === true ? 2 : 0);
    }
  }
  const contentType = entity.contentType === undefined ? "" : entity.contentType;
  if (typeof contentType !== "string") throw refuse("contentType is not a string");

  const attributes: StoredEntityAttribute[] = [];
  const cells = entity.attributes;
  if (cells !== undefined) {
    if (!Array.isArray(cells)) throw refuse("attributes is not an array");
    const names = new Set<string>();
    for (const cell of cells as unknown[]) {
      if (!isPlainObject(cell) || typeof cell.name !== "string" || typeof cell.type !== "string") {
        throw refuse("an attribute has no name or type");
      }
      const name = cell.name;
      const type = cell.type;
      if (name.length === 0) throw refuse("an attribute has an empty name");
      if (names.has(name)) throw refuse(`attribute ${name} appears twice`);
      names.add(name);
      const typeId = TYPE_IDS[type as AttributeTypeTag];
      if (typeId === undefined || type === "bytes") throw refuse(`attribute ${name} has a type the index cannot store: ${type}`);
      const stored = fromWireAttributeValue(type as AttributeTypeTag, cell.value);
      if (!stored) throw refuse(`attribute ${name} does not carry a ${type} value`);
      attributes.push({ name, typeId, valueText: stored.valueText, valueNum: stored.valueNum });
    }
    attributes.sort((a, b) => compareUtf8(a.name, b.name));
  }

  return {
    entityKey,
    version: 0,
    fromBlock: 0,
    fromPosition: position,
    fromOpIndex: 0,
    toBlock: null,
    deleted: false,
    owner: address("owner"),
    creator: address("creator"),
    createdAt: 0,
    createdPosition: position,
    createdOpIndex: 0,
    updatedAt: 0,
    expiresAt,
    creationFlags,
    contentType,
    payloadSize: 0,
    attributes,
  };
}

// ---------------------------------------------------------------------------
// The walk

export interface GenesisWalkResume {
  /** The cursor the last committed page ended with; null to start from the first page. */
  cursor: string | null;
  /** Entities already committed. */
  imported: number;
  /** `arkiv_getEntityCount` at block 0, taken before the walk began. */
  total: number;
  pageSize?: number;
}

export interface GenesisWalkPage {
  versions: EntityVersion[];
  /** The cursor to resume after this page; null when it was the last. */
  cursor: string | null;
  /** Entities imported once this page is committed. */
  imported: number;
}

/**
 * Page the genesis entities newest-first from where a previous walk stopped,
 * assigning each its entity id from the count: the first entity of the walk
 * is the newest, id `total - 1`. The next page is requested while the caller
 * commits the current one. Any page that does not fit — another block, a
 * repeated cursor, more entities than counted, or a walk that ends short —
 * ends the walk with a {@link GenesisEntityError}, since positions would be
 * wrong from there on.
 */
export async function* walkGenesisEntities(
  source: GenesisSource,
  resume: GenesisWalkResume,
): AsyncGenerator<GenesisWalkPage, void, undefined> {
  const pageSize = resume.pageSize ?? GENESIS_PAGE_SIZE;
  if (resume.total > MAX_GENESIS_POSITION) {
    throw new GenesisEntityError(undefined, `${resume.total} genesis entities exceed the index's position range`);
  }
  if (resume.imported > resume.total) {
    throw new GenesisEntityError(undefined, `${resume.imported} entities imported of ${resume.total} counted`);
  }
  let cursor = resume.cursor ?? undefined;
  let imported = resume.imported;
  let next = source.page(cursor, pageSize);
  // A prefetch nobody awaits (the caller stopped consuming) must not surface
  // as an unhandled rejection; the failure still throws when it is awaited.
  next.catch(() => {});
  for (;;) {
    const page = await next;
    if (BigInt(page.blockNumber) !== 0n) {
      throw new GenesisEntityError(undefined, `the node answered block ${page.blockNumber} for a walk pinned at block 0`);
    }
    if (page.cursor !== undefined && page.cursor === cursor) {
      throw new GenesisEntityError(undefined, "the node repeated a page cursor");
    }
    if (page.cursor !== undefined && page.data.length === 0) {
      throw new GenesisEntityError(undefined, "the node answered an empty page that is not the last");
    }
    if (imported + page.data.length > resume.total) {
      throw new GenesisEntityError(
        undefined,
        `the walk returned more than the ${resume.total} entities the node counted at block 0`,
      );
    }
    const versions = page.data.map((entity, offset) => genesisEntityToVersion(entity, resume.total - 1 - imported - offset));
    imported += versions.length;
    cursor = page.cursor;
    if (cursor !== undefined) {
      next = source.page(cursor, pageSize);
      next.catch(() => {});
    }
    yield { versions, cursor: cursor ?? null, imported };
    if (cursor === undefined) break;
  }
  if (imported !== resume.total) {
    throw new GenesisEntityError(undefined, `the walk ended after ${imported} of the ${resume.total} entities counted at block 0`);
  }
}
