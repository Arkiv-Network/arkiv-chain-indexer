import pg from "pg";
import {
  DEFAULT_RANGE_SIZE,
  assertSupportedRangeSize,
  computeBlockRange,
  rangeEndFor,
  type BlockRangeMetrics,
} from "./ranges";
import type { BlockMetrics, Hex } from "./types";
import type { InspectedBlock, InspectedTransaction } from "./blockInspector";

const { Pool, types } = pg;

types.setTypeParser(20, (value: string) => value);

const LAST_SUCCESSFUL_BLOCK_KEY = "last_successful_block";
const BACKFILL_NEXT_BLOCK_KEY = "backfill_next_block";
const LATEST_OBSERVED_BLOCK_KEY = "latest_observed_block";
const SAFE_HEAD_BLOCK_KEY = "safe_head_block";
const LATEST_OBSERVED_AT_KEY = "latest_observed_at";

export const MAX_BLOCKS_PER_QUERY = 10_000;
export const MAX_RANGES_PER_QUERY = 10_000;
export const MAX_TRANSACTIONS_PER_QUERY = 1_000;

export type QueryOrder = "asc" | "desc";

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
  order?: QueryOrder;
}

export interface BlockRangeQueryFilter {
  rangeSize?: bigint;
  rangeStartGt?: bigint;
  rangeStartLt?: bigint;
  dateGt?: string;
  dateLt?: string;
  limit?: number;
  order?: QueryOrder;
}

export interface TransactionQueryFilter {
  blockNumber?: bigint;
  blockGt?: bigint;
  blockLt?: bigint;
  dateGt?: string;
  dateLt?: string;
  limit?: number;
  order?: QueryOrder;
}

export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  maxGasInBlock: string;
  transactionCount: number;
  blockRewardWei?: string;
  burntFeesWei?: string;
  totalTransactionFeeWei?: string;
  feePriceSumWei?: string;
  priorityFeeSumWei?: string;
  priorityFeeWeightedNumeratorWei?: string;
  priorityFeeGasWeightedNumeratorWei?: string;
  averageFeePriceWei: string;
  averageTransactionFeeWei: string;
  averageTransactionGasUsed: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}

export interface StoredTransaction extends InspectedTransaction {
  blockNumber: number;
  blockNumberDecimal: string;
  blockDate: string;
  baseBlockFeeWei: string;
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
  minMaxGasInBlock: string;
  maxMaxGasInBlock: string;
  transactionCount: number;
  totalBlockRewardWei: string;
  totalBurntFeesWei: string;
  averageBlockRewardWei: string;
  averageBurntFeesWei: string;
  averageFeePriceWei: string;
  averageTransactionGasUsed: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
}

export interface ScannerStorageOptions {
  schema?: string;
}

export interface ScannerProgress {
  lastSuccessfulBlock?: bigint;
  lastSuccessfulBlockDate?: string;
  lastSuccessfulScannedAt?: string;
  backfillNextBlock?: bigint;
  latestObservedBlock?: bigint;
  safeHeadBlock?: bigint;
  latestObservedAt?: string;
}

export interface DatabaseTableStats {
  tableName: string;
  rowCount: string;
  tableSizeBytes: string;
  indexesSizeBytes: string;
  totalSizeBytes: string;
}

export interface DatabaseStats {
  totalSizeBytes: string;
  tables: DatabaseTableStats[];
}

export class ScannerStorage {
  private readonly schema: string;
  private readonly qBlocks: string;
  private readonly qScannerState: string;
  private readonly qBlockRanges: string;
  private readonly qTransactions: string;

