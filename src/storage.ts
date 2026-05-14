import pg from "pg";
import {
  DEFAULT_RANGE_SIZE,
  assertSupportedRangeSize,
  computeBlockRange,
  rangeEndFor,
  type BlockRangeMetrics,
} from "./ranges";
import type { BlockMetrics } from "./types";

const { Pool, types } = pg;

types.setTypeParser(20, (value: string) => value);

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
  limit?: number;
}

export interface BlockRangeQueryFilter {
  rangeSize?: bigint;
  rangeStartGt?: bigint;
  rangeStartLt?: bigint;
  dateGt?: string;
  dateLt?: string;
  limit?: number;
}

export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  maxGasInBlock: string;
  transactionCount: number;
  totalTransactionFeeWei?: string;
  priorityFeeWeightedNumeratorWei?: string;
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

export interface ScannerStorageOptions {
  schema?: string;
}

export class ScannerStorage {
  private readonly schema: string;
  private readonly qBlocks: string;
  private readonly qScannerState: string;
  private readonly qBlockRanges: string;

  private constructor(
    private readonly pool: pg.Pool,
    options: ScannerStorageOptions = {},
  ) {
    this.schema = options.schema ?? "public";
    this.qBlocks = `${quoteIdent(this.schema)}.blocks`;
    this.qScannerState = `${quoteIdent(this.schema)}.scanner_state`;
    this.qBlockRanges = `${quoteIdent(this.schema)}.block_ranges`;
  }

  static async open(
    connectionString: string,
    options: ScannerStorageOptions = {},
  ): Promise<ScannerStorage> {
    const pool = new Pool({ connectionString });
    const storage = new ScannerStorage(pool, options);
    await storage.initSchema();
    return storage;
  }

  static async fromPool(
    pool: pg.Pool,
    options: ScannerStorageOptions = {},
  ): Promise<ScannerStorage> {
    const storage = new ScannerStorage(pool, options);
    await storage.initSchema();
    return storage;
  }

