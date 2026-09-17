/**
 * PostgreSQL persistence for the experimental entity index: the projected
 * entity versions, the fold bookkeeping, and the query execution that
 * `arkiv_query` / `arkiv_getEntityCount` / `arkiv_getEntity` on
 * `POST /shadow-rpc/experimental` run on.
 *
 * Two tables carry the projection, both rebuilt per entity key whenever any of
 * that key's operations change (see `entityProjector.ts`):
 *
 * - `entity_versions`: one row per state an entity went through, valid for
 *   blocks `[from_block, to_block)`; the row with `to_block IS NULL` is the
 *   entity's latest state, `deleted` marks the tombstone a delete leaves.
 * - `entity_version_attributes`: the same versions' attributes, one row per
 *   `(version, name)`, typed and in two comparable forms (`value_text` for
 *   equality and prefix, `value_num` for ranges). `current` mirrors "latest
 *   and not deleted" so the head-state indexes can stay partial.
 *
 * Liveness is decided at query time — an entity is live at block `B` while
 * `expires_at > B` — so an entity that lapsed never needs a row of its own to
 * disappear, and a query evaluated at a past block sees what was live then.
 *
 * The scanner's tables are only ever read here, with one addition: an index on
 * `transaction_operations.scanned_at`, which is how operations that land
 * *below* the fold point (a gap fill, a rescan) are noticed.
 */
import type { ArkivOperationAttribute } from "./arkivOperations";
import { openDb, textArrayLiteral, type Db, type DbQueryable } from "./db";
import {
  attachEventsToOps,
  foldEntityVersions,
  type EntityEventLog,
  type EntityOpRecord,
  type EntityVersion,
  type StoredEntityAttribute,
} from "./entityIndex";
import type { QueryAst } from "./entityQueryLanguage";
import { compileEntityQuery } from "./entityQuerySql";

export interface EntityIndexStorageOptions {
  schema?: string;
  /** Pool size; the index shares the database with the scanner and the API. */
  max?: number;
  /** Entity keys refolded per pass; see {@link DEFAULT_FOLD_KEY_BATCH}. */
  foldKeyBatch?: number;
}

/** Where the fold stands. */
export interface EntityIndexProgress {
  /** First block whose creates carry entity keys; entities created before it cannot be indexed. */
  floorBlock: bigint | undefined;
  /** Every operation up to and including this block has been folded. */
  projectedThroughBlock: bigint | undefined;
  /** Operations scanned after this instant and sitting below the fold point still await a refold. */
  lateScanWatermark: string | undefined;
  lastFoldAt: string | undefined;
}

/**
 * A position in the newest-first result order; a page resumes strictly after
 * it. The order is the node's entity-id order: ids are handed out when a
 * transaction commits, in ascending entity-key order within that transaction
 * (the node stages a transaction's entity deltas in a map keyed by entity
 * key), so newest-first is block, then transaction position, then key — all
 * descending. The operation index plays no part.
 */
export interface EntityCursorPosition {
  createdAt: bigint;
  position: number;
  entityKey: string;
}

/** The newest-first result order, as an ORDER BY over the versions table alias `v`. */
const RESULT_ORDER = "v.created_at DESC, v.created_position DESC, v.entity_key DESC";

export interface EntityQueryOptions {
  /** The block to evaluate at. */
  block: bigint;
  /** True when `block` is the projection head, which unlocks the head-state indexes. */
  atHead: boolean;
  limit: number;
  after?: EntityCursorPosition;
}

export interface EntityQueryPage {
  entities: EntityVersion[];
  /** Whether at least one more matching entity follows the page. */
  hasMore: boolean;
}

export interface EntityIndexStats {
  /** Planner estimate of `entity_versions` rows. */
  versionRowsEstimate: number;
  /** Entities live at the projection head as of the last count, or null before the first. */
  liveEntities: number | null;
  /** When that count was taken; the projector refreshes it, never a request. */
  liveEntitiesAtUtc: string | null;
  /** The projection head the count was taken at. */
  liveEntitiesBlock: string | null;
  /** The genesis import's state, or undefined when no import was ever considered. */
  genesis: GenesisImportState | undefined;
}

export type GenesisImportStatus = "none" | "waiting" | "running" | "done" | "unavailable" | "failed";

/**
 * Where the import of the chain's genesis entities stands (see
 * `entityGenesis.ts`). One row, `genesis_import`, in the state table:
 *
 * - `none`: the chain has no genesis entities (or its node cannot say);
 * - `waiting`: too many for the RPC walk; `scripts/importGenesisState.ts` must load them;
 * - `running`/`walk`: rows are being written, by the projector (`source: "rpc"`) or the script (`"dump"`);
 * - `running`/`repair`: every row is in; keys that also have operations are being refolded on top;
 * - `done`, `unavailable` (the node holds no block-0 state), `failed` (with `error`).
 */