  private constructor(
    private readonly pool: pg.Pool,
    options: ScannerStorageOptions = {},
  ) {
    this.schema = options.schema ?? "public";
    this.qBlocks = `${quoteIdent(this.schema)}.blocks`;
    this.qScannerState = `${quoteIdent(this.schema)}.scanner_state`;
    this.qBlockRanges = `${quoteIdent(this.schema)}.block_ranges`;
    this.qTransactions = `${quoteIdent(this.schema)}.transactions`;
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
        block_reward_wei TEXT NOT NULL DEFAULT '0',
        burnt_fees_wei TEXT NOT NULL DEFAULT '0',
        total_transaction_fee_wei TEXT NOT NULL DEFAULT '0',
        fee_price_sum_wei TEXT NOT NULL DEFAULT '0',
        priority_fee_sum_wei TEXT NOT NULL DEFAULT '0',
        priority_fee_weighted_numerator_wei TEXT NOT NULL DEFAULT '0',
        priority_fee_gas_weighted_numerator_wei TEXT NOT NULL DEFAULT '0',
        average_fee_price_wei TEXT NOT NULL DEFAULT '0',
        average_transaction_fee_wei TEXT NOT NULL,
        average_transaction_gas_used TEXT NOT NULL DEFAULT '0',
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS block_reward_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS burnt_fees_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS total_transaction_fee_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS fee_price_sum_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_sum_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_weighted_numerator_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_gas_weighted_numerator_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS average_fee_price_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS average_transaction_gas_used TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qScannerState} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.qTransactions} (
        block_number BIGINT NOT NULL,
        block_date TEXT NOT NULL,
        base_block_fee_wei TEXT NOT NULL,
        position INTEGER NOT NULL,
        hash TEXT NOT NULL,
        from_address TEXT,
        to_address TEXT,
        transaction_type TEXT,
        nonce TEXT,
        value_wei TEXT NOT NULL,
        gas_limit TEXT NOT NULL,
        gas_used TEXT NOT NULL,
        cumulative_gas_used TEXT,
        gas_price_wei TEXT,
        max_fee_per_gas_wei TEXT,
        max_priority_fee_per_gas_wei TEXT,
        effective_gas_price_wei TEXT NOT NULL,
        priority_fee_wei TEXT NOT NULL,
        transaction_fee_wei TEXT NOT NULL,
        status TEXT,
        contract_address TEXT,
        scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (block_number, position)
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transactions_block_date_idx")}
       ON ${this.qTransactions} (block_date)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transactions_hash_idx")}
       ON ${this.qTransactions} (hash)`,
    );
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
        min_max_gas_in_block TEXT NOT NULL,
        max_max_gas_in_block TEXT NOT NULL,
        transaction_count INTEGER NOT NULL,
        total_block_reward_wei TEXT NOT NULL DEFAULT '0',
        total_burnt_fees_wei TEXT NOT NULL DEFAULT '0',
        average_block_reward_wei TEXT NOT NULL DEFAULT '0',
        average_burnt_fees_wei TEXT NOT NULL DEFAULT '0',
        average_fee_price_wei TEXT NOT NULL DEFAULT '0',
        average_transaction_gas_used TEXT NOT NULL DEFAULT '0',
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        aggregated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (range_size, range_start)
      )
    `);
    await this.pool.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS total_block_reward_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS total_burnt_fees_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_block_reward_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_burnt_fees_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_fee_price_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.pool.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_transaction_gas_used TEXT NOT NULL DEFAULT '0'`,
    );
  }

  async getLastSuccessfulBlock(): Promise<bigint | undefined> {
    return this.getStateBigInt(LAST_SUCCESSFUL_BLOCK_KEY);
  }

  async getBackfillNextBlock(): Promise<bigint | undefined> {
    return this.getStateBigInt(BACKFILL_NEXT_BLOCK_KEY);
  }

  async saveChainProgress(
    latestObservedBlock: bigint,
    safeHeadBlock: bigint,
    observedAt: Date = new Date(),
  ): Promise<void> {
    const observedAtIso = observedAt.toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.upsertStateValue(client, LATEST_OBSERVED_BLOCK_KEY, latestObservedBlock.toString());
      await this.upsertStateValue(client, SAFE_HEAD_BLOCK_KEY, safeHeadBlock.toString());
      await this.upsertStateValue(client, LATEST_OBSERVED_AT_KEY, observedAtIso);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getScannerProgress(): Promise<ScannerProgress> {
    const stateResult = await this.pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.qScannerState}
       WHERE key = ANY($1::text[])`,
      [
        [
          LAST_SUCCESSFUL_BLOCK_KEY,
          BACKFILL_NEXT_BLOCK_KEY,
          LATEST_OBSERVED_BLOCK_KEY,
          SAFE_HEAD_BLOCK_KEY,
          LATEST_OBSERVED_AT_KEY,
        ],
      ],
    );
    const state = new Map(stateResult.rows.map((row) => [row.key, row.value]));

    const lastSuccessfulBlock = parseOptionalBigInt(state.get(LAST_SUCCESSFUL_BLOCK_KEY));
    const lastSuccessfulBlockDetails =
      lastSuccessfulBlock === undefined
        ? undefined
        : await this.getStoredBlockTiming(lastSuccessfulBlock);

    return {
      ...(lastSuccessfulBlock !== undefined ? { lastSuccessfulBlock } : {}),
      ...(lastSuccessfulBlockDetails?.blockDate !== undefined
        ? { lastSuccessfulBlockDate: lastSuccessfulBlockDetails.blockDate }
        : {}),
      ...(lastSuccessfulBlockDetails?.scannedAt !== undefined
        ? { lastSuccessfulScannedAt: lastSuccessfulBlockDetails.scannedAt }
        : {}),
      ...optionalBigIntField("backfillNextBlock", state.get(BACKFILL_NEXT_BLOCK_KEY)),
      ...optionalBigIntField("latestObservedBlock", state.get(LATEST_OBSERVED_BLOCK_KEY)),
      ...optionalBigIntField("safeHeadBlock", state.get(SAFE_HEAD_BLOCK_KEY)),
      ...optionalStringField("latestObservedAt", state.get(LATEST_OBSERVED_AT_KEY)),
    };
  }

  async getDatabaseStats(): Promise<DatabaseStats> {
    const appTables = [
      { name: "blocks", qualifiedName: this.qBlocks, regclassName: regclassName(this.schema, "blocks") },
      {
        name: "transactions",
        qualifiedName: this.qTransactions,
        regclassName: regclassName(this.schema, "transactions"),
      },
      {
        name: "block_ranges",
        qualifiedName: this.qBlockRanges,
        regclassName: regclassName(this.schema, "block_ranges"),
      },
      {
        name: "scanner_state",
        qualifiedName: this.qScannerState,
        regclassName: regclassName(this.schema, "scanner_state"),
      },
    ];

    const [databaseSizeResult, tableStats] = await Promise.all([
      this.pool.query<{ total_size_bytes: string }>(
        `SELECT pg_database_size(current_database())::text AS total_size_bytes`,
      ),
      Promise.all(
        appTables.map(async (table) => {
          const result = await this.pool.query<{
            row_count: string;
            table_size_bytes: string;
            indexes_size_bytes: string;
            total_size_bytes: string;
          }>(
            `SELECT
               COUNT(*)::text AS row_count,
               pg_relation_size($1::regclass)::text AS table_size_bytes,
               pg_indexes_size($1::regclass)::text AS indexes_size_bytes,
               pg_total_relation_size($1::regclass)::text AS total_size_bytes
             FROM ${table.qualifiedName}`,
            [table.regclassName],
          );
          const row = result.rows[0];
          return {
            tableName: table.name,
            rowCount: row?.row_count ?? "0",
            tableSizeBytes: row?.table_size_bytes ?? "0",
            indexesSizeBytes: row?.indexes_size_bytes ?? "0",
            totalSizeBytes: row?.total_size_bytes ?? "0",
          };
        }),
      ),
    ]);

    return {
      totalSizeBytes: databaseSizeResult.rows[0]?.total_size_bytes ?? "0",
      tables: tableStats,
    };
  }

  private async getStateBigInt(key: string): Promise<bigint | undefined> {
    const result = await this.pool.query<{ value: string }>(
      `SELECT value FROM ${this.qScannerState} WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? BigInt(row.value) : undefined;
  }

  private async getStoredBlockTiming(
    blockNumber: bigint,
  ): Promise<{ blockDate: string; scannedAt: string } | undefined> {
    const result = await this.pool.query<{ block_date: string; scanned_at_utc: string }>(
      `SELECT
         block_date,
         to_char(scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scanned_at_utc
       FROM ${this.qBlocks}
       WHERE block_number = $1`,
      [blockNumber.toString()],
    );
    const row = result.rows[0];
    return row ? { blockDate: row.block_date, scannedAt: row.scanned_at_utc } : undefined;
  }

  async saveBlockMetrics(
    metrics: BlockMetrics,
    progressUpdate: BlockProgressUpdate = { kind: "lastSuccessfulBlock" },
    transactions?: InspectedTransaction[],
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
          block_reward_wei,
          burnt_fees_wei,
          total_transaction_fee_wei,
          fee_price_sum_wei,
          priority_fee_sum_wei,
          priority_fee_weighted_numerator_wei,
          priority_fee_gas_weighted_numerator_wei,
          average_fee_price_wei,
          average_transaction_fee_wei,
          average_transaction_gas_used,
          average_priority_fee_weighted_wei,
          average_priority_fee_wei,
          scanned_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
        ON CONFLICT (block_number) DO UPDATE SET
          block_date = EXCLUDED.block_date,
          base_block_fee_wei = EXCLUDED.base_block_fee_wei,
          total_gas_used = EXCLUDED.total_gas_used,
          max_gas_in_block = EXCLUDED.max_gas_in_block,
          transaction_count = EXCLUDED.transaction_count,
          block_reward_wei = EXCLUDED.block_reward_wei,
          burnt_fees_wei = EXCLUDED.burnt_fees_wei,
          total_transaction_fee_wei = EXCLUDED.total_transaction_fee_wei,
          fee_price_sum_wei = EXCLUDED.fee_price_sum_wei,
          priority_fee_sum_wei = EXCLUDED.priority_fee_sum_wei,
          priority_fee_weighted_numerator_wei = EXCLUDED.priority_fee_weighted_numerator_wei,
          priority_fee_gas_weighted_numerator_wei = EXCLUDED.priority_fee_gas_weighted_numerator_wei,
          average_fee_price_wei = EXCLUDED.average_fee_price_wei,
          average_transaction_fee_wei = EXCLUDED.average_transaction_fee_wei,
          average_transaction_gas_used = EXCLUDED.average_transaction_gas_used,
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
          metrics.blockRewardWei,
          metrics.burntFeesWei,
          metrics.totalTransactionFeeWei,
          metrics.feePriceSumWei,
          metrics.priorityFeeSumWei,
          metrics.priorityFeeWeightedNumeratorWei,
          metrics.priorityFeeGasWeightedNumeratorWei,
          metrics.averageFeePriceWei,
          metrics.averageTransactionFeeWei,
          metrics.averageTransactionGasUsed,
          metrics.averagePriorityFeeWeightedWei,
          metrics.averagePriorityFeeWei,
        ],
      );
      if (transactions !== undefined) {
        await this.replaceTransactionsForBlock(client, metrics, transactions);
      }
      await this.applyProgressUpdate(client, metrics, progressUpdate);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async replaceTransactionsForBlock(
    client: pg.PoolClient,
    metrics: BlockMetrics,
    transactions: InspectedTransaction[],
  ): Promise<void> {
    await client.query(`DELETE FROM ${this.qTransactions} WHERE block_number = $1`, [
      metrics.blockNumber.toString(),
    ]);

    if (transactions.length === 0) {
      return;
    }

    const columnsPerRow = 21;
    const params: Array<string | number | null> = [];
    const values = transactions.map((transaction, rowIndex) => {
      const offset = rowIndex * columnsPerRow;
      params.push(
        metrics.blockNumber.toString(),
        metrics.blockDate,
        metrics.baseBlockFeeWei,
        transaction.position,
        transaction.hash,
        transaction.from,
        transaction.to,
        transaction.type,
        transaction.nonce,
        transaction.valueWei,
        transaction.gasLimit,
        transaction.gasUsed,
        transaction.cumulativeGasUsed,
        transaction.gasPriceWei,
        transaction.maxFeePerGasWei,
        transaction.maxPriorityFeePerGasWei,
        transaction.effectiveGasPriceWei,
        transaction.priorityFeeWei,
        transaction.transactionFeeWei,
        transaction.status,
        transaction.contractAddress,
      );
      const placeholders = Array.from(
        { length: columnsPerRow },
        (_unused, columnIndex) => `$${offset + columnIndex + 1}`,
      );
      return `(${placeholders.join(", ")})`;
    });

    await client.query(
      `INSERT INTO ${this.qTransactions} (
        block_number,
        block_date,
        base_block_fee_wei,
        position,
        hash,
        from_address,
        to_address,
        transaction_type,
        nonce,
        value_wei,
        gas_limit,
        gas_used,
        cumulative_gas_used,
        gas_price_wei,
        max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei,
        effective_gas_price_wei,
        priority_fee_wei,
        transaction_fee_wei,
        status,
        contract_address
      ) VALUES ${values.join(", ")}`,
      params,
    );
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
    const order = resolveQueryOrder(filter.order);
    const sql = `
      SELECT
        block_number,
        block_date,
        base_block_fee_wei,
        total_gas_used,
        max_gas_in_block,
        transaction_count,
        block_reward_wei,
        burnt_fees_wei,
        total_transaction_fee_wei,
        fee_price_sum_wei,
        priority_fee_sum_wei,
        priority_fee_weighted_numerator_wei,
        priority_fee_gas_weighted_numerator_wei,
        average_fee_price_wei,
        average_transaction_fee_wei,
        average_transaction_gas_used,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei
      FROM ${this.qBlocks}
      ${where}
      ORDER BY block_number ${order}
      LIMIT $${params.length}
    `;

    const result = await this.pool.query<{
      block_number: string;
      block_date: string;
      base_block_fee_wei: string;
      total_gas_used: string;
      max_gas_in_block: string;
      transaction_count: number;
      block_reward_wei: string;
      burnt_fees_wei: string;
      total_transaction_fee_wei: string;
      fee_price_sum_wei: string;
      priority_fee_sum_wei: string;
      priority_fee_weighted_numerator_wei: string;
      priority_fee_gas_weighted_numerator_wei: string;
      average_fee_price_wei: string;
      average_transaction_fee_wei: string;
      average_transaction_gas_used: string;
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
      blockRewardWei: row.block_reward_wei,
      burntFeesWei: row.burnt_fees_wei,
      totalTransactionFeeWei: row.total_transaction_fee_wei,
      feePriceSumWei: row.fee_price_sum_wei,
      priorityFeeSumWei: row.priority_fee_sum_wei,
      priorityFeeWeightedNumeratorWei: row.priority_fee_weighted_numerator_wei,
      priorityFeeGasWeightedNumeratorWei: row.priority_fee_gas_weighted_numerator_wei,
      averageFeePriceWei: row.average_fee_price_wei,
      averageTransactionFeeWei: row.average_transaction_fee_wei,
      averageTransactionGasUsed: row.average_transaction_gas_used,
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

  async queryTransactions(filter: TransactionQueryFilter = {}): Promise<StoredTransaction[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.blockNumber !== undefined) {
      params.push(filter.blockNumber.toString());
      clauses.push(`block_number = $${params.length}`);
    }

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
    params.push(resolveLimit(filter.limit, MAX_TRANSACTIONS_PER_QUERY));
    const order = resolveQueryOrder(filter.order);
    const sql = `
      SELECT
        block_number,
        block_date,
        base_block_fee_wei,
        position,
        hash,
        from_address,
        to_address,
        transaction_type,
        nonce,
        value_wei,
        gas_limit,
        gas_used,
        cumulative_gas_used,
        gas_price_wei,
        max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei,
        effective_gas_price_wei,
        priority_fee_wei,
        transaction_fee_wei,
        status,
        contract_address
      FROM ${this.qTransactions}
      ${where}
      ORDER BY block_number ${order}, position ${order}
      LIMIT $${params.length}
    `;

    const result = await this.pool.query<{
      block_number: string;
      block_date: string;
      base_block_fee_wei: string;
      position: number;
      hash: string;
      from_address: string | null;
      to_address: string | null;
      transaction_type: string | null;
      nonce: string | null;
      value_wei: string;
      gas_limit: string;
      gas_used: string;
      cumulative_gas_used: string | null;
      gas_price_wei: string | null;
      max_fee_per_gas_wei: string | null;
      max_priority_fee_per_gas_wei: string | null;
      effective_gas_price_wei: string;
      priority_fee_wei: string;
      transaction_fee_wei: string;
      status: string | null;
      contract_address: string | null;
    }>(sql, params);

    return result.rows.map(mapTransactionRow);
  }

  async getInspectedBlock(blockNumber: bigint): Promise<InspectedBlock | undefined> {
    const [block] = await this.queryBlocks({ blockGt: blockNumber - 1n, blockLt: blockNumber + 1n });
    if (!block) {
      return undefined;
    }

    const transactions = await this.queryTransactions({
      blockNumber,
      limit: MAX_TRANSACTIONS_PER_QUERY,
    });

    return {
      blockNumber: block.blockNumber,
      blockNumberDecimal: blockNumber.toString(),
      blockDate: block.blockDate,
      baseBlockFeeWei: block.baseBlockFeeWei,
      totalGasUsed: block.totalGasUsed,
      maxGasInBlock: block.maxGasInBlock,
      transactionCount: block.transactionCount,
      transactions: transactions.map(stripStoredTransactionContext),
    };
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
        min_max_gas_in_block,
        max_max_gas_in_block,
        transaction_count,
        total_block_reward_wei,
        total_burnt_fees_wei,
        average_block_reward_wei,
        average_burnt_fees_wei,
        average_fee_price_wei,
        average_transaction_gas_used,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        aggregated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, NOW())
      ON CONFLICT (range_size, range_start) DO UPDATE SET
        range_end = EXCLUDED.range_end,
        min_block_date = EXCLUDED.min_block_date,
        max_block_date = EXCLUDED.max_block_date,
        min_base_fee_wei = EXCLUDED.min_base_fee_wei,
        max_base_fee_wei = EXCLUDED.max_base_fee_wei,
        average_base_fee_wei = EXCLUDED.average_base_fee_wei,
        total_gas_used = EXCLUDED.total_gas_used,
        total_max_gas = EXCLUDED.total_max_gas,
        min_max_gas_in_block = EXCLUDED.min_max_gas_in_block,
        max_max_gas_in_block = EXCLUDED.max_max_gas_in_block,
        transaction_count = EXCLUDED.transaction_count,
        total_block_reward_wei = EXCLUDED.total_block_reward_wei,
        total_burnt_fees_wei = EXCLUDED.total_burnt_fees_wei,
        average_block_reward_wei = EXCLUDED.average_block_reward_wei,
        average_burnt_fees_wei = EXCLUDED.average_burnt_fees_wei,
        average_fee_price_wei = EXCLUDED.average_fee_price_wei,
        average_transaction_gas_used = EXCLUDED.average_transaction_gas_used,
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
        metrics.minMaxGasInBlock,
        metrics.maxMaxGasInBlock,
        metrics.transactionCount,
        metrics.totalBlockRewardWei,
        metrics.totalBurntFeesWei,
        metrics.averageBlockRewardWei,
        metrics.averageBurntFeesWei,
        metrics.averageFeePriceWei,
        metrics.averageTransactionGasUsed,
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

    const order = resolveQueryOrder(filter.order);
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
        min_max_gas_in_block,
        max_max_gas_in_block,
        transaction_count,
        total_block_reward_wei,
        total_burnt_fees_wei,
        average_block_reward_wei,
        average_burnt_fees_wei,
        average_fee_price_wei,
        average_transaction_gas_used,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei
      FROM ${this.qBlockRanges}
      WHERE ${clauses.join(" AND ")}
      ORDER BY range_start ${order}
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
      min_max_gas_in_block: string;
      max_max_gas_in_block: string;
      transaction_count: number;
      total_block_reward_wei: string;
      total_burnt_fees_wei: string;
      average_block_reward_wei: string;
      average_burnt_fees_wei: string;
      average_fee_price_wei: string;
      average_transaction_gas_used: string;
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
      minMaxGasInBlock: row.min_max_gas_in_block,
      maxMaxGasInBlock: row.max_max_gas_in_block,
      transactionCount: row.transaction_count,
      totalBlockRewardWei: row.total_block_reward_wei,
      totalBurntFeesWei: row.total_burnt_fees_wei,
      averageBlockRewardWei: row.average_block_reward_wei,
      averageBurntFeesWei: row.average_burnt_fees_wei,
      averageFeePriceWei: row.average_fee_price_wei,
      averageTransactionGasUsed: row.average_transaction_gas_used,
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
        await this.upsertStateValue(client, LAST_SUCCESSFUL_BLOCK_KEY, metrics.blockNumber.toString());
        return;
      case "backfillNextBlock":
        await this.upsertStateValue(client, BACKFILL_NEXT_BLOCK_KEY, progressUpdate.nextBlock.toString());
        return;
      case "none":
        return;
    }
  }

  private async upsertStateValue(
    client: pg.PoolClient,
    key: string,
    value: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.qScannerState} (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value],
    );
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

function resolveQueryOrder(order: QueryOrder | undefined): "ASC" | "DESC" {
  return order === "desc" ? "DESC" : "ASC";
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

function regclassName(schema: string, tableName: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(tableName)}`;
}

function parseOptionalBigInt(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

function optionalBigIntField<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: bigint } {
  return value === undefined ? {} : { [key]: BigInt(value) } as { [P in K]?: bigint };
}

function optionalStringField<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: string };
}