  private async initSchema(): Promise<void> {
    if (this.schema !== "public") {
      await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schema)}`);
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qBlocks} (
        block_number BIGINT PRIMARY KEY,
        block_date TEXT NOT NULL,
        base_block_fee_wei TEXT NOT NULL,
        total_gas_used TEXT NOT NULL,
        max_gas_in_block TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        total_transaction_fee_wei TEXT NOT NULL DEFAULT '0',
        priority_fee_weighted_numerator_wei TEXT NOT NULL DEFAULT '0',
        average_transaction_fee_wei TEXT NOT NULL,
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS total_transaction_fee_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_weighted_numerator_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qScannerState} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qBlockRanges} (
        range_size BIGINT NOT NULL,
        range_start BIGINT NOT NULL,
        range_end BIGINT NOT NULL,
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
        aggregated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (range_size, range_start)
      )
    `);
  }

  async getLastSuccessfulBlock(): Promise<bigint | undefined> {
    return this.getStateBigInt(LAST_SUCCESSFUL_BLOCK_KEY);
  }

  async getBackfillNextBlock(): Promise<bigint | undefined> {
    return this.getStateBigInt(BACKFILL_NEXT_BLOCK_KEY);
  }

  private async getStateBigInt(key: string): Promise<bigint | undefined> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM ${this.qScannerState} WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? BigInt(row.value) : undefined;
  }

  async saveBlockMetrics(
    metrics: BlockMetrics,
    progressUpdate: BlockProgressUpdate = { kind: "lastSuccessfulBlock" },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${this.qBlocks} (
          block_number,
          block_date,
          base_block_fee_wei,
          total_gas_used,
          max_gas_in_block,
          transaction_count,
          total_transaction_fee_wei,
          priority_fee_weighted_numerator_wei,
          average_transaction_fee_wei,
          average_priority_fee_weighted_wei,
          average_priority_fee_wei,
          scanned_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (block_number) DO UPDATE SET
          block_date = EXCLUDED.block_date,
          base_block_fee_wei = EXCLUDED.base_block_fee_wei,
          total_gas_used = EXCLUDED.total_gas_used,
          max_gas_in_block = EXCLUDED.max_gas_in_block,
          transaction_count = EXCLUDED.transaction_count,
          total_transaction_fee_wei = EXCLUDED.total_transaction_fee_wei,
          priority_fee_weighted_numerator_wei = EXCLUDED.priority_fee_weighted_numerator_wei,
          average_transaction_fee_wei = EXCLUDED.average_transaction_fee_wei,
          average_priority_fee_weighted_wei = EXCLUDED.average_priority_fee_weighted_wei,
          average_priority_fee_wei = EXCLUDED.average_priority_fee_wei,
          scanned_at = NOW()`,
        [
          metrics.blockNumber.toString(),
          metrics.blockDate,
          metrics.baseBlockFeeWei,
          metrics.totalGasUsed,
          metrics.maxGasInBlock,
          metrics.transactionCount,
          metrics.totalTransactionFeeWei,
          metrics.priorityFeeWeightedNumeratorWei,
          metrics.averageTransactionFeeWei,
          metrics.averagePriorityFeeWeightedWei,
          metrics.averagePriorityFeeWei,
        ],
      );
      await this.applyProgressUpdate(client, metrics, progressUpdate);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async queryBlocks(filter: BlockQueryFilter = {}): Promise<StoredBlock[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.blockGt !== undefined) {
      params.push(filter.blockGt.toString());
      clauses.push(`block_number > $${params.length}`);
    }

    if (filter.blockLt !== undefined) {
      params.push(filter.blockLt.toString());
      clauses.push(`block_number < $${params.length}`);
    }

    if (filter.dateGt !== undefined) {
      params.push(filter.dateGt);
      clauses.push(`block_date > $${params.length}`);
    }

    if (filter.dateLt !== undefined) {
      params.push(filter.dateLt);
      clauses.push(`block_date < $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(resolveLimit(filter.limit, MAX_BLOCKS_PER_QUERY));
    const sql = `
      SELECT
        block_number,
        block_date,
        base_block_fee_wei,
        total_gas_used,
        max_gas_in_block,
        transaction_count,
        total_transaction_fee_wei,
        priority_fee_weighted_numerator_wei,
        average_transaction_fee_wei,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei
      FROM ${this.qBlocks}
      ${where}
      ORDER BY block_number ASC
      LIMIT $${params.length}
    `;

    const result = await this.pool.query<{
      block_number: string;
      block_date: string;
      base_block_fee_wei: string;
      total_gas_used: string;
      max_gas_in_block: string;
      transaction_count: number;
      total_transaction_fee_wei: string;
      priority_fee_weighted_numerator_wei: string;
      average_transaction_fee_wei: string;
      average_priority_fee_weighted_wei: string;
      average_priority_fee_wei: string;
    }>(sql, params);

    return result.rows.map((row) => ({
      blockNumber: Number(row.block_number),
      blockDate: row.block_date,
      baseBlockFeeWei: row.base_block_fee_wei,
      totalGasUsed: row.total_gas_used,
      maxGasInBlock: row.max_gas_in_block,
      transactionCount: row.transaction_count,
      totalTransactionFeeWei: row.total_transaction_fee_wei,
      priorityFeeWeightedNumeratorWei: row.priority_fee_weighted_numerator_wei,
      averageTransactionFeeWei: row.average_transaction_fee_wei,
      averagePriorityFeeWeightedWei: row.average_priority_fee_weighted_wei,
      averagePriorityFeeWei: row.average_priority_fee_wei,
    }));
  }

  async getBlocksForRange(rangeStart: bigint, rangeSize: bigint): Promise<StoredBlock[]> {
    assertSupportedRangeSize(rangeSize);
    if (rangeStart < 0n || rangeStart % rangeSize !== 0n) {
      throw new Error(
        `Range start ${rangeStart.toString()} must be a non-negative multiple of ${rangeSize.toString()}`,
      );
    }
    const rangeEnd = rangeEndFor(rangeStart, rangeSize);
    return this.queryBlocks({
      blockGt: rangeStart - 1n,
      blockLt: rangeEnd + 1n,
    });
  }

  async aggregateRangeIfComplete(
    rangeStart: bigint,
    rangeSize: bigint,
  ): Promise<BlockRangeMetrics | undefined> {
    assertSupportedRangeSize(rangeSize);
    const blocks = await this.getBlocksForRange(rangeStart, rangeSize);
    if (BigInt(blocks.length) !== rangeSize) {
      return undefined;
    }
    const metrics = computeBlockRange(rangeStart, rangeSize, blocks);
    await this.saveBlockRange(metrics);
    return metrics;
  }

  async saveBlockRange(metrics: BlockRangeMetrics): Promise<void> {
    assertSupportedRangeSize(metrics.rangeSize);
    await this.pool.query(
      `INSERT INTO ${this.qBlockRanges} (
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (range_size, range_start) DO UPDATE SET
        range_end = EXCLUDED.range_end,
        min_block_date = EXCLUDED.min_block_date,
        max_block_date = EXCLUDED.max_block_date,
        min_base_fee_wei = EXCLUDED.min_base_fee_wei,
        max_base_fee_wei = EXCLUDED.max_base_fee_wei,
        average_base_fee_wei = EXCLUDED.average_base_fee_wei,
        total_gas_used = EXCLUDED.total_gas_used,
        total_max_gas = EXCLUDED.total_max_gas,
        transaction_count = EXCLUDED.transaction_count,
        average_priority_fee_weighted_wei = EXCLUDED.average_priority_fee_weighted_wei,
        average_priority_fee_wei = EXCLUDED.average_priority_fee_wei,
        aggregated_at = NOW()`,
      [
        metrics.rangeSize.toString(),
        metrics.rangeStart.toString(),
        metrics.rangeEnd.toString(),
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
      ],
    );
  }

  async queryBlockRanges(filter: BlockRangeQueryFilter = {}): Promise<StoredBlockRange[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    const rangeSize = filter.rangeSize ?? DEFAULT_RANGE_SIZE;
    assertSupportedRangeSize(rangeSize);
    params.push(rangeSize.toString());
    clauses.push(`range_size = $${params.length}`);

    if (filter.rangeStartGt !== undefined) {
      params.push(filter.rangeStartGt.toString());
      clauses.push(`range_start > $${params.length}`);
    }

    if (filter.rangeStartLt !== undefined) {
      params.push(filter.rangeStartLt.toString());
      clauses.push(`range_start < $${params.length}`);
    }

    if (filter.dateGt !== undefined) {
      params.push(filter.dateGt);
      clauses.push(`max_block_date > $${params.length}`);
    }

    if (filter.dateLt !== undefined) {
      params.push(filter.dateLt);
      clauses.push(`min_block_date < $${params.length}`);
    }

    params.push(resolveLimit(filter.limit, MAX_RANGES_PER_QUERY));

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
      FROM ${this.qBlockRanges}
      WHERE ${clauses.join(" AND ")}
      ORDER BY range_start ASC
      LIMIT $${params.length}
    `;

    const result = await this.pool.query<{
      range_size: string;
      range_start: string;
      range_end: string;
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
    }>(sql, params);

    return result.rows.map((row) => ({
      rangeSize: Number(row.range_size),
      rangeStart: Number(row.range_start),
      rangeEnd: Number(row.range_end),
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

  async getMinStoredBlock(): Promise<bigint | undefined> {
    const result = await this.pool.query<{ value: string | null }>(
      `SELECT MIN(block_number)::text AS value FROM ${this.qBlocks}`,
    );
    const row = result.rows[0];
    return row && row.value !== null ? BigInt(row.value) : undefined;
  }

  async getMaxStoredBlock(): Promise<bigint | undefined> {
    const result = await this.pool.query<{ value: string | null }>(
      `SELECT MAX(block_number)::text AS value FROM ${this.qBlocks}`,
    );
    const row = result.rows[0];
    return row && row.value !== null ? BigInt(row.value) : undefined;
  }

  private async applyProgressUpdate(
    client: pg.PoolClient,
    metrics: BlockMetrics,
    progressUpdate: BlockProgressUpdate,
  ): Promise<void> {
    switch (progressUpdate.kind) {
      case "lastSuccessfulBlock":
        await client.query(
          `INSERT INTO ${this.qScannerState} (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [LAST_SUCCESSFUL_BLOCK_KEY, metrics.blockNumber.toString()],
        );
        return;
      case "backfillNextBlock":
        await client.query(
          `INSERT INTO ${this.qScannerState} (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [BACKFILL_NEXT_BLOCK_KEY, progressUpdate.nextBlock.toString()],
        );
        return;
      case "none":
        return;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function resolveLimit(requested: number | undefined, hardMax: number): number {
  if (requested === undefined) return hardMax;
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), hardMax);
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}