export interface GenesisImportState {
  status: GenesisImportStatus;
  phase: "walk" | "repair" | null;
  source: "rpc" | "dump" | null;
  chainId: string | null;
  genesisHash: string | null;
  /** Entities the source counted at block 0. */
  total: number;
  /** Entities written so far. */
  imported: number;
  /** The walk's resume point; null before the first page and after the last. */
  cursor: string | null;
  /** The repair's resume point: the last entity key refolded. */
  repairAfterKey: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** When the row last changed (the table's clock). */
  updatedAt?: string;
}

export interface LiveEntitiesReading {
  count: number;
  /** The projection head the count was taken at. */
  block: string;
  /** ISO timestamp of the reading. */
  at: string;
  /** How long the count took, so the next one can be spaced accordingly. */
  ms: number;
}

/** The read surface the JSON-RPC handlers need; `EntityIndexStorage` satisfies it. */
export interface EntityIndexReader {
  getProgress(): Promise<EntityIndexProgress>;
  queryEntities(ast: QueryAst, options: EntityQueryOptions): Promise<EntityQueryPage>;
  countEntities(ast: QueryAst, block: bigint, atHead: boolean): Promise<number>;
  getEntity(entityKey: string, block: bigint, atHead: boolean): Promise<EntityVersion | undefined>;
}

const STATE_FLOOR = "floor_block";
const STATE_PROJECTED_THROUGH = "projected_through_block";
const STATE_LATE_SCAN_WATERMARK = "late_scan_watermark";
const STATE_LAST_FOLD_AT = "last_fold_at";
const STATE_GENESIS_IMPORT = "genesis_import";
const STATE_LIVE_ENTITIES = "live_entities";

const REGISTRY_ADDRESS = "0x4400000000000000000000000000000000000044";
/** Blocks inspected per chunk plan; bounds one planning query. */
const CHUNK_PLAN_BLOCKS = 5_000;

/**
 * Entity keys refolded per pass. A pass holds its keys' operations, receipt
 * logs and folded versions in memory and binds the versions as one JSON
 * parameter, so the batch rather than the chunk sets what a fold allocates —
 * a chunk spans as many keys as its operations touch, which is unbounded.
 */
const DEFAULT_FOLD_KEY_BATCH = 1_000;

/** Split `keys` into consecutive batches of at most `size`, order preserved. */
export function foldKeyBatches(keys: readonly string[], size: number): string[][] {
  const width = Math.max(1, Math.floor(size));
  const batches: string[][] = [];
  for (let start = 0; start < keys.length; start += width) {
    batches.push(keys.slice(start, start + width));
  }
  return batches;
}

/** Indexes built for earlier result orders and address lookups; dropped on start. */
const LEGACY_INDEXES = [
  "entity_versions_live_order_idx",
  "entity_versions_created_idx",
  "entity_versions_live_owner_idx",
  "entity_versions_live_creator_idx",
];

/**
 * The secondary indexes of the two projection tables. Head-state reads only
 * touch latest, undeleted versions, so half of them are partial: the liveness
 * bound on expires_at, the newest-first result order, and the $owner /
 * $creator point lookups. An address keeps every entity it ever owned, and
 * on a busy chain almost all of them have expired, so a bare owner lookup
 * reads a hundred times more rows than it returns; pairing the address with
 * the expiry bound lets one index range answer "what did this address hold
 * at block B". Historical reads bound the candidates by creation block and
 * by expiry over every version, live or not — at a past block B only
 * versions with expires_at > B can be live, a small slice of a table where
 * most rows belong to entities long gone. The attribute indexes use
 * text_pattern_ops so a LIKE 'prefix%' (STARTSWITH) walks the index too;
 * `current` covers the head only, so the same two exist over every row.
 *
 * Listed here rather than inline so a bulk load can drop them and rebuild.
 */
const SECONDARY_INDEXES: ReadonlyArray<{ name: string; table: "versions" | "attributes"; definition: string }> = [
  { name: "entity_versions_live_expiry_idx", table: "versions", definition: "(expires_at) WHERE to_block IS NULL AND NOT deleted" },
  {
    name: "entity_versions_live_order_key_idx",
    table: "versions",
    definition: "(created_at DESC, created_position DESC, entity_key DESC) WHERE to_block IS NULL AND NOT deleted",
  },
  { name: "entity_versions_live_owner_expiry_idx", table: "versions", definition: "(owner, expires_at) WHERE to_block IS NULL AND NOT deleted" },
  { name: "entity_versions_live_creator_expiry_idx", table: "versions", definition: "(creator, expires_at) WHERE to_block IS NULL AND NOT deleted" },
  { name: "entity_versions_created_key_idx", table: "versions", definition: "(created_at DESC, created_position DESC, entity_key DESC)" },
  { name: "entity_versions_expiry_idx", table: "versions", definition: "(expires_at)" },
  { name: "entity_versions_owner_expiry_idx", table: "versions", definition: "(owner, expires_at)" },
  { name: "entity_versions_creator_expiry_idx", table: "versions", definition: "(creator, expires_at)" },
  { name: "entity_version_attributes_live_text_idx", table: "attributes", definition: "(name, type_id, value_text text_pattern_ops) WHERE current" },
  { name: "entity_version_attributes_live_num_idx", table: "attributes", definition: "(name, type_id, value_num) WHERE current" },
  { name: "entity_version_attributes_text_idx", table: "attributes", definition: "(name, type_id, value_text text_pattern_ops)" },
  { name: "entity_version_attributes_num_idx", table: "attributes", definition: "(name, type_id, value_num)" },
];

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** JSON with bigints as decimal strings, which Postgres casts back exactly. */
function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? entry.toString() : entry));
}

