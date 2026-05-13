import { Database } from "bun:sqlite";
import {
  DEFAULT_RANGE_SIZE,
  assertSupportedRangeSize,
  computeBlockRange,
  rangeEndFor,
  type BlockRangeMetrics,
} from "./ranges";
import type { BlockMetrics } from "./types";

const LAST_SUCCESSFUL_BLOCK_KEY = "last_successful_block";
const BACKFILL_NEXT_BLOCK_KEY = "backfill_next_block";

export const MAX_BLOCKS_PER_QUERY = 10_000;
export const MAX_RANGES_PER_QUERY = 10_000;

export type BlockProgressUpdate =
  | { kind: "lastSuccessfulBlock" }
  | { kind: "backfillNextBlock"; nextBlock: bigint }
  | { kind: "none" };

export interface BlockQueryFilter {
  blockGt?: bigint;
  blockLt?: bigint;
  dateGt?: string;
  dateLt?: string;
}

export interface BlockRangeQueryFilter {
  rangeSize?: bigint;
  rangeStartGt?: bigint;
  rangeStartLt?: bigint;
  dateGt?: string;
  dateLt?: string;
}

export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  maxGasInBlock: string;
  transactionCount: number;
  averageTransactionFeeWei: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}

export interface StoredBlockRange {
  rangeSize: number;
  rangeStart: number;
  rangeEnd: number;
  minBlockDate: string;
  maxBlockDate: string;
  minBaseFeeWei: string;
  maxBaseFeeWei: string;
  averageBaseFeeWei: string;
  totalGasUsed: string;
  totalMaxGas: string;
  transactionCount: number;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}

export class ScannerStorage {
  private readonly insertBlock;
  private readonly upsertState;
  private readonly insertBlockRange;

