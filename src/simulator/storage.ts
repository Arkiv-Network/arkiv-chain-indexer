import { openDb, type Db, type DbQueryable } from "../db";
import { decimal, fail, integer, text } from "./common";
import { parseIdentity, sameIdentity, type SimulatorIdentity } from "./config";
import {
  cursorDecode,
  cursorEncode,
  fingerprint,
  predicateSql,
  SqlArgs,
  type Predicate,
} from "./query";
import {
  parseFeedBlock,
  type Change,
  type FeedBlock,
  type Header,
  type SourceStatus,
} from "./wire";

export interface Progress {
  height: string | null;
  hash: string | null;
  observed: SourceStatus | null;
  blocks: string;
  transactions: string;
  operations: string;
  spentUnits: string;
  liveRecords: string;
  namespaces: string;
  rawRecords: string;
  health: string;
}
export interface SnapshotRef {
  height: string;
  hash: string;
  stateRoot: string;
}
export interface Page {
  sourceKind: "arkiv-native-simulator";
  identity: SimulatorIdentity;
  snapshot: SnapshotRef;
  verification: "unverified-projection";
  rows: unknown[];
  nextCursor: string | null;
}
export interface PageOptions {
  atHeight?: string;
  cursor?: string;
  limit?: number;
  namespaceId?: string;
  actor?: string;
  status?: string;
  recordKey?: string;
  recordId?: string;
  predicate?: Predicate | null;
}
const U64 = "numeric(20,0)";
const lower = "CHECK (VALUE >= 0 AND VALUE <= 18446744073709551615)";
export class SimulatorStorage {
  readonly runToken: string;
  private runPk = "";
  private constructor(
    readonly db: Db,
    readonly schema: string,
    readonly identity: SimulatorIdentity,
  ) {
    this.runToken = fingerprint(identity);
  }
  private get q(): string {
    return `"${this.schema}"`;
  }
  static async open(
    url: string,
    identity: SimulatorIdentity,
    schema = "sim_v1",
  ): Promise<SimulatorStorage> {
    if (!/^sim_[a-z0-9_]{1,44}$/.test(schema)) return fail("InvalidSchema");
    const store = new SimulatorStorage(
      openDb(url, { max: 4 }),
      schema,
      parseIdentity(identity),
    );
    try {
      await store.initialize();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }
  close(): Promise<void> {
    return this.db.close();
  }
  private async initialize(): Promise<void> {
    const q = this.q;
    await this.db.transaction(async (tx) => {
      // Serialize first-time schema creation across scanner/backend processes.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `simulator-schema/${this.schema}`,
      ]);
      await tx.query(`CREATE SCHEMA IF NOT EXISTS ${q}`);
      await tx.query(
        `DO $$ BEGIN CREATE DOMAIN ${q}.u64 AS ${U64} ${lower}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
      );
      for (const ddl of [
        `CREATE TABLE IF NOT EXISTS ${q}.runs (run_pk bigserial PRIMARY KEY, source_id uuid NOT NULL, run_id text NOT NULL CHECK(run_id ~ '^[0-9a-f]{32}$'), genesis_hash text NOT NULL, chain_id ${q}.u64 NOT NULL, version integer NOT NULL CHECK(version=1), UNIQUE(source_id,run_id))`,
        `CREATE TABLE IF NOT EXISTS ${q}.progress (run_pk bigint PRIMARY KEY REFERENCES ${q}.runs, height ${q}.u64, hash text, observed jsonb, blocks numeric NOT NULL DEFAULT 0, transactions numeric NOT NULL DEFAULT 0, operations numeric NOT NULL DEFAULT 0, spent_units numeric NOT NULL DEFAULT 0, live_records numeric NOT NULL DEFAULT 0, namespaces numeric NOT NULL DEFAULT 0, raw_records numeric NOT NULL DEFAULT 0, health text NOT NULL DEFAULT 'initializing', CHECK((height IS NULL)=(hash IS NULL)))`,
        `CREATE TABLE IF NOT EXISTS ${q}.blocks (run_pk bigint REFERENCES ${q}.runs, height ${q}.u64, hash text NOT NULL, parent_hash text NOT NULL, timestamp_ms ${q}.u64 NOT NULL, header jsonb NOT NULL, metadata text NOT NULL, fingerprint text NOT NULL, tx_count integer NOT NULL, op_count integer NOT NULL, spent_units ${q}.u64 NOT NULL, PRIMARY KEY(run_pk,height), UNIQUE(run_pk,hash))`,
        `CREATE TABLE IF NOT EXISTS ${q}.transactions (run_pk bigint, height ${q}.u64, position integer CHECK(position>=0), actor text NOT NULL, request_id text NOT NULL, digest text NOT NULL, status text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(run_pk,height,position), FOREIGN KEY(run_pk,height) REFERENCES ${q}.blocks, UNIQUE(run_pk,actor,request_id))`,
        `CREATE INDEX IF NOT EXISTS sim_tx_actor ON ${q}.transactions(run_pk,actor,height,position)`,
        `CREATE TABLE IF NOT EXISTS ${q}.operations (run_pk bigint, height ${q}.u64, phase integer, group_position integer, op_position integer, namespace_id ${q}.u64, record_id ${q}.u64, record_key text, data jsonb NOT NULL, PRIMARY KEY(run_pk,height,phase,group_position,op_position), FOREIGN KEY(run_pk,height) REFERENCES ${q}.blocks)`,
        `CREATE INDEX IF NOT EXISTS sim_op_record ON ${q}.operations(run_pk,namespace_id,record_key,height,phase,group_position,op_position)`,
        `CREATE TABLE IF NOT EXISTS ${q}.namespace_versions (run_pk bigint REFERENCES ${q}.runs, namespace_id ${q}.u64 CHECK(namespace_id>0), from_height ${q}.u64, to_height ${q}.u64, data text NOT NULL, PRIMARY KEY(run_pk,namespace_id,from_height), CHECK(to_height IS NULL OR to_height>from_height))`,
        `CREATE UNIQUE INDEX IF NOT EXISTS sim_current_namespace ON ${q}.namespace_versions(run_pk,namespace_id) WHERE to_height IS NULL`,
        `CREATE TABLE IF NOT EXISTS ${q}.record_versions (run_pk bigint REFERENCES ${q}.runs, namespace_id ${q}.u64 CHECK(namespace_id>0), record_id ${q}.u64 CHECK(record_id>0), from_height ${q}.u64, to_height ${q}.u64, record_key text NOT NULL, deleted boolean NOT NULL, created_height ${q}.u64 NOT NULL, data text NOT NULL, PRIMARY KEY(run_pk,namespace_id,record_id,from_height), CHECK(to_height IS NULL OR to_height>from_height))`,
        `CREATE UNIQUE INDEX IF NOT EXISTS sim_current_record ON ${q}.record_versions(run_pk,namespace_id,record_id) WHERE to_height IS NULL`,
        `CREATE UNIQUE INDEX IF NOT EXISTS sim_live_key ON ${q}.record_versions(run_pk,namespace_id,record_key) WHERE to_height IS NULL AND NOT deleted`,
        `CREATE INDEX IF NOT EXISTS sim_record_at ON ${q}.record_versions(run_pk,namespace_id,record_id,from_height,to_height)`,
        `CREATE TABLE IF NOT EXISTS ${q}.record_attributes (run_pk bigint, namespace_id ${q}.u64, record_id ${q}.u64, from_height ${q}.u64, name bytea, type text NOT NULL, value_num numeric(20,0), value_bool boolean, value_bytes bytea, PRIMARY KEY(run_pk,namespace_id,record_id,from_height,name), FOREIGN KEY(run_pk,namespace_id,record_id,from_height) REFERENCES ${q}.record_versions)`,
        `CREATE INDEX IF NOT EXISTS sim_attribute_lookup ON ${q}.record_attributes(run_pk,namespace_id,name,type,value_num,record_id)`,
        `CREATE TABLE IF NOT EXISTS ${q}.raw_versions (run_pk bigint REFERENCES ${q}.runs, namespace_id ${q}.u64, raw_key text, from_height ${q}.u64, to_height ${q}.u64, deleted boolean NOT NULL, data jsonb NOT NULL, PRIMARY KEY(run_pk,namespace_id,raw_key,from_height), CHECK(to_height IS NULL OR to_height>from_height))`,
        `CREATE UNIQUE INDEX IF NOT EXISTS sim_current_raw ON ${q}.raw_versions(run_pk,namespace_id,raw_key) WHERE to_height IS NULL`,
      ])
        await tx.query(ddl);
      const id = this.identity;
      await tx.query(
        `INSERT INTO ${q}.runs(source_id,run_id,genesis_hash,chain_id,version) VALUES($1,$2,$3,$4,1) ON CONFLICT(source_id,run_id) DO NOTHING`,
        [id.sourceId, id.runId, id.genesisHash, id.chainId],
      );
      const row = (
        await tx.query<{
          run_pk: string;
          genesis_hash: string;
          chain_id: string;
          version: number;
        }>(
          `SELECT run_pk,genesis_hash,chain_id,version FROM ${q}.runs WHERE source_id=$1 AND run_id=$2`,
          [id.sourceId, id.runId],
        )
      ).rows[0]!;
      if (
        row.genesis_hash !== id.genesisHash ||
        row.chain_id !== id.chainId ||
        row.version !== 1
      )
        return fail("IdentityMismatch", 409);
      this.runPk = String(row.run_pk);
      await tx.query(
        `INSERT INTO ${q}.progress(run_pk) VALUES($1) ON CONFLICT DO NOTHING`,
        [this.runPk],
      );
    });
  }
  async progress(): Promise<Progress> {
    return (
      await this.db.query<Progress>(
        `SELECT height,hash,observed,blocks::text,transactions::text,operations::text,spent_units::text AS "spentUnits",live_records::text AS "liveRecords",namespaces::text,raw_records::text AS "rawRecords",health FROM ${this.q}.progress WHERE run_pk=$1`,
        [this.runPk],
      )
    ).rows[0]!;
  }
  async observe(status: SourceStatus): Promise<void> {
    if (!sameIdentity(status, this.identity))
      return fail("IdentityMismatch", 409);
    const progress = await this.progress();
    if (
      progress.height !== null &&
      BigInt(status.head.height) <= BigInt(progress.height)
    ) {
      const known = await this.header(status.head.height);
      if (!known) return fail("StorageCorrupt", 503);
      if (
        known.hash !== status.head.hash ||
        known.stateRoot !== status.head.stateRoot
      )
        return fail("ChainConflict", 409);
      // An authentic retained prefix is an availability problem, never a fork or rollback.
      if (BigInt(status.head.height) < BigInt(progress.height))
        return fail("SourceBehind", 503);
    }
    if (
      progress.observed &&
      BigInt(status.head.height) < BigInt(progress.observed.head.height)
    )
      return;
    await this.db.query(
      `UPDATE ${this.q}.progress SET observed=$2 WHERE run_pk=$1`,
      [this.runPk, status],
    );
  }
  async health(code: string): Promise<void> {
    await this.db.query(
      `UPDATE ${this.q}.progress SET health=$2 WHERE run_pk=$1`,
      [this.runPk, code],
    );
  }
  async ingest(input: unknown): Promise<"committed" | "duplicate"> {
    const b = parseFeedBlock(input);
    if (!sameIdentity(b, this.identity)) return fail("IdentityMismatch", 409);
    const hash = b.feedDigest,
      q = this.q,
      h = b.header.height;
    return this.db.transaction(async (tx) => {
      const progress = (
        await tx.query<{ height: string | null; hash: string | null }>(
          `SELECT height,hash FROM ${q}.progress WHERE run_pk=$1 FOR UPDATE`,
          [this.runPk],
        )
      ).rows[0]!;
      const existing = (
        await tx.query<{ hash: string; fingerprint: string }>(
          `SELECT hash,fingerprint FROM ${q}.blocks WHERE run_pk=$1 AND height=$2`,
          [this.runPk, h],
        )
      ).rows[0];
      if (existing) {
        if (existing.hash !== b.header.hash || existing.fingerprint !== hash)
          return fail("ChainConflict", 409);
        return "duplicate";
      }
      if (
        BigInt(h) !==
          (progress.height === null ? 0n : BigInt(progress.height) + 1n) ||
        (progress.hash !== null && progress.hash !== b.header.parentHash)
      )
        return fail("ChainConflict", 409);
      if (progress.height !== null) {
        const prior = (
          await tx.query<{ timestamp_ms: string }>(
            `SELECT timestamp_ms FROM ${q}.blocks WHERE run_pk=$1 AND height=$2`,
            [this.runPk, progress.height],
          )
        ).rows[0];
        if (
          !prior ||
          BigInt(b.header.timestampMs) <= BigInt(prior.timestamp_ms)
        )
          return fail("InvalidHeader");
      }
      await tx.query(
        `INSERT INTO ${q}.blocks VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          this.runPk,
          h,
          b.header.hash,
          b.header.parentHash,
          b.header.timestampMs,
          b.header,
          JSON.stringify(b),
          hash,
          b.transactions.length,
          b.operations.length,
          b.spentUnits,
        ],
      );
      for (const t of b.transactions) {
        const old = await tx.query(
          `SELECT 1 FROM ${q}.transactions WHERE run_pk=$1 AND actor=$2 AND request_id=$3`,
          [this.runPk, t.actor, t.requestId],
        );
        if (old.rows.length) return fail("RequestConflict", 409);
        await tx.query(
          `INSERT INTO ${q}.transactions VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            this.runPk,
            h,
            t.position,
            t.actor,
            t.requestId,
            t.digest,
            t.status,
            t,
          ],
        );
      }
      for (const op of b.operations)
        await tx.query(
          `INSERT INTO ${q}.operations VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            this.runPk,
            h,
            { admin: 0, expiry: 1, user: 2 }[op.phase],
            op.groupPosition,
            op.operationPosition,
            op.namespaceId,
            op.recordId,
            op.recordKey,
            op,
          ],
        );
      let live = 0,
        namespaces = 0,
        raw = 0;
      // Delete old incarnations before inserting a new ID at the same live key.
      const changes = [...b.changes].sort((a, c) => rank(a) - rank(c));
      for (const change of changes) {
        const delta = await this.applyChange(tx, b, change);
        live += delta.live;
        namespaces += delta.namespaces;
        raw += delta.raw;
      }
      await tx.query(
        `UPDATE ${q}.progress SET height=$2,hash=$3,blocks=blocks+1,transactions=transactions+$4,operations=operations+$5,spent_units=spent_units+$6,live_records=live_records+$7,namespaces=namespaces+$8,raw_records=raw_records+$9,health='running' WHERE run_pk=$1`,
        [
          this.runPk,
          h,
          b.header.hash,
          b.transactions.length,
          b.operations.length,
          b.spentUnits,
          live,
          namespaces,
          raw,
        ],
      );
      await tx.query("SELECT pg_notify($1,$2)", [`sim_${this.schema}`, h]);
      return "committed";
    });
  }
  private async applyChange(
    tx: DbQueryable,
    b: FeedBlock,
    c: Change,
  ): Promise<{ live: number; namespaces: number; raw: number }> {
    const q = this.q,
      h = b.header.height,
      args = [this.runPk, c.namespaceId],
      delta = { live: 0, namespaces: 0, raw: 0 };
    if (c.kind === "namespaceUpsert") {
      const prior = await tx.query(
        `SELECT 1 FROM ${q}.namespace_versions WHERE run_pk=$1 AND namespace_id=$2 AND to_height IS NULL`,
        args,
      );
      delta.namespaces = prior.rows.length ? 0 : 1;
      await tx.query(
        `UPDATE ${q}.namespace_versions SET to_height=$3 WHERE run_pk=$1 AND namespace_id=$2 AND to_height IS NULL`,
        [...args, h],
      );
      await tx.query(
        `INSERT INTO ${q}.namespace_versions VALUES($1,$2,$3,NULL,$4)`,
        [...args, h, JSON.stringify(c)],
      );
      return delta;
    }
    if (
      !(
        await tx.query(
          `SELECT 1 FROM ${q}.namespace_versions WHERE run_pk=$1 AND namespace_id=$2 AND to_height IS NULL`,
          args,
        )
      ).rows.length
    )
      return fail("InvalidProjection");
    if (c.kind === "recordDelete" || c.kind === "recordUpsert") {
      const prior = (
        await tx.query<{
          record_key: string;
          deleted: boolean;
          created_height: string;
        }>(
          `SELECT record_key,deleted,created_height FROM ${q}.record_versions WHERE run_pk=$1 AND namespace_id=$2 AND record_id=$3 AND to_height IS NULL`,
          [...args, c.recordId],
        )
      ).rows[0];
      if (prior && (prior.record_key !== c.recordKey || prior.deleted))
        return fail("InvalidIncarnation");
      const created = b.operations.some(
        (op) =>
          op.outcome === "applied" &&
          op.kind === "createRecord" &&
          op.namespaceId === c.namespaceId &&
          op.recordId === c.recordId &&
          op.recordKey === c.recordKey,
      );
      if (!prior && !created) return fail("InvalidIncarnation");
      const deleted = c.kind === "recordDelete";
      if (!deleted) {
        const occupied = await tx.query(
          `SELECT 1 FROM ${q}.record_versions WHERE run_pk=$1 AND namespace_id=$2 AND record_key=$3 AND record_id<>$4 AND to_height IS NULL AND NOT deleted`,
          [...args, c.recordKey, c.recordId],
        );
        if (occupied.rows.length) return fail("InvalidIncarnation", 409);
      }
      delta.live = (deleted ? 0 : 1) - (prior && !prior.deleted ? 1 : 0);
      await tx.query(
        `UPDATE ${q}.record_versions SET to_height=$4 WHERE run_pk=$1 AND namespace_id=$2 AND record_id=$3 AND to_height IS NULL`,
        [...args, c.recordId, h],
      );
      await tx.query(
        `INSERT INTO ${q}.record_versions VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8)`,
        [
          ...args,
          c.recordId,
          h,
          c.recordKey,
          deleted,
          prior?.created_height ?? h,
          JSON.stringify(c),
        ],
      );
      if (c.kind === "recordUpsert")
        for (const a of c.attributes)
          await tx.query(
            `INSERT INTO ${q}.record_attributes VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              ...args,
              c.recordId,
              h,
              Buffer.from(a.name),
              a.type,
              a.type === "u64" || a.type === "i64" ? a.value : null,
              a.type === "bool" ? a.value : null,
              a.type === "str" ? Buffer.from(a.value as string) : null,
            ],
          );
      return delta;
    }
    const prior = (
      await tx.query<{ deleted: boolean }>(
        `SELECT deleted FROM ${q}.raw_versions WHERE run_pk=$1 AND namespace_id=$2 AND raw_key=$3 AND to_height IS NULL`,
        [...args, c.key],
      )
    ).rows[0];
    const deleted = c.kind === "rawDelete";
    delta.raw = (deleted ? 0 : 1) - (prior && !prior.deleted ? 1 : 0);
    await tx.query(
      `UPDATE ${q}.raw_versions SET to_height=$4 WHERE run_pk=$1 AND namespace_id=$2 AND raw_key=$3 AND to_height IS NULL`,
      [...args, c.key, h],
    );
    await tx.query(
      `INSERT INTO ${q}.raw_versions VALUES($1,$2,$3,$4,NULL,$5,$6)`,
      [...args, c.key, h, deleted, c],
    );
    return delta;
  }
  async header(height: string): Promise<Header | null> {
    return (
      (
        await this.db.query<{ header: Header }>(
          `SELECT header FROM ${this.q}.blocks WHERE run_pk=$1 AND height=$2`,
          [this.runPk, decimal(height)],
        )
      ).rows[0]?.header ?? null
    );
  }
  async block(height: string): Promise<FeedBlock> {
    await this.snapshot(height);
    const row = (
      await this.db.query<{ metadata: string }>(
        `SELECT metadata FROM ${this.q}.blocks WHERE run_pk=$1 AND height=$2`,
        [this.runPk, height],
      )
    ).rows[0];
    if (!row) return fail("StorageCorrupt", 503);
    return JSON.parse(row.metadata) as FeedBlock;
  }
  async snapshot(height?: string): Promise<SnapshotRef> {
    const p = await this.progress();
    if (p.height === null) return fail("CoverageUnavailable", 409);
    const pinned =
      height === undefined || height === "latest" ? p.height : decimal(height);
    if (BigInt(pinned) > BigInt(p.height))
      return fail("CoverageUnavailable", 409);
    const h = await this.header(pinned);
    if (!h) return fail("StorageCorrupt", 503);
    return { height: h.height, hash: h.hash, stateRoot: h.stateRoot };
  }
  async page(
    kind:
      | "blocks"
      | "transactions"
      | "operations"
      | "namespaces"
      | "records"
      | "raw"
      | "record-history",
    options: PageOptions = {},
  ): Promise<Page> {
    const limit = options.limit ?? 64;
    integer(limit, 256);
    if (limit === 0) return fail();
    const filter = {
      kind,
      namespaceId: options.namespaceId ?? null,
      actor: options.actor ?? null,
      status: options.status ?? null,
      recordKey: options.recordKey ?? null,
      recordId: options.recordId ?? null,
      predicate: options.predicate ?? null,
      limit,
    };
    const cursor = options.cursor
      ? cursorDecode(options.cursor, this.runToken, filter)
      : null;
    if (
      cursor &&
      options.atHeight &&
      options.atHeight !== "latest" &&
      options.atHeight !== cursor.height
    )
      return fail("CursorMismatch", 409);
    const snapshot = await this.snapshot(cursor?.height ?? options.atHeight);
    if (cursor && cursor.hash !== snapshot.hash)
      return fail("CursorMismatch", 409);
    const p = new SqlArgs(),
      run = p.add(this.runPk),
      height = p.add(snapshot.height),
      q = this.q;
    const last = cursor?.last ?? [];
    let sql: string;
    let key: (row: Record<string, unknown>) => string[];
    const namespace = options.namespaceId
      ? decimal(options.namespaceId, true)
      : null;
    if (["records", "raw", "record-history"].includes(kind) && !namespace)
      return fail("NamespaceRequired");
    if (
      namespace &&
      !(
        await this.db.query(
          `SELECT 1 FROM ${q}.namespace_versions WHERE run_pk=$1 AND namespace_id=$2 AND from_height<=$3 AND (to_height IS NULL OR to_height>$3)`,
          [this.runPk, namespace, snapshot.height],
        )
      ).rows.length
    )
      return fail("NamespaceNotFound", 404);
    if (kind === "blocks") {
      if (last.length && last.length !== 1) return fail("CursorMismatch", 409);
      sql = `SELECT height::text AS _height,header AS data,tx_count AS "transactionCount",op_count AS "operationCount",spent_units::text AS "spentUnits" FROM ${q}.blocks WHERE run_pk=${run} AND height<=${height}${last.length ? ` AND height>${p.add(decimal(last[0]))}` : ""} ORDER BY height`;
      key = (r) => [String(r._height)];
    } else if (kind === "transactions") {
      if (last.length && last.length !== 2) return fail("CursorMismatch", 409);
      sql = `SELECT height::text AS _height,position AS _position,data FROM ${q}.transactions WHERE run_pk=${run} AND height<=${height}${options.actor ? ` AND actor=${p.add(options.actor)}` : ""}${options.status ? ` AND status=${p.add(options.status)}` : ""}${last.length ? ` AND (height,position)>(${p.add(decimal(last[0]))},${p.add(integer(Number(last[1]), 65535))})` : ""} ORDER BY height,position`;
      key = (r) => [String(r._height), String(r._position)];
    } else if (kind === "operations" || kind === "record-history") {
      if (last.length && last.length !== 4) return fail("CursorMismatch", 409);
      sql = `SELECT height::text AS _height,phase AS _phase,group_position AS _group,op_position AS _op,data FROM ${q}.operations WHERE run_pk=${run} AND height<=${height}${namespace ? ` AND namespace_id=${p.add(namespace)}` : ""}${options.recordKey ? ` AND record_key=${p.add(options.recordKey)}` : ""}${options.recordId ? ` AND record_id=${p.add(decimal(options.recordId, true))}` : ""}${last.length ? ` AND (height,phase,group_position,op_position)>(${p.add(decimal(last[0]))},${p.add(integer(Number(last[1]), 2))},${p.add(integer(Number(last[2]), 65535))},${p.add(integer(Number(last[3]), 65535))})` : ""} ORDER BY height,phase,group_position,op_position`;
      key = (r) => [
        String(r._height),
        String(r._phase),
        String(r._group),
        String(r._op),
      ];
    } else if (kind === "namespaces") {
      if (last.length && last.length !== 1) return fail("CursorMismatch", 409);
      sql = `SELECT namespace_id::text AS _id,data FROM ${q}.namespace_versions WHERE run_pk=${run} AND from_height<=${height} AND (to_height IS NULL OR to_height>${height})${last.length ? ` AND namespace_id>${p.add(decimal(last[0], true))}` : ""} ORDER BY namespace_id`;
      key = (r) => [String(r._id)];
    } else if (kind === "raw") {
      if (last.length && last.length !== 1) return fail("CursorMismatch", 409);
      sql = `SELECT raw_key AS _key,data FROM ${q}.raw_versions WHERE run_pk=${run} AND namespace_id=${p.add(namespace)} AND from_height<=${height} AND (to_height IS NULL OR to_height>${height}) AND NOT deleted${last.length ? ` AND raw_key>${p.add(text(last[0], 42))} COLLATE "C"` : ""} ORDER BY raw_key COLLATE "C"`;
      key = (r) => [String(r._key)];
    } else {
      if (last.length && last.length !== 1) return fail("CursorMismatch", 409);
      sql = `SELECT r.record_id::text AS _id,r.created_height::text AS "createdAtHeight",r.from_height::text AS "updatedAtHeight",r.data FROM ${q}.record_versions r WHERE r.run_pk=${run} AND r.namespace_id=${p.add(namespace)} AND r.from_height<=${height} AND (r.to_height IS NULL OR r.to_height>${height}) AND NOT r.deleted${options.recordKey ? ` AND r.record_key=${p.add(options.recordKey)}` : ""}${options.recordId ? ` AND r.record_id=${p.add(decimal(options.recordId, true))}` : ""}${last.length ? ` AND r.record_id>${p.add(decimal(last[0], true))}` : ""} AND ${predicateSql(options.predicate ?? null, q, p)} ORDER BY r.record_id`;
      key = (r) => [String(r._id)];
    }
    sql += ` LIMIT ${p.add(limit + 1)}`;
    let fetched: Record<string, unknown>[];
    try {
      fetched = await this.db.transaction(async (tx) => {
        await tx.query("SET LOCAL statement_timeout='5s'");
        return (await tx.query<Record<string, unknown>>(sql, p.values)).rows;
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "57014"
      )
        return fail("QueryBudgetExceeded", 422);
      throw error;
    }
    const selected = fetched.slice(0, limit),
      more = fetched.length > limit;
    const rows = selected.map((r) => {
      const result = {
        ...(typeof r.data === "string"
          ? JSON.parse(r.data)
          : (r.data as Record<string, unknown>)),
      };
      for (const [k, v] of Object.entries(r))
        if (k !== "data" && !k.startsWith("_")) result[k] = v;
      if ("_height" in r) result.height = r._height;
      return result;
    });
    return {
      sourceKind: "arkiv-native-simulator",
      identity: this.identity,
      snapshot,
      verification: "unverified-projection",
      rows,
      nextCursor: more
        ? cursorEncode({
            version: 1,
            run: this.runToken,
            height: snapshot.height,
            hash: snapshot.hash,
            filter: fingerprint(filter),
            last: key(selected[selected.length - 1]!),
          })
        : null,
    };
  }
}
function rank(c: Change): number {
  return c.kind === "namespaceUpsert"
    ? 0
    : c.kind === "recordDelete" || c.kind === "rawDelete"
      ? 1
      : 2;
}