interface OperationRow {
  block_number: string;
  position: number;
  op_index: number;
  operation_type: number;
  entity_key: string | null;
  content_type: string | null;
  payload_size_bytes: number;
  attributes: ArkivOperationAttribute[] | string;
  expires_at_blocks: string | null;
  new_owner: string | null;
  from_address: string | null;
  status: string | null;
  log_count: number | null;
}

interface LogRow {
  block_number: string;
  position: number;
  log_index: number;
  address: string;
  topic0: string | null;
  topic1: string | null;
  topic2: string | null;
  topic3: string | null;
  data: string;
}

interface VersionRow {
  entity_key: string;
  version: number;
  from_block: string;
  from_position: number;
  from_op_index: number;
  to_block: string | null;
  deleted: boolean;
  owner: string;
  creator: string;
  created_at: string;
  created_position: number;
  created_op_index: number;
  updated_at: string;
  expires_at: string;
  creation_flags: number | null;
  content_type: string;
  payload_size: number;
  attributes: StoredAttributeJson[] | string;
}

interface StoredAttributeJson {
  name: string;
  typeId: number;
  valueText: string;
  valueNum: string | null;
}

const VERSION_COLUMNS =
  "v.entity_key, v.version, v.from_block::text AS from_block, v.from_position, v.from_op_index, " +
  "v.to_block::text AS to_block, v.deleted, v.owner, v.creator, v.created_at::text AS created_at, " +
  "v.created_position, v.created_op_index, v.updated_at::text AS updated_at, v.expires_at::text AS expires_at, " +
  "v.creation_flags, v.content_type, v.payload_size, v.attributes";

function mapVersionRow(row: VersionRow): EntityVersion {
  const attributes = (typeof row.attributes === "string" ? (JSON.parse(row.attributes) as StoredAttributeJson[]) : row.attributes).map(
    (attribute): StoredEntityAttribute => ({
      name: attribute.name,
      typeId: attribute.typeId,
      valueText: attribute.valueText,
      valueNum: attribute.valueNum === null ? null : BigInt(attribute.valueNum),
    }),
  );
  return {
    entityKey: row.entity_key,
    version: row.version,
    fromBlock: Number(row.from_block),
    fromPosition: row.from_position,
    fromOpIndex: row.from_op_index,
    toBlock: row.to_block === null ? null : Number(row.to_block),
    deleted: row.deleted,
    owner: row.owner,
    creator: row.creator,
    createdAt: Number(row.created_at),
    createdPosition: row.created_position,
    createdOpIndex: row.created_op_index,
    updatedAt: Number(row.updated_at),
    expiresAt: BigInt(row.expires_at),
    creationFlags: row.creation_flags,
    contentType: row.content_type,
    payloadSize: row.payload_size,
    attributes,
  };
}

/** The `entity_versions` rows for versions, in the table's column order. */
function versionRows(versions: readonly EntityVersion[]) {
  return versions.map((version) => ({
    entity_key: version.entityKey,
    version: version.version,
    from_block: version.fromBlock,
    from_position: version.fromPosition,
    from_op_index: version.fromOpIndex,
    to_block: version.toBlock,
    deleted: version.deleted,
    owner: version.owner,
    creator: version.creator,
    created_at: version.createdAt,
    created_position: version.createdPosition,
    created_op_index: version.createdOpIndex,
    updated_at: version.updatedAt,
    expires_at: version.expiresAt,
    creation_flags: version.creationFlags,
    content_type: version.contentType,
    payload_size: version.payloadSize,
    attributes: version.attributes.map(
      (attribute): StoredAttributeJson => ({
        name: attribute.name,
        typeId: attribute.typeId,
        valueText: attribute.valueText,
        valueNum: attribute.valueNum === null ? null : attribute.valueNum.toString(),
      }),
    ),
  }));
}

/** The `entity_version_attributes` rows for versions. */
function attributeRows(versions: readonly EntityVersion[]) {
  return versions.flatMap((version) =>
    version.attributes.map((attribute) => ({
      entity_key: version.entityKey,
      version: version.version,
      name: attribute.name,
      type_id: attribute.typeId,
      value_text: attribute.valueText,
      value_num: attribute.valueNum,
      current: version.toBlock === null && !version.deleted,
    })),
  );
}

export class EntityIndexStorage implements EntityIndexReader {
  readonly schema: string;
  private readonly qState: string;
  private readonly qVersions: string;
  private readonly qAttributes: string;
  private readonly qOperations: string;
  private readonly qTransactions: string;
  private readonly qLogs: string;
  private readonly qScannerState: string;
  private readonly foldKeyBatch: number;

  private constructor(
    private readonly db: Db,
    private readonly ownsDb: boolean,
    options: EntityIndexStorageOptions,
  ) {
    this.schema = options.schema ?? "public";
    this.foldKeyBatch = options.foldKeyBatch ?? DEFAULT_FOLD_KEY_BATCH;
    const prefix = quoteIdent(this.schema);
    this.qState = `${prefix}.entity_index_state`;
    this.qVersions = `${prefix}.entity_versions`;
    this.qAttributes = `${prefix}.entity_version_attributes`;
    this.qOperations = `${prefix}.transaction_operations`;
    this.qTransactions = `${prefix}.transactions`;
    this.qLogs = `${prefix}.transaction_logs`;
    this.qScannerState = `${prefix}.scanner_state`;
  }