  constructor(private readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        block_number INTEGER PRIMARY KEY,
        block_date TEXT NOT NULL,
        base_block_fee_wei TEXT NOT NULL,
        total_gas_used TEXT NOT NULL,
        max_gas_in_block TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        average_transaction_fee_wei TEXT NOT NULL,
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS scanner_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS block_ranges (
        range_size INTEGER NOT NULL,
        range_start INTEGER NOT NULL,
        range_end INTEGER NOT NULL,
        min_block_date TEXT NOT NULL,
        max_block_date TEXT NOT NULL,
        min_base_fee_wei TEXT NOT NULL,
        max_base_fee_wei TEXT NOT NULL,
        average_base_fee_wei TEXT NOT NULL,
        total_gas_used TEXT NOT NULL,
        total_max_gas TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        aggregated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (range_size, range_start)
      );
    `);

    migrateBlockRangesSchema(this.db);

    this.insertBlock = this.db.prepare(`
      INSERT OR REPLACE INTO blocks (
        block_number,
        block_date,
        base_block_fee_wei,
        total_gas_used,
        max_gas_in_block,
        transaction_count,
        average_transaction_fee_wei,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    this.upsertState = this.db.prepare(`
      INSERT INTO scanner_state (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);

    this.insertBlockRange = this.db.prepare(`
      INSERT OR REPLACE INTO block_ranges (
        range_size,
        range_start,
        range_end,
        min_block_date,
        max_block_date,
        min_base_fee_wei,
        max_base_fee_wei,
        average_base_fee_wei,
        total_gas_used,
        total_max_gas,
        transaction_count,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        aggregated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
  }

  static open(path: string): ScannerStorage {
    return new ScannerStorage(new Database(path, { create: true }));
  }

  getLastSuccessfulBlock(): bigint | undefined {
    return this.getStateBigInt(LAST_SUCCESSFUL_BLOCK_KEY);
  }

  getBackfillNextBlock(): bigint | undefined {
    return this.getStateBigInt(BACKFILL_NEXT_BLOCK_KEY);
  }

  private getStateBigInt(key: string): bigint | undefined {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM scanner_state WHERE key = ?")
      .get(key);

    return row ? BigInt(row.value) : undefined;
  }

  saveBlockMetrics(
    metrics: BlockMetrics,
    progressUpdate: BlockProgressUpdate = { kind: "lastSuccessfulBlock" },
  ): void {
    if (metrics.blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("SQLite block_number storage only supports JavaScript safe integers");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertBlock.run(
        Number(metrics.blockNumber),
        metrics.blockDate,
        metrics.baseBlockFeeWei,
        metrics.totalGasUsed,
        metrics.maxGasInBlock,
        metrics.transactionCount,
        metrics.averageTransactionFeeWei,
        metrics.averagePriorityFeeWeightedWei,
        metrics.averagePriorityFeeWei,
      );
      this.saveProgressUpdate(metrics, progressUpdate);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  queryBlocks(filter: BlockQueryFilter = {}): StoredBlock[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.blockGt !== undefined) {
      if (filter.blockGt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("blockGt exceeds the supported integer range");
      }
      clauses.push("block_number > ?");
      params.push(Number(filter.blockGt));
    }

    if (filter.blockLt !== undefined) {
      if (filter.blockLt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("blockLt exceeds the supported integer range");
      }
      clauses.push("block_number < ?");
      params.push(Number(filter.blockLt));
    }

    if (filter.dateGt !== undefined) {
      clauses.push("block_date > ?");
      params.push(filter.dateGt);
    }

    if (filter.dateLt !== undefined) {
      clauses.push("block_date < ?");
      params.push(filter.dateLt);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT
        block_number,
        block_date,
        base_block_fee_wei,
        total_gas_used,
        max_gas_in_block,
        transaction_count,
        average_transaction_fee_wei,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei
      FROM blocks
      ${where}
      ORDER BY block_number ASC
      LIMIT ?
    `;

    const rows = this.db
      .query<
        {
          block_number: number;
          block_date: string;
          base_block_fee_wei: string;
          total_gas_used: string;
          max_gas_in_block: string;
          transaction_count: number;
          average_transaction_fee_wei: string;
          average_priority_fee_weighted_wei: string;
          average_priority_fee_wei: string;
        },
        Array<string | number>
      >(sql)
      .all(...params, MAX_BLOCKS_PER_QUERY);

    return rows.map((row) => ({
      blockNumber: row.block_number,
      blockDate: row.block_date,
      baseBlockFeeWei: row.base_block_fee_wei,
      totalGasUsed: row.total_gas_used,
      maxGasInBlock: row.max_gas_in_block,
      transactionCount: row.transaction_count,
      averageTransactionFeeWei: row.average_transaction_fee_wei,
      averagePriorityFeeWeightedWei: row.average_priority_fee_weighted_wei,
      averagePriorityFeeWei: row.average_priority_fee_wei,
    }));
  }

  getBlocksForRange(rangeStart: bigint, rangeSize: bigint): StoredBlock[] {
    assertSupportedRangeSize(rangeSize);
    if (rangeStart < 0n || rangeStart % rangeSize !== 0n) {
      throw new Error(
        `Range start ${rangeStart.toString()} must be a non-negative multiple of ${rangeSize.toString()}`,
      );
    }
    const rangeEnd = rangeEndFor(rangeStart, rangeSize);
    if (rangeEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Range end exceeds the supported integer range");
    }
    return this.queryBlocks({
      blockGt: rangeStart - 1n,
      blockLt: rangeEnd + 1n,
    });
  }

  aggregateRangeIfComplete(
    rangeStart: bigint,
    rangeSize: bigint,
  ): BlockRangeMetrics | undefined {
    assertSupportedRangeSize(rangeSize);
    const blocks = this.getBlocksForRange(rangeStart, rangeSize);
    if (BigInt(blocks.length) !== rangeSize) {
      return undefined;
    }
    const metrics = computeBlockRange(rangeStart, rangeSize, blocks);
    this.saveBlockRange(metrics);
    return metrics;
  }

  saveBlockRange(metrics: BlockRangeMetrics): void {
    assertSupportedRangeSize(metrics.rangeSize);
    if (metrics.rangeEnd > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("SQLite range storage only supports JavaScript safe integers");
    }
    this.insertBlockRange.run(
      Number(metrics.rangeSize),
      Number(metrics.rangeStart),
      Number(metrics.rangeEnd),
      metrics.minBlockDate,
      metrics.maxBlockDate,
      metrics.minBaseFeeWei,
      metrics.maxBaseFeeWei,
      metrics.averageBaseFeeWei,
      metrics.totalGasUsed,
      metrics.totalMaxGas,
      metrics.transactionCount,
      metrics.averagePriorityFeeWeightedWei,
      metrics.averagePriorityFeeWei,
    );
  }

  queryBlockRanges(filter: BlockRangeQueryFilter = {}): StoredBlockRange[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    const rangeSize = filter.rangeSize ?? DEFAULT_RANGE_SIZE;
    assertSupportedRangeSize(rangeSize);
    clauses.push("range_size = ?");
    params.push(Number(rangeSize));

    if (filter.rangeStartGt !== undefined) {
      if (filter.rangeStartGt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("rangeStartGt exceeds the supported integer range");
      }
      clauses.push("range_start > ?");
      params.push(Number(filter.rangeStartGt));
    }

    if (filter.rangeStartLt !== undefined) {
      if (filter.rangeStartLt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("rangeStartLt exceeds the supported integer range");
      }
      clauses.push("range_start < ?");
      params.push(Number(filter.rangeStartLt));
    }

    if (filter.dateGt !== undefined) {
      clauses.push("max_block_date > ?");
      params.push(filter.dateGt);
    }

    if (filter.dateLt !== undefined) {
      clauses.push("min_block_date < ?");
      params.push(filter.dateLt);
    }

    const where = `WHERE ${clauses.join(" AND ")}`;
    const sql = `
      SELECT
        range_size,
        range_start,
        range_end,
        min_block_date,
        max_block_date,
        min_base_fee_wei,
        max_base_fee_wei,
        average_base_fee_wei,
        total_gas_used,
        total_max_gas,
        transaction_count,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei
      FROM block_ranges
      ${where}
      ORDER BY range_start ASC
      LIMIT ?
    `;

    const rows = this.db
      .query<
        {
          range_size: number;
          range_start: number;
          range_end: number;
          min_block_date: string;
          max_block_date: string;
          min_base_fee_wei: string;
          max_base_fee_wei: string;
          average_base_fee_wei: string;
          total_gas_used: string;
          total_max_gas: string;
          transaction_count: number;
          average_priority_fee_weighted_wei: string;
          average_priority_fee_wei: string;
        },
        Array<string | number>
      >(sql)
      .all(...params, MAX_RANGES_PER_QUERY);

    return rows.map((row) => ({
      rangeSize: row.range_size,
      rangeStart: row.range_start,
      rangeEnd: row.range_end,
      minBlockDate: row.min_block_date,
      maxBlockDate: row.max_block_date,
      minBaseFeeWei: row.min_base_fee_wei,
      maxBaseFeeWei: row.max_base_fee_wei,
      averageBaseFeeWei: row.average_base_fee_wei,
      totalGasUsed: row.total_gas_used,
      totalMaxGas: row.total_max_gas,
      transactionCount: row.transaction_count,
      averagePriorityFeeWeightedWei: row.average_priority_fee_weighted_wei,
      averagePriorityFeeWei: row.average_priority_fee_wei,
    }));
  }

  getMinStoredBlock(): bigint | undefined {
    const row = this.db
      .query<{ value: number | null }, []>("SELECT MIN(block_number) AS value FROM blocks")
      .get();
    return row?.value === null || row?.value === undefined ? undefined : BigInt(row.value);
  }

  getMaxStoredBlock(): bigint | undefined {
    const row = this.db
      .query<{ value: number | null }, []>("SELECT MAX(block_number) AS value FROM blocks")
      .get();
    return row?.value === null || row?.value === undefined ? undefined : BigInt(row.value);
  }

  private saveProgressUpdate(metrics: BlockMetrics, progressUpdate: BlockProgressUpdate): void {
    switch (progressUpdate.kind) {
      case "lastSuccessfulBlock":
        this.upsertState.run(LAST_SUCCESSFUL_BLOCK_KEY, metrics.blockNumber.toString());
        return;
      case "backfillNextBlock":
        this.upsertState.run(BACKFILL_NEXT_BLOCK_KEY, progressUpdate.nextBlock.toString());
        return;
      case "none":
        return;
    }
  }

  close(): void {
    this.db.close();
  }
}

function migrateBlockRangesSchema(db: Database): void {
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(block_ranges)")
    .all();
  if (columns.some((column) => column.name === "range_size")) {
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE block_ranges RENAME TO block_ranges_legacy");
    db.exec(`
      CREATE TABLE block_ranges (
        range_size INTEGER NOT NULL,
        range_start INTEGER NOT NULL,
        range_end INTEGER NOT NULL,
        min_block_date TEXT NOT NULL,
        max_block_date TEXT NOT NULL,
        min_base_fee_wei TEXT NOT NULL,
        max_base_fee_wei TEXT NOT NULL,
        average_base_fee_wei TEXT NOT NULL,
        total_gas_used TEXT NOT NULL,
        total_max_gas TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        aggregated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (range_size, range_start)
      )
    `);
    db.exec(`
      INSERT INTO block_ranges (
        range_size,
        range_start,
        range_end,
        min_block_date,
        max_block_date,
        min_base_fee_wei,
        max_base_fee_wei,
        average_base_fee_wei,
        total_gas_used,
        total_max_gas,
        transaction_count,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        aggregated_at
      )
      SELECT
        100,
        range_start,
        range_end,
        min_block_date,
        max_block_date,
        min_base_fee_wei,
        max_base_fee_wei,
        average_base_fee_wei,
        total_gas_used,
        total_max_gas,
        transaction_count,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        aggregated_at
      FROM block_ranges_legacy
    `);
    db.exec("DROP TABLE block_ranges_legacy");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