function mapTransactionRow(row: {
  block_number: string;
  block_date: string;
  base_block_fee_wei: string;
  position: number;
  hash: string;
  from_address: string | null;
  to_address: string | null;
  transaction_type: string | null;
  nonce: string | null;
  value_wei: string;
  gas_limit: string;
  gas_used: string;
  cumulative_gas_used: string | null;
  gas_price_wei: string | null;
  max_fee_per_gas_wei: string | null;
  max_priority_fee_per_gas_wei: string | null;
  effective_gas_price_wei: string;
  priority_fee_wei: string;
  transaction_fee_wei: string;
  status: string | null;
  contract_address: string | null;
}): StoredTransaction {
  return {
    blockNumber: Number(row.block_number),
    blockNumberDecimal: row.block_number,
    blockDate: row.block_date,
    baseBlockFeeWei: row.base_block_fee_wei,
    position: row.position,
    hash: row.hash as Hex,
    from: row.from_address as Hex | null,
    to: row.to_address as Hex | null,
    type: row.transaction_type,
    nonce: row.nonce,
    valueWei: row.value_wei,
    gasLimit: row.gas_limit,
    gasUsed: row.gas_used,
    cumulativeGasUsed: row.cumulative_gas_used,
    gasPriceWei: row.gas_price_wei,
    maxFeePerGasWei: row.max_fee_per_gas_wei,
    maxPriorityFeePerGasWei: row.max_priority_fee_per_gas_wei,
    effectiveGasPriceWei: row.effective_gas_price_wei,
    priorityFeeWei: row.priority_fee_wei,
    transactionFeeWei: row.transaction_fee_wei,
    status: row.status,
    contractAddress: row.contract_address as Hex | null,
  };
}

function stripStoredTransactionContext(row: StoredTransaction): InspectedTransaction {
  return {
    position: row.position,
    hash: row.hash,
    from: row.from,
    to: row.to,
    type: row.type,
    nonce: row.nonce,
    valueWei: row.valueWei,
    gasLimit: row.gasLimit,
    gasUsed: row.gasUsed,
    cumulativeGasUsed: row.cumulativeGasUsed,
    gasPriceWei: row.gasPriceWei,
    maxFeePerGasWei: row.maxFeePerGasWei,
    maxPriorityFeePerGasWei: row.maxPriorityFeePerGasWei,
    effectiveGasPriceWei: row.effectiveGasPriceWei,
    priorityFeeWei: row.priorityFeeWei,
    transactionFeeWei: row.transactionFeeWei,
    status: row.status,
    contractAddress: row.contractAddress,
  };
}