  static async open(connectionString: string, options: EntityIndexStorageOptions = {}): Promise<EntityIndexStorage> {
    const db = openDb(connectionString, options.max !== undefined ? { max: options.max } : {});
    const storage = new EntityIndexStorage(db, true, options);
    await storage.initSchema();
    return storage;
  }

  static async fromDb(db: Db, options: EntityIndexStorageOptions = {}): Promise<EntityIndexStorage> {
    const storage = new EntityIndexStorage(db, false, options);
    await storage.initSchema();
    return storage;
  }

  async close(): Promise<void> {
    if (this.ownsDb) await this.db.close();
  }

  /**
   * Create the projection tables. The scanner's tables are expected to exist
   * (the scanner creates them); only the `scanned_at` index is added there.
   */
  private async initSchema(): Promise<void> {
    if (this.schema !== "public") {
      await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schema)}`);
    }
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qState} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // expires_at is NUMERIC(20,0): a "never expires" entity carries 2^64-1,
    // which BIGINT cannot hold. Block heights are BIGINT like the scanner's.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qVersions} (
        entity_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        from_block BIGINT NOT NULL,
        from_position INTEGER NOT NULL,
        from_op_index INTEGER NOT NULL,
        to_block BIGINT,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        owner TEXT NOT NULL,
        creator TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        created_position INTEGER NOT NULL,
        created_op_index INTEGER NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at NUMERIC(20, 0) NOT NULL,
        creation_flags SMALLINT,
        content_type TEXT NOT NULL DEFAULT '',
        payload_size INTEGER NOT NULL DEFAULT 0,
        attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (entity_key, version)
      )
    `);
    // The result order changed from operation index to entity key as the
    // in-transaction tie-break, and the address indexes gained the expiry
    // bound; the indexes built for the old shapes go.
    for (const name of LEGACY_INDEXES) {
      await this.db.query(`DROP INDEX IF EXISTS ${quoteIdent(name)}`);
    }
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qAttributes} (
        entity_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        type_id SMALLINT NOT NULL,
        value_text TEXT NOT NULL,
        value_num NUMERIC,
        current BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (entity_key, version, name)
      )
    `);
    await this.ensureIndexes();
    // Late arrivals (gap fills, rescans) are found by when they were written.
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transaction_operations_scanned_at_idx")}
       ON ${this.qOperations} (scanned_at)`,
    );
  }

  /** Create every secondary index that is missing. */
  async ensureIndexes(): Promise<void> {
    for (const index of SECONDARY_INDEXES) {
      const table = index.table === "versions" ? this.qVersions : this.qAttributes;
      await this.db.query(`CREATE INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${table} ${index.definition}`);
    }
  }

  /**
   * Drop the secondary indexes so a bulk load pays for them once, at the end,
   * instead of on every row; {@link ensureIndexes} puts them back. Only
   * sensible while the index is otherwise idle — reads scan without them.
   */
  async dropSecondaryIndexes(): Promise<void> {
    for (const index of SECONDARY_INDEXES) {
      await this.db.query(`DROP INDEX IF EXISTS ${quoteIdent(index.name)}`);
    }
  }

  /** Whether the projection tables hold no rows at all. */
  async isEmpty(): Promise<boolean> {
    const result = await this.db.query<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${this.qVersions} LIMIT 1) AS any`,
    );
    return !result.rows[0]?.any;
  }

  // -------------------------------------------------------------------------
  // Progress

  async getProgress(): Promise<EntityIndexProgress> {
    const result = await this.db.query<{ key: string; value: string }>(`SELECT key, value FROM ${this.qState}`);
    const state = new Map(result.rows.map((row) => [row.key, row.value]));
    const asBigint = (key: string) => {
      const value = state.get(key);
      return value === undefined ? undefined : BigInt(value);
    };
    return {
      floorBlock: asBigint(STATE_FLOOR),
      projectedThroughBlock: asBigint(STATE_PROJECTED_THROUGH),
      lateScanWatermark: state.get(STATE_LATE_SCAN_WATERMARK),
      lastFoldAt: state.get(STATE_LAST_FOLD_AT),
    };
  }

  async setProgress(
    patch: Partial<{ floorBlock: bigint; projectedThroughBlock: bigint; lateScanWatermark: string; lastFoldAt: string }>,
    client: DbQueryable = this.db,
  ): Promise<void> {
    const entries: Array<[string, string]> = [];
    if (patch.floorBlock !== undefined) entries.push([STATE_FLOOR, patch.floorBlock.toString()]);
    if (patch.projectedThroughBlock !== undefined) entries.push([STATE_PROJECTED_THROUGH, patch.projectedThroughBlock.toString()]);
    if (patch.lateScanWatermark !== undefined) entries.push([STATE_LATE_SCAN_WATERMARK, patch.lateScanWatermark]);
    if (patch.lastFoldAt !== undefined) entries.push([STATE_LAST_FOLD_AT, patch.lastFoldAt]);
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO ${this.qState} (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    }
  }

  async getGenesisImport(client: DbQueryable = this.db): Promise<GenesisImportState | undefined> {
    const result = await client.query<{ value: string; updated_at: string | Date }>(
      `SELECT value, updated_at::text AS updated_at FROM ${this.qState} WHERE key = $1`,
      [STATE_GENESIS_IMPORT],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const state = JSON.parse(row.value) as GenesisImportState;
    const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
    return { ...state, updatedAt };
  }

  async setGenesisImport(state: GenesisImportState, client: DbQueryable = this.db): Promise<void> {
    const { updatedAt: _updatedAt, ...stored } = state;
    await client.query(
      `INSERT INTO ${this.qState} (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [STATE_GENESIS_IMPORT, JSON.stringify(stored)],
    );
  }

  async getLiveEntitiesReading(): Promise<LiveEntitiesReading | undefined> {
    const result = await this.db.query<{ value: string }>(`SELECT value FROM ${this.qState} WHERE key = $1`, [
      STATE_LIVE_ENTITIES,
    ]);
    const value = result.rows[0]?.value;
    return value === undefined ? undefined : (JSON.parse(value) as LiveEntitiesReading);
  }

  /**
   * Count the entities live at `block` and remember the reading. A count over
   * the live rows is cheap on a small index and seconds on a big one, so the
   * projector takes it on its own schedule and `/health` only reads it back.
   */
  async refreshLiveEntities(block: bigint): Promise<LiveEntitiesReading> {
    const started = Date.now();
    const live = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.qVersions} v WHERE ${this.liveFilter(true)}`,
      [block.toString()],
    );
    const reading: LiveEntitiesReading = {
      count: Number(live.rows[0]?.count ?? 0),
      block: block.toString(),
      at: new Date().toISOString(),
      ms: Date.now() - started,
    };
    await this.db.query(
      `INSERT INTO ${this.qState} (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [STATE_LIVE_ENTITIES, JSON.stringify(reading)],
    );
    return reading;
  }

  /** Drop the projection and its bookkeeping so the next fold starts over. */
  async reset(): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(`TRUNCATE ${this.qAttributes}`);
      await client.query(`TRUNCATE ${this.qVersions}`);
      await client.query(`DELETE FROM ${this.qState}`);
    });
  }

  /** The scanner's forward head: the newest block whose data is fully stored. */
  async getIndexedHead(): Promise<bigint | undefined> {
    const result = await this.db.query<{ value: string }>(
      `SELECT value FROM ${this.qScannerState} WHERE key = 'last_successful_block'`,
    );
    const value = result.rows[0]?.value;
    return value === undefined ? undefined : BigInt(value);
  }

  /** The chain id the scanner recorded at startup, or undefined before its first run. */
  async getScannerChainId(): Promise<bigint | undefined> {
    const result = await this.db.query<{ value: string }>(`SELECT value FROM ${this.qScannerState} WHERE key = 'chain_id'`);
    const value = result.rows[0]?.value;
    return value === undefined || value === "" ? undefined : BigInt(value);
  }

  /** The hash the scanner stored for a block, or undefined when the block or its hash is not stored. */
  async getStoredBlockHash(blockNumber: bigint): Promise<string | undefined> {
    const result = await this.db.query<{ block_hash: string | null }>(
      `SELECT block_hash FROM ${quoteIdent(this.schema)}.blocks WHERE block_number = $1::bigint`,
      [blockNumber.toString()],
    );
    const hash = result.rows[0]?.block_hash;
    return hash ? hash.toLowerCase() : undefined;
  }

  /** Create operations below `block` whose entity key is unknown: entities the index can never attribute. */
  async countKeylessCreatesBelow(block: bigint): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.qOperations}
       WHERE operation_type = 1 AND entity_key IS NULL AND block_number < $1::bigint`,
      [block.toString()],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** The database clock, so watermarks never depend on this host's clock. */
  async now(): Promise<string> {
    const result = await this.db.query<{ now: string | Date }>("SELECT NOW()::text AS now");
    const value = result.rows[0]!.now;
    return value instanceof Date ? value.toISOString() : value;
  }

  /**
   * The first block whose create operations carry entity keys — the point from
   * which entities can be attributed at all. Undefined until such a row exists.
   */
  async detectFloorBlock(): Promise<bigint | undefined> {
    const result = await this.db.query<{ floor: string | null }>(
      `SELECT MIN(block_number)::text AS floor FROM ${this.qOperations}
       WHERE operation_type = 1 AND entity_key IS NOT NULL`,
    );
    const floor = result.rows[0]?.floor;
    return floor ? BigInt(floor) : undefined;
  }

  // -------------------------------------------------------------------------
  // Fold support

  /**
   * Pick where the next fold chunk should end: the block at which roughly
   * `maxOps` operations have accumulated past `afterBlock`, or `head` when the
   * remaining operations are fewer than that.
   */
  async planChunkEnd(afterBlock: bigint, head: bigint, maxOps: number): Promise<bigint> {
    const result = await this.db.query<{ block_number: string; ops: number }>(
      `SELECT block_number::text AS block_number, COUNT(*)::int AS ops
       FROM ${this.qOperations}
       WHERE block_number > $1::bigint AND block_number <= $2::bigint AND entity_key IS NOT NULL
       GROUP BY block_number ORDER BY block_number LIMIT ${CHUNK_PLAN_BLOCKS}`,
      [afterBlock.toString(), head.toString()],
    );
    let total = 0;
    for (const row of result.rows) {
      total += row.ops;
      if (total >= maxOps) return BigInt(row.block_number);
    }
    if (result.rows.length === CHUNK_PLAN_BLOCKS) {
      return BigInt(result.rows[result.rows.length - 1]!.block_number);
    }
    return head;
  }

  /** Entity keys with an operation in `(afterBlock, throughBlock]`. */
  async keysTouchedBetween(afterBlock: bigint, throughBlock: bigint): Promise<string[]> {
    const result = await this.db.query<{ entity_key: string }>(
      `SELECT DISTINCT entity_key FROM ${this.qOperations}
       WHERE block_number > $1::bigint AND block_number <= $2::bigint AND entity_key IS NOT NULL`,
      [afterBlock.toString(), throughBlock.toString()],
    );
    return result.rows.map((row) => row.entity_key);
  }

  /** Entity keys whose operations at or below `throughBlock` were written after `since`. */
  async keysScannedSince(since: string, throughBlock: bigint): Promise<string[]> {
    const result = await this.db.query<{ entity_key: string }>(
      `SELECT DISTINCT entity_key FROM ${this.qOperations}
       WHERE scanned_at > $1::timestamptz AND block_number <= $2::bigint AND entity_key IS NOT NULL`,
      [since, throughBlock.toString()],
    );
    return result.rows.map((row) => row.entity_key);
  }

  /**
   * Genesis entities (a version-0 row at block 0) that also have an operation
   * at or below `throughBlock`, in key order after `afterKey`: the keys whose
   * histories must be refolded on top of their genesis base once the base is
   * in. Keyset-paged so a repair of any size resumes where it stopped.
   */
  async genesisKeysWithOperations(throughBlock: bigint, afterKey: string | null, limit: number): Promise<string[]> {
    const result = await this.db.query<{ entity_key: string }>(
      `SELECT DISTINCT lower(o.entity_key) AS entity_key FROM ${this.qOperations} o
       WHERE o.entity_key IS NOT NULL AND o.block_number <= $1::bigint AND lower(o.entity_key) > $2
         AND EXISTS (
           SELECT 1 FROM ${this.qVersions} v
           WHERE v.entity_key = lower(o.entity_key) AND v.version = 0 AND v.from_block = 0
         )
       ORDER BY 1 LIMIT $3`,
      [throughBlock.toString(), afterKey ?? "", limit],
    );
    return result.rows.map((row) => row.entity_key);
  }

  /**
   * Every applied operation of the given entities up to `throughBlock`, with
   * the engine's receipt events attached where the logs were stored. Whole
   * transactions are loaded so the n-th create pairs with the n-th
   * `EntityCreated` even when other entities sit in between.
   *
   * Runs on `client` so a caller can wrap it in the fold transaction, which is
   * also what keeps the two reads one after the other on one connection.
   */
  async loadEntityOps(
    keys: readonly string[],
    throughBlock: bigint,
    client: DbQueryable = this.db,
  ): Promise<Map<string, EntityOpRecord[]>> {
    const byKey = new Map<string, EntityOpRecord[]>();
    if (keys.length === 0) return byKey;
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const keyList = textArrayLiteral(keys);
    const through = throughBlock.toString();
    const txs =
      `SELECT DISTINCT o.block_number, o.position FROM ${this.qOperations} o
       WHERE o.entity_key = ANY($1::text[]) AND o.block_number <= $2::bigint`;

    const operations = await client.query<OperationRow>(
      `WITH txs AS (${txs})
       SELECT o.block_number::text AS block_number, o.position, o.op_index, o.operation_type, o.entity_key,
              o.content_type, o.payload_size_bytes, o.attributes, o.expires_at_blocks::text AS expires_at_blocks,
              o.new_owner, t.from_address, t.status, t.log_count
       FROM ${this.qOperations} o
       JOIN txs ON txs.block_number = o.block_number AND txs.position = o.position
       JOIN ${this.qTransactions} t ON t.block_number = o.block_number AND t.position = o.position
       ORDER BY o.block_number, o.position, o.op_index`,
      [keyList, through],
    );
    const logs = await client.query<LogRow>(
      `WITH txs AS (${txs})
       SELECT l.block_number::text AS block_number, l.position, l.log_index, l.address,
              l.topic0, l.topic1, l.topic2, l.topic3, l.data
       FROM ${this.qLogs} l
       JOIN txs ON txs.block_number = l.block_number AND txs.position = l.position
       WHERE lower(l.address) = $3
       ORDER BY l.block_number, l.position, l.log_index`,
      [keyList, through, REGISTRY_ADDRESS],
    );

    const logsByTx = new Map<string, EntityEventLog[]>();
    for (const row of logs.rows) {
      const txKey = `${row.block_number}:${row.position}`;
      const list = logsByTx.get(txKey) ?? [];
      list.push({
        logIndex: row.log_index,
        address: row.address,
        topic0: row.topic0,
        topic1: row.topic1,
        topic2: row.topic2,
        topic3: row.topic3,
        data: row.data,
      });
      logsByTx.set(txKey, list);
    }

    const opsByTx = new Map<string, EntityOpRecord[]>();
    for (const row of operations.rows) {
      // A reverted transaction applied nothing; a row without a status is a
      // pre-receipt row and is trusted, since only successful calls were kept.
      if (row.status === "0" || !row.entity_key || !row.from_address) continue;
      const record: EntityOpRecord = {
        blockNumber: Number(row.block_number),
        position: row.position,
        opIndex: row.op_index,
        operationType: row.operation_type,
        entityKey: row.entity_key.toLowerCase(),
        sender: row.from_address.toLowerCase(),
        contentType: row.content_type,
        payloadSizeBytes: row.payload_size_bytes,
        attributes: typeof row.attributes === "string" ? (JSON.parse(row.attributes) as ArkivOperationAttribute[]) : row.attributes,
        expiresAtBlocks: Number(row.expires_at_blocks ?? 0),
        newOwner: row.new_owner,
      };
      const txKey = `${row.block_number}:${row.position}`;
      const list = opsByTx.get(txKey) ?? [];
      list.push(record);
      opsByTx.set(txKey, list);
    }

    for (const [txKey, ops] of opsByTx) {
      const txLogs = logsByTx.get(txKey);
      if (txLogs) attachEventsToOps(ops, txLogs);
      for (const op of ops) {
        if (!wanted.has(op.entityKey)) continue;
        const list = byKey.get(op.entityKey) ?? [];
        list.push(op);
        byKey.set(op.entityKey, list);
      }
    }
    return byKey;
  }

  /**
   * Replace the stored versions of the given entities with the ones folded
   * from their operations up to `throughBlock` — on top of their genesis
   * state where they have one. Runs on `client` so a caller can wrap it in
   * the fold transaction.
   *
   * The keys are folded a batch at a time, each batch read, folded and
   * written before the next is read. Keys are independent — a key's versions
   * come from its own operations and its own genesis base, and are replaced
   * on their own — so the result is the same whatever the batch width, while
   * what is held at once stays bounded by the batch.
   */
  async refoldEntities(
    keys: readonly string[],
    throughBlock: bigint,
    client: DbQueryable = this.db,
  ): Promise<{ entities: number; versions: number }> {
    let entities = 0;
    let written = 0;
    for (const batch of foldKeyBatches(keys, this.foldKeyBatch)) {
      const opsByKey = await this.loadEntityOps(batch, throughBlock, client);
      const bases = await this.loadGenesisBases(batch, client);
      const versions: EntityVersion[] = [];
      for (const key of batch) {
        const lower = key.toLowerCase();
        versions.push(...foldEntityVersions(lower, opsByKey.get(lower) ?? [], bases.get(lower)));
      }
      await this.replaceVersions(client, batch, versions);
      entities += batch.length;
      written += versions.length;
    }
    return { entities, versions: written };
  }

  /**
   * The genesis state of the given entities — the version-0 rows at block 0
   * an import wrote — which a refold starts from, since no operation carries
   * that state. Read before a refold deletes the keys' rows.
   */
  async loadGenesisBases(keys: readonly string[], client: DbQueryable = this.db): Promise<Map<string, EntityVersion>> {
    const bases = new Map<string, EntityVersion>();
    if (keys.length === 0) return bases;
    const result = await client.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM ${this.qVersions} v
       WHERE v.entity_key = ANY($1::text[]) AND v.version = 0 AND v.from_block = 0`,
      [textArrayLiteral(keys.map((key) => key.toLowerCase()))],
    );
    for (const row of result.rows) bases.set(row.entity_key, mapVersionRow(row));
    return bases;
  }

  /**
   * Write genesis versions (see `entityGenesis.ts`). A row that is already
   * there is left alone, so a batch that is committed twice — a walk resumed
   * from a cursor it had already passed — changes nothing.
   */
  async insertGenesisVersions(versions: readonly EntityVersion[], client: DbQueryable = this.db): Promise<void> {
    if (versions.length === 0) return;
    await client.query(
      `INSERT INTO ${this.qVersions} SELECT * FROM json_populate_recordset(NULL::${this.qVersions}, $1::text::json)
       ON CONFLICT (entity_key, version) DO NOTHING`,
      [jsonWithBigints(versionRows(versions))],
    );
    const attributes = attributeRows(versions);
    if (attributes.length > 0) {
      await client.query(
        `INSERT INTO ${this.qAttributes} SELECT * FROM json_populate_recordset(NULL::${this.qAttributes}, $1::text::json)
         ON CONFLICT (entity_key, version, name) DO NOTHING`,
        [jsonWithBigints(attributes)],
      );
    }
  }

  private async replaceVersions(client: DbQueryable, keys: readonly string[], versions: readonly EntityVersion[]): Promise<void> {
    const keyList = textArrayLiteral(keys.map((key) => key.toLowerCase()));
    await client.query(`DELETE FROM ${this.qAttributes} WHERE entity_key = ANY($1::text[])`, [keyList]);
    await client.query(`DELETE FROM ${this.qVersions} WHERE entity_key = ANY($1::text[])`, [keyList]);
    if (versions.length === 0) return;
    // One statement per table however many rows: the rows travel as a JSON
    // document and json_populate_recordset types them against the table. The
    // parameter is declared text and cast afterwards, because Bun.sql would
    // otherwise re-encode the already-serialised document as a JSON string.
    await client.query(
      `INSERT INTO ${this.qVersions} SELECT * FROM json_populate_recordset(NULL::${this.qVersions}, $1::text::json)`,
      [jsonWithBigints(versionRows(versions))],
    );
    const attributes = attributeRows(versions);
    if (attributes.length > 0) {
      await client.query(
        `INSERT INTO ${this.qAttributes} SELECT * FROM json_populate_recordset(NULL::${this.qAttributes}, $1::text::json)`,
        [jsonWithBigints(attributes)],
      );
    }
  }

  /**
   * Run `fn` inside a transaction that holds the projector's advisory lock,
   * so two projectors on one schema never fold at once. Returns undefined
   * without running `fn` when another holder has the lock.
   *
   * The transaction plans without parallel workers: a parallel plan reserves a
   * dynamic shared memory segment sized to the joins it feeds, and the fold's
   * joins over the operation, transaction and log tables ask for more than a
   * container's default `/dev/shm` can back, which fails the query outright.
   * The fold's own batching is what bounds its cost instead.
   */
  async withFoldLock<T>(fn: (client: DbQueryable) => Promise<T>): Promise<T | undefined> {
    return this.db.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
        [`entity-index:${this.schema}`],
      );
      if (!lock.rows[0]?.locked) return undefined;
      await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
      return fn(client);
    });
  }

  // -------------------------------------------------------------------------
  // Reads

  private liveFilter(atHead: boolean): string {
    // $1 is always the block. At the head only latest versions can be live,
    // which is what the partial indexes cover; in the past the version valid
    // at that block is the one whose validity range contains it.
    return atHead
      ? "v.to_block IS NULL AND NOT v.deleted AND v.expires_at > $1::numeric"
      : "v.from_block <= $1::bigint AND (v.to_block IS NULL OR v.to_block > $1::bigint) AND NOT v.deleted AND v.expires_at > $1::numeric";
  }

  async queryEntities(ast: QueryAst, options: EntityQueryOptions): Promise<EntityQueryPage> {
    const params: unknown[] = [options.block.toString()];
    const compiled = compileEntityQuery(ast, { attributesTable: this.qAttributes, paramOffset: params.length });
    params.push(...compiled.params);
    let cursor = "";
    if (options.after) {
      const base = params.length;
      cursor = ` AND (v.created_at, v.created_position, v.entity_key) < ($${base + 1}::bigint, $${base + 2}::int, $${base + 3}::text)`;
      params.push(options.after.createdAt.toString(), options.after.position, options.after.entityKey);
    }
    params.push(options.limit + 1);
    const result = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM ${this.qVersions} v
       WHERE ${this.liveFilter(options.atHead)} AND ${compiled.text}${cursor}
       ORDER BY ${RESULT_ORDER}
       LIMIT $${params.length}`,
      params,
    );
    const rows = result.rows.slice(0, options.limit);
    return { entities: rows.map(mapVersionRow), hasMore: result.rows.length > options.limit };
  }

  async countEntities(ast: QueryAst, block: bigint, atHead: boolean): Promise<number> {
    const params: unknown[] = [block.toString()];
    const compiled = compileEntityQuery(ast, { attributesTable: this.qAttributes, paramOffset: params.length });
    params.push(...compiled.params);
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.qVersions} v WHERE ${this.liveFilter(atHead)} AND ${compiled.text}`,
      params,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getEntity(entityKey: string, block: bigint, atHead: boolean): Promise<EntityVersion | undefined> {
    const result = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM ${this.qVersions} v
       WHERE ${this.liveFilter(atHead)} AND v.entity_key = $2 LIMIT 1`,
      [block.toString(), entityKey.toLowerCase()],
    );
    const row = result.rows[0];
    return row ? mapVersionRow(row) : undefined;
  }

  /** Every version of one entity, oldest first — the index's own view of its history. */
  async getEntityVersions(entityKey: string): Promise<EntityVersion[]> {
    const result = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM ${this.qVersions} v WHERE v.entity_key = $1 ORDER BY v.version`,
      [entityKey.toLowerCase()],
    );
    return result.rows.map(mapVersionRow);
  }

  async getStats(): Promise<EntityIndexStats> {
    const [estimate, reading, genesis] = await Promise.all([
      this.db.query<{ estimate: string }>(
        `SELECT GREATEST(reltuples, 0)::bigint::text AS estimate FROM pg_class WHERE oid = $1::regclass`,
        [this.qVersions],
      ),
      this.getLiveEntitiesReading(),
      this.getGenesisImport(),
    ]);
    return {
      versionRowsEstimate: Number(estimate.rows[0]?.estimate ?? 0),
      liveEntities: reading?.count ?? null,
      liveEntitiesAtUtc: reading?.at ?? null,
      liveEntitiesBlock: reading?.block ?? null,
      genesis,
    };
  }
}
