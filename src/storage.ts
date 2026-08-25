import { openDb, textArrayLiteral, type Db, type DbQueryable } from "./db";
import {
  DEFAULT_RANGE_SIZE,
  assertSupportedRangeSize,
  computeBlockRange,
  rangeEndFor,
  type BlockRangeMetrics,
} from "./ranges";
import type { BlockMetrics, Hex } from "./types";
import type { InspectedBlock, InspectedTransaction } from "./blockInspector";
import type {
  ArkivOperation,
  ArkivOperationAttribute,
  ArkivOperationSummaryEntry,
  ArkivPayloadReference,
  ArkivReferenceVerification,
  TransactionArkivOperations,
} from "./arkivOperations";
import type { BaseloadConfig } from "./baseloadConfig";
import type { BatcherMetrics } from "./batcher";
import type { ScanSample } from "./syncStatus";

const LAST_SUCCESSFUL_BLOCK_KEY = "last_successful_block";
const BACKFILL_NEXT_BLOCK_KEY = "backfill_next_block";
const LATEST_OBSERVED_BLOCK_KEY = "latest_observed_block";
const SAFE_HEAD_BLOCK_KEY = "safe_head_block";
const LATEST_OBSERVED_AT_KEY = "latest_observed_at";

export const MAX_BLOCKS_PER_QUERY = 10_000;
export const MAX_RANGES_PER_QUERY = 10_000;
export const MAX_TRANSACTIONS_PER_QUERY = 1_000;
export const MAX_TRANSACTION_RECORDS_PER_CATEGORY = 100;
export const DEFAULT_TRANSACTION_RECORDS_PER_CATEGORY = 20;
export const MAX_SENDERS_PER_QUERY = 10_000;
export const MAX_ENTITY_OPERATIONS_PER_QUERY = 1_000;

export type QueryOrder = "asc" | "desc";
export type TransactionRecordCategory = "gas_used" | "transaction_fee" | "effective_fee";

export const TRANSACTION_RECORD_CATEGORIES: readonly TransactionRecordCategory[] = [
  "gas_used",
  "transaction_fee",
  "effective_fee",
];

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
  fromAddress?: string;
  nonceGt?: bigint;
  nonceLt?: bigint;
  dateGt?: string;
  dateLt?: string;
  limit?: number;
  page?: number;
  order?: QueryOrder;
}

export interface SenderStatsQueryFilter {
  limit?: number;
  order?: QueryOrder;
}

export interface TransactionRecordsQueryFilter {
  limit?: number;
}

export interface StoredBlock {
  blockNumber: number;
  blockDate: string;
  blockTimeSeconds: string;
  baseBlockFeeWei: string;
  totalGasUsed: string;
  totalInputDataSizeBytes?: string;
  totalInputDataCompressedSizeBytes?: string;
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
  averageTransactionInputDataSizeBytes?: string;
  averageTransactionInputDataCompressedSizeBytes?: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
  batcherQueueSize?: string | null;
  batcherIntensity?: string | null;
  batcherLowerThreshold?: string | null;
  batcherUpperThreshold?: string | null;
  batcherMaxBlockSize?: string | null;
  batcherMaxTxSize?: string | null;
}

export interface StoredTransaction extends InspectedTransaction {
  blockNumber: number;
  blockNumberDecimal: string;
  blockDate: string;
  baseBlockFeeWei: string;
  operations?: ArkivOperation[];
  operationsSummary?: ArkivOperationSummaryEntry[];
}

/** One stored operation joined with its transaction context, for entity history. */
export interface StoredEntityOperation extends ArkivOperation {
  blockNumber: number;
  blockNumberDecimal: string;
  blockDate: string;
  position: number;
  hash: string;
}

export interface StoredTransactionRecord extends StoredTransaction {
  category: TransactionRecordCategory;
  recordValue: string;
  rank: number;
  recordedAt: string;
}

export type StoredTransactionRecordsByCategory = Record<
  TransactionRecordCategory,
  StoredTransactionRecord[]
>;

export interface StoredSenderStats {
  address: string;
  latestNonce: string | null;
  transactionCount: string;
  totalGasUsed: string;
  totalTransactionFeeWei: string;
  totalValueWei: string;
  averageGasUsed: string;
  averageTransactionFeeWei: string;
  firstBlockNumber: number;
  firstBlockNumberDecimal: string;
  lastBlockNumber: number;
  lastBlockNumberDecimal: string;
  firstBlockDate: string;
  lastBlockDate: string;
  aggregatedAt: string;
}

export interface StoredBlockRange {
  rangeSize: number;
  rangeStart: number;
  rangeEnd: number;
  minBlockDate: string;
  maxBlockDate: string;
  averageBlockTimeSeconds: string;
  minBlockTimeSeconds: string;
  maxBlockTimeSeconds: string;
  minBaseFeeWei: string;
  maxBaseFeeWei: string;
  averageBaseFeeWei: string;
  totalGasUsed: string;
  averageTotalGasUsed: string;
  minTotalGasUsed: string;
  maxTotalGasUsed: string;
  totalInputDataSizeBytes: string;
  averageTotalInputDataSizeBytes: string;
  minTotalInputDataSizeBytes: string;
  maxTotalInputDataSizeBytes: string;
  totalInputDataCompressedSizeBytes: string;
  averageTotalInputDataCompressedSizeBytes: string;
  minTotalInputDataCompressedSizeBytes: string;
  maxTotalInputDataCompressedSizeBytes: string;
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
  averageTransactionInputDataSizeBytes: string;
  averageTransactionInputDataCompressedSizeBytes: string;
  averagePriorityFeeWeightedWei: string;
  averagePriorityFeeWei: string;
  minBatcherQueueSize?: string | null;
  maxBatcherQueueSize?: string | null;
  averageBatcherQueueSize?: string | null;
  averageBatcherIntensity?: string | null;
  averageBatcherLowerThreshold?: string | null;
  averageBatcherUpperThreshold?: string | null;
  averageBatcherMaxBlockSize?: string | null;
  averageBatcherMaxTxSize?: string | null;
}

export interface ScannerStorageOptions {
  schema?: string;
}

/** Default number of tip blocks sampled when measuring scan throughput. */
export const DEFAULT_SCAN_SAMPLE_LIMIT = 600;

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

export interface StoredBlockBounds {
  minBlock: bigint;
  minBlockDate: string;
  maxBlock: bigint;
  maxBlockDate: string;
}

export interface RangeBlockCoverage {
  rangeStart: bigint;
  rangeEnd: bigint;
  blocksPresent: number;
  blocksExpected: number;
  latestBlock?: bigint;
  latestBlockDate?: string;
  /** Lowest block number in [rangeStart, rangeEnd] that is absent from storage, if any. */
  firstMissingBlock?: bigint;
}

export interface BlockGap {
  /** First missing block in the hole (inclusive). */
  gapStart: bigint;
  /** Last missing block in the hole (inclusive). */
  gapEnd: bigint;
  /** Number of missing blocks in the hole (gapEnd - gapStart + 1). */
  missingCount: bigint;
}

export interface LatestCompleteBlockRange {
  rangeStart: bigint;
  rangeEnd: bigint;
  minBlockDate: string;
  maxBlockDate: string;
}

export interface StoredBaseloadConfigSummary {
  name: string;
  workerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredBaseloadConfig extends StoredBaseloadConfigSummary {
  config: BaseloadConfig;
}

export class ScannerStorage {
  private readonly schema: string;
  private readonly qBlocks: string;
  private readonly qScannerState: string;
  private readonly qBlockRanges: string;
  private readonly qTransactions: string;
  private readonly qTransactionOperations: string;
  private readonly qTransactionRecords: string;
  private readonly qSenderStats: string;
  private readonly qBaseloadConfigs: string;

  private constructor(
    private readonly db: Db,
    options: ScannerStorageOptions = {},
  ) {
    this.schema = options.schema ?? "public";
    this.qBlocks = `${quoteIdent(this.schema)}.blocks`;
    this.qScannerState = `${quoteIdent(this.schema)}.scanner_state`;
    this.qBlockRanges = `${quoteIdent(this.schema)}.block_ranges`;
    this.qTransactions = `${quoteIdent(this.schema)}.transactions`;
    this.qTransactionOperations = `${quoteIdent(this.schema)}.transaction_operations`;
    this.qTransactionRecords = `${quoteIdent(this.schema)}.transaction_records`;
    this.qSenderStats = `${quoteIdent(this.schema)}.sender_stats`;
    this.qBaseloadConfigs = `${quoteIdent(this.schema)}.baseload_configs`;
  }

  static async open(
    connectionString: string,
    options: ScannerStorageOptions = {},
  ): Promise<ScannerStorage> {
    const db = openDb(connectionString);
    const storage = new ScannerStorage(db, options);
    await storage.initSchema();
    return storage;
  }

  static async fromDb(
    db: Db,
    options: ScannerStorageOptions = {},
  ): Promise<ScannerStorage> {
    const storage = new ScannerStorage(db, options);
    await storage.initSchema();
    return storage;
  }

  private async initSchema(): Promise<void> {
    if (this.schema !== "public") {
      await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schema)}`);
    }
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qBlocks} (
        block_number BIGINT PRIMARY KEY,
        block_date TEXT NOT NULL,
        block_time_seconds TEXT NOT NULL DEFAULT '2',
        base_block_fee_wei TEXT NOT NULL,
        total_gas_used TEXT NOT NULL,
        total_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
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
        average_transaction_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        average_transaction_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        batcher_queue_size TEXT,
        batcher_intensity TEXT,
        batcher_lower_threshold TEXT,
        batcher_upper_threshold TEXT,
        batcher_max_block_size TEXT,
        batcher_max_tx_size TEXT,
        scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS block_time_seconds TEXT NOT NULL DEFAULT '2'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS total_input_data_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS block_reward_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS burnt_fees_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS total_transaction_fee_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS fee_price_sum_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_sum_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_weighted_numerator_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS priority_fee_gas_weighted_numerator_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS average_fee_price_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS average_transaction_gas_used TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS average_transaction_input_data_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlocks}
       ADD COLUMN IF NOT EXISTS average_transaction_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.addNullableTextColumn(this.qBlocks, "batcher_queue_size");
    await this.addNullableTextColumn(this.qBlocks, "batcher_intensity");
    await this.addNullableTextColumn(this.qBlocks, "batcher_lower_threshold");
    await this.addNullableTextColumn(this.qBlocks, "batcher_upper_threshold");
    await this.addNullableTextColumn(this.qBlocks, "batcher_max_block_size");
    await this.addNullableTextColumn(this.qBlocks, "batcher_max_tx_size");
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qScannerState} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qBaseloadConfigs} (
        name TEXT PRIMARY KEY,
        config_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.db.query(`
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
        input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
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
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transactions_block_date_idx")}
       ON ${this.qTransactions} (block_date)`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transactions_hash_idx")}
       ON ${this.qTransactions} (hash)`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transactions_from_address_nonce_idx")}
       ON ${this.qTransactions} (LOWER(from_address), (nonce::numeric), block_number, position)`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transactions_from_address_block_idx")}
       ON ${this.qTransactions} (LOWER(from_address), block_number, position)`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactions}
       ADD COLUMN IF NOT EXISTS input_data_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactions}
       ADD COLUMN IF NOT EXISTS input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    // Decoded Arkiv operation metadata per transaction. Payloads/calldata are
    // never stored — only payload_size_bytes. Under reference mode we also keep
    // the provider's payload-reference receipt metadata and the offline
    // verification verdict (never the entity bytes). expires_at_blocks is BIGINT
    // because uint32 max exceeds the int4 range.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qTransactionOperations} (
        block_number BIGINT NOT NULL,
        position INTEGER NOT NULL,
        op_index INTEGER NOT NULL,
        hash TEXT NOT NULL,
        block_date TEXT NOT NULL,
        operation_type INTEGER NOT NULL,
        operation TEXT NOT NULL,
        entity_key TEXT,
        content_type TEXT,
        payload_size_bytes INTEGER NOT NULL DEFAULT 0,
        attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
        expires_at_blocks BIGINT,
        new_owner TEXT,
        is_reference BOOLEAN NOT NULL DEFAULT FALSE,
        payload_reference JSONB,
        reference_verification JSONB,
        reference_error TEXT,
        scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (block_number, position, op_index)
      )
    `);
    // Backfill columns on tables created before reference mode. Defaults keep
    // existing rows valid; the rich reference objects stay null until re-scanned.
    await this.db.query(
      `ALTER TABLE ${this.qTransactionOperations}
       ADD COLUMN IF NOT EXISTS is_reference BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactionOperations}
       ADD COLUMN IF NOT EXISTS payload_reference JSONB`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactionOperations}
       ADD COLUMN IF NOT EXISTS reference_verification JSONB`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactionOperations}
       ADD COLUMN IF NOT EXISTS reference_error TEXT`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transaction_operations_hash_idx")}
       ON ${this.qTransactionOperations} (hash)`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transaction_operations_entity_key_idx")}
       ON ${this.qTransactionOperations} (entity_key)`,
    );
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qTransactionRecords} (
        category TEXT NOT NULL,
        record_value TEXT NOT NULL,
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
        input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
        cumulative_gas_used TEXT,
        gas_price_wei TEXT,
        max_fee_per_gas_wei TEXT,
        max_priority_fee_per_gas_wei TEXT,
        effective_gas_price_wei TEXT NOT NULL,
        priority_fee_wei TEXT NOT NULL,
        transaction_fee_wei TEXT NOT NULL,
        status TEXT,
        contract_address TEXT,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (category, block_number, position)
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transaction_records_category_rank_idx")}
       ON ${this.qTransactionRecords} (category, (record_value::numeric) DESC, block_number DESC, position DESC)`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("transaction_records_hash_idx")}
       ON ${this.qTransactionRecords} (hash)`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactionRecords}
       ADD COLUMN IF NOT EXISTS input_data_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qTransactionRecords}
       ADD COLUMN IF NOT EXISTS input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qSenderStats} (
        address TEXT PRIMARY KEY,
        latest_nonce TEXT,
        transaction_count BIGINT NOT NULL,
        total_gas_used TEXT NOT NULL,
        total_transaction_fee_wei TEXT NOT NULL,
        total_value_wei TEXT NOT NULL,
        average_gas_used TEXT NOT NULL,
        average_transaction_fee_wei TEXT NOT NULL,
        first_block_number BIGINT NOT NULL,
        last_block_number BIGINT NOT NULL,
        first_block_date TEXT NOT NULL,
        last_block_date TEXT NOT NULL,
        aggregated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent("sender_stats_activity_idx")}
       ON ${this.qSenderStats} (transaction_count DESC, last_block_number DESC, address ASC)`,
    );
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.qBlockRanges} (
        range_size BIGINT NOT NULL,
        range_start BIGINT NOT NULL,
        range_end BIGINT NOT NULL,
        min_block_date TEXT NOT NULL,
        max_block_date TEXT NOT NULL,
        average_block_time_seconds TEXT NOT NULL DEFAULT '2',
        min_block_time_seconds TEXT NOT NULL DEFAULT '2',
        max_block_time_seconds TEXT NOT NULL DEFAULT '2',
        min_base_fee_wei TEXT NOT NULL,
        max_base_fee_wei TEXT NOT NULL,
        average_base_fee_wei TEXT NOT NULL,
        total_gas_used TEXT NOT NULL,
        average_total_gas_used TEXT NOT NULL DEFAULT '0',
        min_total_gas_used TEXT NOT NULL DEFAULT '0',
        max_total_gas_used TEXT NOT NULL DEFAULT '0',
        total_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        average_total_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        min_total_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        max_total_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
        average_total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
        min_total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
        max_total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
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
        average_transaction_input_data_size_bytes TEXT NOT NULL DEFAULT '0',
        average_transaction_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0',
        average_priority_fee_weighted_wei TEXT NOT NULL,
        average_priority_fee_wei TEXT NOT NULL,
        min_batcher_queue_size TEXT,
        max_batcher_queue_size TEXT,
        average_batcher_queue_size TEXT,
        average_batcher_intensity TEXT,
        average_batcher_lower_threshold TEXT,
        average_batcher_upper_threshold TEXT,
        average_batcher_max_block_size TEXT,
        average_batcher_max_tx_size TEXT,
        is_complete BOOLEAN NOT NULL DEFAULT TRUE,
        aggregated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (range_size, range_start)
      )
    `);
    const blockRangeMetricColumnsWereMissing = await this.hasMissingColumns("block_ranges", [
      "average_block_time_seconds",
      "min_block_time_seconds",
      "max_block_time_seconds",
      "average_total_gas_used",
      "min_total_gas_used",
      "max_total_gas_used",
      "average_total_input_data_size_bytes",
      "min_total_input_data_size_bytes",
      "max_total_input_data_size_bytes",
      "average_total_input_data_compressed_size_bytes",
      "min_total_input_data_compressed_size_bytes",
      "max_total_input_data_compressed_size_bytes",
    ]);
    await this.addRequiredTextColumn(this.qBlockRanges, "average_total_gas_used");
    await this.addRequiredTextColumn(this.qBlockRanges, "average_block_time_seconds", "2");
    await this.addRequiredTextColumn(this.qBlockRanges, "min_block_time_seconds", "2");
    await this.addRequiredTextColumn(this.qBlockRanges, "max_block_time_seconds", "2");
    await this.addRequiredTextColumn(this.qBlockRanges, "min_total_gas_used");
    await this.addRequiredTextColumn(this.qBlockRanges, "max_total_gas_used");
    await this.addRequiredTextColumn(this.qBlockRanges, "average_total_input_data_size_bytes");
    await this.addRequiredTextColumn(this.qBlockRanges, "min_total_input_data_size_bytes");
    await this.addRequiredTextColumn(this.qBlockRanges, "max_total_input_data_size_bytes");
    await this.addRequiredTextColumn(this.qBlockRanges, "average_total_input_data_compressed_size_bytes");
    await this.addRequiredTextColumn(this.qBlockRanges, "min_total_input_data_compressed_size_bytes");
    await this.addRequiredTextColumn(this.qBlockRanges, "max_total_input_data_compressed_size_bytes");
    if (blockRangeMetricColumnsWereMissing) {
      await this.db.query(`DELETE FROM ${this.qBlockRanges}`);
    }
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS total_input_data_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS total_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS total_block_reward_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS total_burnt_fees_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_block_reward_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_burnt_fees_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_fee_price_wei TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_transaction_gas_used TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_transaction_input_data_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS average_transaction_input_data_compressed_size_bytes TEXT NOT NULL DEFAULT '0'`,
    );
    await this.addNullableTextColumn(this.qBlockRanges, "min_batcher_queue_size");
    await this.addNullableTextColumn(this.qBlockRanges, "max_batcher_queue_size");
    await this.addNullableTextColumn(this.qBlockRanges, "average_batcher_queue_size");
    await this.addNullableTextColumn(this.qBlockRanges, "average_batcher_intensity");
    await this.addNullableTextColumn(this.qBlockRanges, "average_batcher_lower_threshold");
    await this.addNullableTextColumn(this.qBlockRanges, "average_batcher_upper_threshold");
    await this.addNullableTextColumn(this.qBlockRanges, "average_batcher_max_block_size");
    await this.addNullableTextColumn(this.qBlockRanges, "average_batcher_max_tx_size");
    await this.db.query(
      `ALTER TABLE ${this.qBlockRanges}
       ADD COLUMN IF NOT EXISTS is_complete BOOLEAN NOT NULL DEFAULT TRUE`,
    );
    // Repair jsonb values that were double-encoded into string scalars by the
    // initial Bun.sql migration (it bound pre-stringified JSON params, which
    // Bun encodes as JSON strings): unwrap the inner document. Idempotent —
    // matches nothing once repaired.
    await this.db.query(
      `UPDATE ${this.qBaseloadConfigs}
       SET config_json = (config_json #>> '{}')::jsonb
       WHERE jsonb_typeof(config_json) = 'string'`,
    );
    await this.db.query(
      `UPDATE ${this.qTransactionOperations}
       SET attributes = (attributes #>> '{}')::jsonb
       WHERE jsonb_typeof(attributes) = 'string'`,
    );
  }

  private async addNullableTextColumn(table: string, column: string): Promise<void> {
    await this.db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdent(column)} TEXT`);
  }

  private async addRequiredTextColumn(table: string, column: string, defaultValue = "0"): Promise<void> {
    await this.db.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdent(column)} TEXT NOT NULL DEFAULT ${quoteStringLiteral(defaultValue)}`,
    );
  }

  private async hasMissingColumns(tableName: string, columns: readonly string[]): Promise<boolean> {
    const result = await this.db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = $2
         AND column_name = ANY($3::text[])`,
      [this.schema, tableName, textArrayLiteral(columns)],
    );
    const present = new Set(result.rows.map((row) => row.column_name));
    return columns.some((column) => !present.has(column));
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
    await this.db.transaction(async (tx) => {
      await this.upsertStateValue(tx, LATEST_OBSERVED_BLOCK_KEY, latestObservedBlock.toString());
      await this.upsertStateValue(tx, SAFE_HEAD_BLOCK_KEY, safeHeadBlock.toString());
      await this.upsertStateValue(tx, LATEST_OBSERVED_AT_KEY, observedAtIso);
    });
  }

  async getScannerProgress(): Promise<ScannerProgress> {
    const stateResult = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.qScannerState}
       WHERE key = ANY($1::text[])`,
      [
        // Bun.sql does not serialize JS arrays to Postgres array literals.
        textArrayLiteral([
          LAST_SUCCESSFUL_BLOCK_KEY,
          BACKFILL_NEXT_BLOCK_KEY,
          LATEST_OBSERVED_BLOCK_KEY,
          SAFE_HEAD_BLOCK_KEY,
          LATEST_OBSERVED_AT_KEY,
        ]),
      ],
    );
    const state = new Map<string, string>(stateResult.rows.map((row) => [row.key, row.value]));

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
        name: "transaction_operations",
        qualifiedName: this.qTransactionOperations,
        regclassName: regclassName(this.schema, "transaction_operations"),
      },
      {
        name: "transaction_records",
        qualifiedName: this.qTransactionRecords,
        regclassName: regclassName(this.schema, "transaction_records"),
      },
      {
        name: "block_ranges",
        qualifiedName: this.qBlockRanges,
        regclassName: regclassName(this.schema, "block_ranges"),
      },
      {
        name: "sender_stats",
        qualifiedName: this.qSenderStats,
        regclassName: regclassName(this.schema, "sender_stats"),
      },
      {
        name: "scanner_state",
        qualifiedName: this.qScannerState,
        regclassName: regclassName(this.schema, "scanner_state"),
      },
      {
        name: "baseload_configs",
        qualifiedName: this.qBaseloadConfigs,
        regclassName: regclassName(this.schema, "baseload_configs"),
      },
    ];

    const [databaseSizeResult, tableStats] = await Promise.all([
      this.db.query<{ total_size_bytes: string }>(
        `SELECT pg_database_size(current_database())::text AS total_size_bytes`,
      ),
      Promise.all(
        appTables.map(async (table) => {
          const result = await this.db.query<{
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
    const result = await this.db.query<{ value: string }>(
      `SELECT value FROM ${this.qScannerState} WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? BigInt(row.value) : undefined;
  }

  /**
   * Recent stored blocks at the scan tip, ascending by block number, used to
   * measure how fast the scanner advances and how fast the chain produces
   * blocks. Ordered by the primary key, so it stays cheap on a large table.
   */
  async getForwardScanSamples(limit = DEFAULT_SCAN_SAMPLE_LIMIT): Promise<ScanSample[]> {
    const result = await this.db.query<{
      block_number: string;
      block_date: string;
      scanned_at_utc: string;
    }>(
      `SELECT
         block_number::text AS block_number,
         block_date,
         to_char(scanned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scanned_at_utc
       FROM ${this.qBlocks}
       ORDER BY block_number DESC
       LIMIT $1`,
      [Math.max(2, Math.trunc(limit))],
    );
    return result.rows
      .map((row) => ({
        blockNumber: BigInt(row.block_number),
        blockDate: row.block_date,
        scannedAtUtc: row.scanned_at_utc,
      }))
      .reverse();
  }

  private async getStoredBlockTiming(
    blockNumber: bigint,
  ): Promise<{ blockDate: string; scannedAt: string } | undefined> {
    const result = await this.db.query<{ block_date: string; scanned_at_utc: string }>(
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
    recordCandidates: InspectedTransaction[] = transactions ?? [],
    operations?: TransactionArkivOperations[],
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO ${this.qBlocks} AS existing (
          block_number,
          block_date,
          block_time_seconds,
          base_block_fee_wei,
          total_gas_used,
          total_input_data_size_bytes,
          total_input_data_compressed_size_bytes,
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
          average_transaction_input_data_size_bytes,
          average_transaction_input_data_compressed_size_bytes,
          average_priority_fee_weighted_wei,
          average_priority_fee_wei,
          batcher_queue_size,
          batcher_intensity,
          batcher_lower_threshold,
          batcher_upper_threshold,
          batcher_max_block_size,
          batcher_max_tx_size,
          scanned_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW())
        ON CONFLICT (block_number) DO UPDATE SET
          block_date = EXCLUDED.block_date,
          block_time_seconds = EXCLUDED.block_time_seconds,
          base_block_fee_wei = EXCLUDED.base_block_fee_wei,
          total_gas_used = EXCLUDED.total_gas_used,
          total_input_data_size_bytes = EXCLUDED.total_input_data_size_bytes,
          total_input_data_compressed_size_bytes = EXCLUDED.total_input_data_compressed_size_bytes,
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
          average_transaction_input_data_size_bytes = EXCLUDED.average_transaction_input_data_size_bytes,
          average_transaction_input_data_compressed_size_bytes = EXCLUDED.average_transaction_input_data_compressed_size_bytes,
          average_priority_fee_weighted_wei = EXCLUDED.average_priority_fee_weighted_wei,
          average_priority_fee_wei = EXCLUDED.average_priority_fee_wei,
          batcher_queue_size = COALESCE(EXCLUDED.batcher_queue_size, existing.batcher_queue_size),
          batcher_intensity = COALESCE(EXCLUDED.batcher_intensity, existing.batcher_intensity),
          batcher_lower_threshold = COALESCE(EXCLUDED.batcher_lower_threshold, existing.batcher_lower_threshold),
          batcher_upper_threshold = COALESCE(EXCLUDED.batcher_upper_threshold, existing.batcher_upper_threshold),
          batcher_max_block_size = COALESCE(EXCLUDED.batcher_max_block_size, existing.batcher_max_block_size),
          batcher_max_tx_size = COALESCE(EXCLUDED.batcher_max_tx_size, existing.batcher_max_tx_size),
          scanned_at = NOW()`,
        [
          metrics.blockNumber.toString(),
          metrics.blockDate,
          metrics.blockTimeSeconds,
          metrics.baseBlockFeeWei,
          metrics.totalGasUsed,
          metrics.totalInputDataSizeBytes,
          metrics.totalInputDataCompressedSizeBytes,
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
          metrics.averageTransactionInputDataSizeBytes,
          metrics.averageTransactionInputDataCompressedSizeBytes,
          metrics.averagePriorityFeeWeightedWei,
          metrics.averagePriorityFeeWei,
          metrics.batcherQueueSize ?? null,
          metrics.batcherIntensity ?? null,
          metrics.batcherLowerThreshold ?? null,
          metrics.batcherUpperThreshold ?? null,
          metrics.batcherMaxBlockSize ?? null,
          metrics.batcherMaxTxSize ?? null,
        ],
      );
      if (transactions !== undefined) {
        await this.replaceTransactionsForBlock(client, metrics, transactions);
        await this.replaceOperationsForBlock(client, metrics, operations);
      }
      await this.deleteTransactionRecordsForBlock(client, metrics.blockNumber);
      await this.upsertTransactionRecords(client, metrics, recordCandidates);
      await this.applyProgressUpdate(client, metrics, progressUpdate);
    });
  }

  private async deleteTransactionRecordsForBlock(
    client: DbQueryable,
    blockNumber: bigint,
  ): Promise<void> {
    await client.query(`DELETE FROM ${this.qTransactionRecords} WHERE block_number = $1`, [
      blockNumber.toString(),
    ]);
  }

  private async upsertTransactionRecords(
    client: DbQueryable,
    metrics: BlockMetrics,
    transactions: InspectedTransaction[],
  ): Promise<void> {
    if (transactions.length === 0) {
      return;
    }

    for (const category of TRANSACTION_RECORD_CATEGORIES) {
      const rows = transactions
        .map((transaction) => ({
          category,
          recordValue: recordValueForCategory(category, transaction),
          transaction,
        }))
        .sort(compareTransactionRecordCandidates)
        .slice(0, MAX_TRANSACTION_RECORDS_PER_CATEGORY);
      const currentMinimum = await this.getCurrentRecordMinimum(client, category);
      const candidates = currentMinimum === undefined
        ? rows
        : rows.filter((row) => BigInt(row.recordValue) >= currentMinimum);

      if (candidates.length === 0) {
        continue;
      }

      await this.insertTransactionRecordRows(client, metrics, candidates);
      await this.pruneTransactionRecords(client, category);
    }
  }

  private async getCurrentRecordMinimum(
    client: DbQueryable,
    category: TransactionRecordCategory,
  ): Promise<bigint | undefined> {
    const result = await client.query<{ record_value: string }>(
      `SELECT record_value
       FROM ${this.qTransactionRecords}
       WHERE category = $1
       ORDER BY record_value::numeric DESC, block_number DESC, position DESC
       OFFSET $2
       LIMIT 1`,
      [category, MAX_TRANSACTION_RECORDS_PER_CATEGORY - 1],
    );
    const row = result.rows[0];
    return row ? BigInt(row.record_value) : undefined;
  }

  private async insertTransactionRecordRows(
    client: DbQueryable,
    metrics: BlockMetrics,
    rows: Array<{
      category: TransactionRecordCategory;
      recordValue: string;
      transaction: InspectedTransaction;
    }>,
  ): Promise<void> {
    const columnsPerRow = 25;
    const params: Array<string | number | null> = [];
    const values = rows.map((row, rowIndex) => {
      const offset = rowIndex * columnsPerRow;
      const transaction = row.transaction;
      params.push(
        row.category,
        row.recordValue,
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
        transaction.inputDataSizeBytes,
        transaction.inputDataCompressedSizeBytes,
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
      `INSERT INTO ${this.qTransactionRecords} (
        category,
        record_value,
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
        input_data_size_bytes,
        input_data_compressed_size_bytes,
        cumulative_gas_used,
        gas_price_wei,
        max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei,
        effective_gas_price_wei,
        priority_fee_wei,
        transaction_fee_wei,
        status,
        contract_address
      ) VALUES ${values.join(", ")}
      ON CONFLICT (category, block_number, position) DO UPDATE SET
        record_value = EXCLUDED.record_value,
        block_date = EXCLUDED.block_date,
        base_block_fee_wei = EXCLUDED.base_block_fee_wei,
        hash = EXCLUDED.hash,
        from_address = EXCLUDED.from_address,
        to_address = EXCLUDED.to_address,
        transaction_type = EXCLUDED.transaction_type,
        nonce = EXCLUDED.nonce,
        value_wei = EXCLUDED.value_wei,
        gas_limit = EXCLUDED.gas_limit,
        gas_used = EXCLUDED.gas_used,
        input_data_size_bytes = EXCLUDED.input_data_size_bytes,
        input_data_compressed_size_bytes = EXCLUDED.input_data_compressed_size_bytes,
        cumulative_gas_used = EXCLUDED.cumulative_gas_used,
        gas_price_wei = EXCLUDED.gas_price_wei,
        max_fee_per_gas_wei = EXCLUDED.max_fee_per_gas_wei,
        max_priority_fee_per_gas_wei = EXCLUDED.max_priority_fee_per_gas_wei,
        effective_gas_price_wei = EXCLUDED.effective_gas_price_wei,
        priority_fee_wei = EXCLUDED.priority_fee_wei,
        transaction_fee_wei = EXCLUDED.transaction_fee_wei,
        status = EXCLUDED.status,
        contract_address = EXCLUDED.contract_address,
        recorded_at = NOW()`,
      params,
    );
  }

  private async pruneTransactionRecords(
    client: DbQueryable,
    category: TransactionRecordCategory,
  ): Promise<void> {
    await client.query(
      `DELETE FROM ${this.qTransactionRecords}
       WHERE category = $1
         AND (category, block_number, position) NOT IN (
           SELECT category, block_number, position
           FROM ${this.qTransactionRecords}
           WHERE category = $1
           ORDER BY record_value::numeric DESC, block_number DESC, position DESC
           LIMIT $2
         )`,
      [category, MAX_TRANSACTION_RECORDS_PER_CATEGORY],
    );
  }

  private async replaceTransactionsForBlock(
    client: DbQueryable,
    metrics: BlockMetrics,
    transactions: InspectedTransaction[],
  ): Promise<void> {
    await client.query(`DELETE FROM ${this.qTransactions} WHERE block_number = $1`, [
      metrics.blockNumber.toString(),
    ]);

    if (transactions.length === 0) {
      return;
    }

    const columnsPerRow = 23;
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
        transaction.inputDataSizeBytes,
        transaction.inputDataCompressedSizeBytes,
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
        input_data_size_bytes,
        input_data_compressed_size_bytes,
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

  /**
   * Replace decoded Arkiv operation rows for one block. Always deletes first so
   * re-scans never leave stale rows; only operation metadata is written — no
   * payload bytes or calldata.
   */
  private async replaceOperationsForBlock(
    client: DbQueryable,
    metrics: BlockMetrics,
    transactionOperations: TransactionArkivOperations[] | undefined,
  ): Promise<void> {
    await client.query(`DELETE FROM ${this.qTransactionOperations} WHERE block_number = $1`, [
      metrics.blockNumber.toString(),
    ]);

    const rows = (transactionOperations ?? []).flatMap((transaction) =>
      transaction.operations.map((operation) => ({ transaction, operation })),
    );
    if (rows.length === 0) {
      return;
    }

    // Postgres caps one statement at 65,535 bind parameters and a single
    // transaction can pack thousands of cheap operations, so insert in bounded
    // chunks. Still atomic: saveBlockMetrics wraps this in BEGIN/COMMIT.
    const columnsPerRow = 17;
    const maxRowsPerInsert = 2_000;
    for (let start = 0; start < rows.length; start += maxRowsPerInsert) {
      const chunk = rows.slice(start, start + maxRowsPerInsert);
      const params: Array<
        | string
        | number
        | boolean
        | null
        | ArkivOperationAttribute[]
        | ArkivPayloadReference
        | ArkivReferenceVerification
      > = [];
      const values = chunk.map(({ transaction, operation }, rowIndex) => {
        const offset = rowIndex * columnsPerRow;
        params.push(
          metrics.blockNumber.toString(),
          transaction.position,
          operation.opIndex,
          transaction.hash,
          metrics.blockDate,
          operation.operationType,
          operation.operation,
          operation.entityKey,
          operation.contentType,
          operation.payloadSizeBytes,
          // Bind the array/object itself: Bun.sql serializes JS objects/arrays
          // to jsonb documents but double-encodes pre-stringified JSON strings
          // into jsonb string scalars.
          operation.attributes,
          operation.expiresAtBlocks.toString(),
          operation.newOwner,
          operation.isReference,
          // Reference receipt metadata + verdict (never entity bytes); jsonb.
          operation.payloadReference,
          operation.referenceVerification,
          operation.referenceError,
        );
        const placeholders = Array.from(
          { length: columnsPerRow },
          (_unused, columnIndex) => `$${offset + columnIndex + 1}`,
        );
        placeholders[10] = `${placeholders[10]}::jsonb`; // attributes
        placeholders[14] = `${placeholders[14]}::jsonb`; // payload_reference
        placeholders[15] = `${placeholders[15]}::jsonb`; // reference_verification
        return `(${placeholders.join(", ")})`;
      });

      await client.query(
        `INSERT INTO ${this.qTransactionOperations} (
          block_number,
          position,
          op_index,
          hash,
          block_date,
          operation_type,
          operation,
          entity_key,
          content_type,
          payload_size_bytes,
          attributes,
          expires_at_blocks,
          new_owner,
          is_reference,
          payload_reference,
          reference_verification,
          reference_error
        ) VALUES ${values.join(", ")}`,
        params,
      );
    }
  }

  async getOperationsByHash(hash: string): Promise<ArkivOperation[]> {
    const result = await this.db.query<TransactionOperationRow>(
      `SELECT
        op_index,
        operation_type,
        operation,
        entity_key,
        content_type,
        payload_size_bytes,
        attributes,
        expires_at_blocks,
        new_owner,
        is_reference,
        payload_reference,
        reference_verification,
        reference_error
      FROM ${this.qTransactionOperations}
      WHERE hash = $1
      ORDER BY block_number, position, op_index`,
      [hash.toLowerCase()],
    );
    return result.rows.map(mapTransactionOperationRow);
  }

  /**
   * Chronological history of every stored operation on one entity key (create,
   * update, extend, transfer, delete, expire). Served by the entity_key index
   * and capped at {@link MAX_ENTITY_OPERATIONS_PER_QUERY} rows in chain order,
   * each joined with its transaction context (block, position, hash, date).
   */
  async getOperationsByEntityKey(entityKey: string): Promise<StoredEntityOperation[]> {
    const result = await this.db.query<EntityOperationRow>(
      `SELECT
        block_number,
        position,
        op_index,
        hash,
        block_date,
        operation_type,
        operation,
        entity_key,
        content_type,
        payload_size_bytes,
        attributes,
        expires_at_blocks,
        new_owner,
        is_reference,
        payload_reference,
        reference_verification,
        reference_error
      FROM ${this.qTransactionOperations}
      WHERE entity_key = $1
      ORDER BY block_number ASC, position ASC, op_index ASC
      LIMIT $2`,
      [entityKey.toLowerCase(), MAX_ENTITY_OPERATIONS_PER_QUERY],
    );
    return result.rows.map((row) => ({
      ...mapTransactionOperationRow(row),
      blockNumber: Number(row.block_number),
      blockNumberDecimal: row.block_number,
      blockDate: row.block_date,
      position: row.position,
      hash: row.hash,
    }));
  }

  /**
   * Aggregate stored operation counts for the given `(blockNumber, position)`
   * keys. The result map is keyed by `"${blockNumber}:${position}"` and only
   * contains entries for transactions with at least one stored operation;
   * entries are ordered by operation type ascending.
   */
  async getOperationsSummaryForTransactions(
    keys: Array<{ blockNumber: string; position: number }>,
  ): Promise<Map<string, ArkivOperationSummaryEntry[]>> {
    const summaries = new Map<string, ArkivOperationSummaryEntry[]>();
    if (keys.length === 0) {
      return summaries;
    }

    const params: Array<string | number> = [];
    const pairs = keys.map((key) => {
      params.push(key.blockNumber);
      const blockParam = params.length;
      params.push(key.position);
      return `($${blockParam}::bigint, $${params.length}::integer)`;
    });

    const result = await this.db.query<{
      block_number: string;
      position: number;
      operation: string;
      operation_type: number;
      count: number;
    }>(
      `SELECT block_number, position, operation, operation_type, COUNT(*)::int AS count
       FROM ${this.qTransactionOperations}
       WHERE (block_number, position) IN (${pairs.join(", ")})
       GROUP BY block_number, position, operation, operation_type
       ORDER BY operation_type ASC`,
      params,
    );

    for (const row of result.rows) {
      const key = `${row.block_number}:${row.position}`;
      const entries = summaries.get(key) ?? [];
      entries.push({
        operation: row.operation,
        operationType: row.operation_type,
        count: row.count,
      });
      summaries.set(key, entries);
    }
    return summaries;
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
        block_time_seconds,
        base_block_fee_wei,
        total_gas_used,
        total_input_data_size_bytes,
        total_input_data_compressed_size_bytes,
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
        average_transaction_input_data_size_bytes,
        average_transaction_input_data_compressed_size_bytes,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        batcher_queue_size,
        batcher_intensity,
        batcher_lower_threshold,
        batcher_upper_threshold,
        batcher_max_block_size,
        batcher_max_tx_size
      FROM ${this.qBlocks}
      ${where}
      ORDER BY block_number ${order}
      LIMIT $${params.length}
    `;

    const result = await this.db.query<{
      block_number: string;
      block_date: string;
      block_time_seconds: string;
      base_block_fee_wei: string;
      total_gas_used: string;
      total_input_data_size_bytes: string;
      total_input_data_compressed_size_bytes: string;
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
      average_transaction_input_data_size_bytes: string;
      average_transaction_input_data_compressed_size_bytes: string;
      average_priority_fee_weighted_wei: string;
      average_priority_fee_wei: string;
      batcher_queue_size: string | null;
      batcher_intensity: string | null;
      batcher_lower_threshold: string | null;
      batcher_upper_threshold: string | null;
      batcher_max_block_size: string | null;
      batcher_max_tx_size: string | null;
    }>(sql, params);

    return result.rows.map((row) => ({
      blockNumber: Number(row.block_number),
      blockDate: row.block_date,
      blockTimeSeconds: row.block_time_seconds,
      baseBlockFeeWei: row.base_block_fee_wei,
      totalGasUsed: row.total_gas_used,
      totalInputDataSizeBytes: row.total_input_data_size_bytes,
      totalInputDataCompressedSizeBytes: row.total_input_data_compressed_size_bytes,
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
      averageTransactionInputDataSizeBytes: row.average_transaction_input_data_size_bytes,
      averageTransactionInputDataCompressedSizeBytes: row.average_transaction_input_data_compressed_size_bytes,
      averagePriorityFeeWeightedWei: row.average_priority_fee_weighted_wei,
      averagePriorityFeeWei: row.average_priority_fee_wei,
      batcherQueueSize: row.batcher_queue_size,
      batcherIntensity: row.batcher_intensity,
      batcherLowerThreshold: row.batcher_lower_threshold,
      batcherUpperThreshold: row.batcher_upper_threshold,
      batcherMaxBlockSize: row.batcher_max_block_size,
      batcherMaxTxSize: row.batcher_max_tx_size,
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

  async queryRecentBlocksMissingBatcherMetrics(now: Date = new Date(), limit = 100): Promise<StoredBlock[]> {
    const newestEligible = new Date(now.getTime() - 2_000).toISOString();
    const oldestEligible = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
    const resolvedLimit = resolveLimit(limit, MAX_BLOCKS_PER_QUERY);
    const result = await this.db.query<{ block_number: string }>(
      `SELECT block_number
       FROM ${this.qBlocks}
       WHERE block_date > $1
         AND block_date < $2
         AND batcher_queue_size IS NULL
       ORDER BY block_number DESC
       LIMIT $3`,
      [oldestEligible, newestEligible, resolvedLimit],
    );

    if (result.rows.length === 0) {
      return [];
    }

    const blockNumbers = result.rows.map((row) => BigInt(row.block_number));
    const blocks = await Promise.all(
      blockNumbers.map((blockNumber) =>
        this.queryBlocks({
          blockGt: blockNumber - 1n,
          blockLt: blockNumber + 1n,
          limit: 1,
        }),
      ),
    );
    return blocks.flatMap((rows) => rows);
  }

  async saveBatcherMetricsForBlock(blockNumber: bigint, metrics: BatcherMetrics): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ${this.qBlocks}
       SET
         batcher_queue_size = COALESCE($2, batcher_queue_size),
         batcher_intensity = COALESCE($3, batcher_intensity),
         batcher_lower_threshold = COALESCE($4, batcher_lower_threshold),
         batcher_upper_threshold = COALESCE($5, batcher_upper_threshold),
         batcher_max_block_size = COALESCE($6, batcher_max_block_size),
         batcher_max_tx_size = COALESCE($7, batcher_max_tx_size)
       WHERE block_number = $1`,
      [
        blockNumber.toString(),
        metrics.batcherQueueSize ?? null,
        metrics.batcherIntensity ?? null,
        metrics.batcherLowerThreshold ?? null,
        metrics.batcherUpperThreshold ?? null,
        metrics.batcherMaxBlockSize ?? null,
        metrics.batcherMaxTxSize ?? null,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async queryTransactions(filter: TransactionQueryFilter = {}): Promise<StoredTransaction[]> {
    const { where, params } = buildTransactionWhereClause(filter);
    const limit = resolveLimit(filter.limit, MAX_TRANSACTIONS_PER_QUERY);
    const offset = resolvePageOffset(filter.page, limit);
    params.push(limit);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;
    const order = resolveQueryOrder(filter.order);
    const primaryOrder = filter.fromAddress === undefined ? "block_number" : "nonce::numeric";
    const secondaryOrder =
      filter.fromAddress === undefined
        ? `position ${order}`
        : `block_number ${order}, position ${order}`;
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
        input_data_size_bytes,
        input_data_compressed_size_bytes,
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
      ORDER BY ${primaryOrder} ${order}, ${secondaryOrder}
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    const result = await this.db.query<{
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
      input_data_size_bytes: string;
      input_data_compressed_size_bytes: string;
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

  async countTransactions(filter: TransactionQueryFilter = {}): Promise<number> {
    const { where, params } = buildTransactionWhereClause(filter);
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM ${this.qTransactions}
       ${where}`,
      params,
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async getTransactionByHash(hash: string): Promise<StoredTransaction | null> {
    const result = await this.db.query<TransactionRow>(
      `SELECT
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
        input_data_size_bytes,
        input_data_compressed_size_bytes,
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
      WHERE hash = $1
      LIMIT 1`,
      [hash.toLowerCase()],
    );
    const row = result.rows[0];
    return row ? mapTransactionRow(row) : null;
  }

  async queryTransactionRecords(
    filter: TransactionRecordsQueryFilter = {},
  ): Promise<StoredTransactionRecordsByCategory> {
    const limit = resolveLimit(filter.limit, MAX_TRANSACTION_RECORDS_PER_CATEGORY);
    const result: StoredTransactionRecordsByCategory = emptyTransactionRecordsByCategory();

    for (const category of TRANSACTION_RECORD_CATEGORIES) {
      const rows = await this.db.query<TransactionRecordRow>(
        `SELECT
           category,
           record_value,
           ROW_NUMBER() OVER (
             PARTITION BY category
             ORDER BY record_value::numeric DESC, block_number DESC, position DESC
           )::int AS rank,
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
           input_data_size_bytes,
           input_data_compressed_size_bytes,
           cumulative_gas_used,
           gas_price_wei,
           max_fee_per_gas_wei,
           max_priority_fee_per_gas_wei,
           effective_gas_price_wei,
           priority_fee_wei,
           transaction_fee_wei,
           status,
           contract_address,
           to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at_utc
         FROM ${this.qTransactionRecords}
         WHERE category = $1
         ORDER BY record_value::numeric DESC, block_number DESC, position DESC
         LIMIT $2`,
        [category, limit],
      );
      result[category] = rows.rows.map(mapTransactionRecordRow);
    }

    return result;
  }

  async getInspectedBlock(blockNumber: bigint): Promise<InspectedBlock | undefined> {
    const [block] = await this.queryBlocks({ blockGt: blockNumber - 1n, blockLt: blockNumber + 1n });
    if (!block) {
      return undefined;
    }

    const transactions = await this.queryTransactions({
      blockNumber,
      limit: MAX_TRANSACTIONS_PER_QUERY,
      order: "asc",
    });

    return {
      blockNumber: block.blockNumber,
      blockNumberDecimal: blockNumber.toString(),
      blockDate: block.blockDate,
      blockTimeSeconds: block.blockTimeSeconds,
      baseBlockFeeWei: block.baseBlockFeeWei,
      totalGasUsed: block.totalGasUsed,
      maxGasInBlock: block.maxGasInBlock,
      transactionCount: block.transactionCount,
      ...(block.blockRewardWei != null ? { blockRewardWei: block.blockRewardWei } : {}),
      ...(block.burntFeesWei != null ? { burntFeesWei: block.burntFeesWei } : {}),
      ...(block.totalTransactionFeeWei != null
        ? { totalTransactionFeeWei: block.totalTransactionFeeWei }
        : {}),
      ...(block.averageFeePriceWei != null ? { averageFeePriceWei: block.averageFeePriceWei } : {}),
      ...(block.averageTransactionFeeWei != null
        ? { averageTransactionFeeWei: block.averageTransactionFeeWei }
        : {}),
      ...(block.averageTransactionGasUsed != null
        ? { averageTransactionGasUsed: block.averageTransactionGasUsed }
        : {}),
      ...(block.averagePriorityFeeWeightedWei != null
        ? { averagePriorityFeeWeightedWei: block.averagePriorityFeeWeightedWei }
        : {}),
      ...(block.averagePriorityFeeWei != null
        ? { averagePriorityFeeWei: block.averagePriorityFeeWei }
        : {}),
      ...(block.batcherQueueSize != null ? { batcherQueueSize: block.batcherQueueSize } : {}),
      ...(block.batcherIntensity != null ? { batcherIntensity: block.batcherIntensity } : {}),
      ...(block.batcherLowerThreshold != null
        ? { batcherLowerThreshold: block.batcherLowerThreshold }
        : {}),
      ...(block.batcherUpperThreshold != null
        ? { batcherUpperThreshold: block.batcherUpperThreshold }
        : {}),
      ...(block.batcherMaxBlockSize != null
        ? { batcherMaxBlockSize: block.batcherMaxBlockSize }
        : {}),
      ...(block.batcherMaxTxSize != null ? { batcherMaxTxSize: block.batcherMaxTxSize } : {}),
      transactions: transactions.map(stripStoredTransactionContext),
    };
  }

  async aggregateSenderStats(): Promise<number> {
    return this.db.transaction(async (client) => {
      await client.query(`DELETE FROM ${this.qSenderStats}`);
      const result = await client.query(
        `INSERT INTO ${this.qSenderStats} (
          address,
          latest_nonce,
          transaction_count,
          total_gas_used,
          total_transaction_fee_wei,
          total_value_wei,
          average_gas_used,
          average_transaction_fee_wei,
          first_block_number,
          last_block_number,
          first_block_date,
          last_block_date,
          aggregated_at
        )
        SELECT
          LOWER(from_address) AS address,
          MAX(nonce::numeric)::text AS latest_nonce,
          COUNT(*) AS transaction_count,
          SUM(gas_used::numeric)::text AS total_gas_used,
          SUM(transaction_fee_wei::numeric)::text AS total_transaction_fee_wei,
          SUM(value_wei::numeric)::text AS total_value_wei,
          TRUNC(SUM(gas_used::numeric) / COUNT(*), 0)::text AS average_gas_used,
          TRUNC(SUM(transaction_fee_wei::numeric) / COUNT(*), 0)::text AS average_transaction_fee_wei,
          MIN(block_number) AS first_block_number,
          MAX(block_number) AS last_block_number,
          (ARRAY_AGG(block_date ORDER BY block_number ASC, position ASC))[1] AS first_block_date,
          (ARRAY_AGG(block_date ORDER BY block_number DESC, position DESC))[1] AS last_block_date,
          NOW() AS aggregated_at
        FROM ${this.qTransactions}
        WHERE from_address IS NOT NULL
        GROUP BY LOWER(from_address)`,
      );
      return result.rowCount;
    });
  }

  async querySenderStats(filter: SenderStatsQueryFilter = {}): Promise<StoredSenderStats[]> {
    const limit = resolveLimit(filter.limit, MAX_SENDERS_PER_QUERY);
    const order = resolveQueryOrder(filter.order);
    const tieOrder = order === "DESC" ? "DESC" : "ASC";
    const result = await this.db.query<SenderStatsRow>(
      // transaction_count / *_block_number are BIGINT; Bun.sql already returns
      // them as strings, so no ::text cast is needed. Do NOT cast: a transaction_count::text output
      // column would shadow the BIGINT in ORDER BY and rank lexicographically (e.g. "9" > "1000").
      `SELECT
         address,
         latest_nonce,
         transaction_count,
         total_gas_used,
         total_transaction_fee_wei,
         total_value_wei,
         average_gas_used,
         average_transaction_fee_wei,
         first_block_number,
         last_block_number,
         first_block_date,
         last_block_date,
         to_char(aggregated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS aggregated_at_utc
       FROM ${this.qSenderStats}
       ORDER BY transaction_count ${order}, last_block_number ${tieOrder}, address ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapSenderStatsRow);
  }

  async listBaseloadConfigs(): Promise<StoredBaseloadConfigSummary[]> {
    const result = await this.db.query<{
      name: string;
      worker_count: number;
      created_at_utc: string;
      updated_at_utc: string;
    }>(
      `SELECT
         name,
         jsonb_array_length(COALESCE(config_json->'workers', '[]'::jsonb)) AS worker_count,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc
       FROM ${this.qBaseloadConfigs}
       ORDER BY name ASC`,
    );

    return result.rows.map(mapBaseloadConfigSummaryRow);
  }

  async getBaseloadConfig(name: string): Promise<StoredBaseloadConfig | undefined> {
    const result = await this.db.query<BaseloadConfigRow>(
      `SELECT
         name,
         config_json::text AS config_json,
         jsonb_array_length(COALESCE(config_json->'workers', '[]'::jsonb)) AS worker_count,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc
       FROM ${this.qBaseloadConfigs}
       WHERE name = $1`,
      [name],
    );

    const row = result.rows[0];
    return row ? mapBaseloadConfigRow(row) : undefined;
  }

  async saveBaseloadConfig(name: string, config: BaseloadConfig): Promise<StoredBaseloadConfig> {
    const result = await this.db.query<BaseloadConfigRow>(
      `INSERT INTO ${this.qBaseloadConfigs} (name, config_json, created_at, updated_at)
       VALUES ($1, $2::jsonb, NOW(), NOW())
       ON CONFLICT (name) DO UPDATE SET
         config_json = EXCLUDED.config_json,
         updated_at = NOW()
       RETURNING
         name,
         config_json::text AS config_json,
         jsonb_array_length(COALESCE(config_json->'workers', '[]'::jsonb)) AS worker_count,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
         to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_utc`,
      // Bind the object itself — a JSON.stringify'd string would be
      // double-encoded into a jsonb string scalar by Bun.sql.
      [name, config],
    );

    const row = result.rows[0];
    if (!row) throw new Error("Failed to save Baseload config");
    return mapBaseloadConfigRow(row);
  }

  async deleteBaseloadConfig(name: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM ${this.qBaseloadConfigs} WHERE name = $1`, [name]);
    return (result.rowCount ?? 0) > 0;
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

  async getLatestCompleteRangeStart(
    rangeSize: bigint,
    fromRangeStart?: bigint,
  ): Promise<bigint | undefined> {
    assertSupportedRangeSize(rangeSize);
    if (fromRangeStart !== undefined && (fromRangeStart < 0n || fromRangeStart % rangeSize !== 0n)) {
      throw new Error(
        `Range start ${fromRangeStart.toString()} must be a non-negative multiple of ${rangeSize.toString()}`,
      );
    }

    if (fromRangeStart !== undefined) {
      const result = await this.db.query<{ range_start: string | null }>(
        `WITH complete_ranges AS (
           SELECT
             range_start,
             ROW_NUMBER() OVER (ORDER BY range_start ASC) AS row_number
           FROM ${this.qBlockRanges}
           WHERE range_size = $1
             AND range_start >= $2
             AND is_complete = TRUE
         ),
         contiguous_ranges AS (
           SELECT range_start
           FROM complete_ranges
           WHERE range_start = $2::bigint + ((row_number - 1) * $1::bigint)
         )
         SELECT MAX(range_start)::text AS range_start
         FROM contiguous_ranges`,
        [rangeSize.toString(), fromRangeStart.toString()],
      );
      const value = result.rows[0]?.range_start;
      return value === null || value === undefined ? undefined : BigInt(value);
    }

    const result = await this.db.query<{ range_start: string | null }>(
      `SELECT MAX(range_start)::text AS range_start
       FROM ${this.qBlockRanges}
       WHERE range_size = $1
         AND is_complete = TRUE`,
      [rangeSize.toString()],
    );
    const value = result.rows[0]?.range_start;
    return value === null || value === undefined ? undefined : BigInt(value);
  }

  async isBlockRangeComplete(rangeStart: bigint, rangeSize: bigint): Promise<boolean> {
    assertSupportedRangeSize(rangeSize);
    if (rangeStart < 0n || rangeStart % rangeSize !== 0n) {
      throw new Error(
        `Range start ${rangeStart.toString()} must be a non-negative multiple of ${rangeSize.toString()}`,
      );
    }
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM ${this.qBlockRanges}
         WHERE range_size = $1
           AND range_start = $2
           AND is_complete = TRUE
       ) AS exists`,
      [rangeSize.toString(), rangeStart.toString()],
    );
    return result.rows[0]?.exists === true;
  }

  async saveBlockRange(metrics: BlockRangeMetrics): Promise<void> {
    assertSupportedRangeSize(metrics.rangeSize);
    await this.db.query(
      `INSERT INTO ${this.qBlockRanges} (
        range_size,
        range_start,
        range_end,
        min_block_date,
        max_block_date,
        average_block_time_seconds,
        min_block_time_seconds,
        max_block_time_seconds,
        min_base_fee_wei,
        max_base_fee_wei,
        average_base_fee_wei,
        total_gas_used,
        average_total_gas_used,
        min_total_gas_used,
        max_total_gas_used,
        total_input_data_size_bytes,
        average_total_input_data_size_bytes,
        min_total_input_data_size_bytes,
        max_total_input_data_size_bytes,
        total_input_data_compressed_size_bytes,
        average_total_input_data_compressed_size_bytes,
        min_total_input_data_compressed_size_bytes,
        max_total_input_data_compressed_size_bytes,
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
        average_transaction_input_data_size_bytes,
        average_transaction_input_data_compressed_size_bytes,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        min_batcher_queue_size,
        max_batcher_queue_size,
        average_batcher_queue_size,
        average_batcher_intensity,
        average_batcher_lower_threshold,
        average_batcher_upper_threshold,
        average_batcher_max_block_size,
        average_batcher_max_tx_size,
        is_complete,
        aggregated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, TRUE, NOW())
      ON CONFLICT (range_size, range_start) DO UPDATE SET
        range_end = EXCLUDED.range_end,
        min_block_date = EXCLUDED.min_block_date,
        max_block_date = EXCLUDED.max_block_date,
        average_block_time_seconds = EXCLUDED.average_block_time_seconds,
        min_block_time_seconds = EXCLUDED.min_block_time_seconds,
        max_block_time_seconds = EXCLUDED.max_block_time_seconds,
        min_base_fee_wei = EXCLUDED.min_base_fee_wei,
        max_base_fee_wei = EXCLUDED.max_base_fee_wei,
        average_base_fee_wei = EXCLUDED.average_base_fee_wei,
        total_gas_used = EXCLUDED.total_gas_used,
        average_total_gas_used = EXCLUDED.average_total_gas_used,
        min_total_gas_used = EXCLUDED.min_total_gas_used,
        max_total_gas_used = EXCLUDED.max_total_gas_used,
        total_input_data_size_bytes = EXCLUDED.total_input_data_size_bytes,
        average_total_input_data_size_bytes = EXCLUDED.average_total_input_data_size_bytes,
        min_total_input_data_size_bytes = EXCLUDED.min_total_input_data_size_bytes,
        max_total_input_data_size_bytes = EXCLUDED.max_total_input_data_size_bytes,
        total_input_data_compressed_size_bytes = EXCLUDED.total_input_data_compressed_size_bytes,
        average_total_input_data_compressed_size_bytes = EXCLUDED.average_total_input_data_compressed_size_bytes,
        min_total_input_data_compressed_size_bytes = EXCLUDED.min_total_input_data_compressed_size_bytes,
        max_total_input_data_compressed_size_bytes = EXCLUDED.max_total_input_data_compressed_size_bytes,
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
        average_transaction_input_data_size_bytes = EXCLUDED.average_transaction_input_data_size_bytes,
        average_transaction_input_data_compressed_size_bytes = EXCLUDED.average_transaction_input_data_compressed_size_bytes,
        average_priority_fee_weighted_wei = EXCLUDED.average_priority_fee_weighted_wei,
        average_priority_fee_wei = EXCLUDED.average_priority_fee_wei,
        min_batcher_queue_size = EXCLUDED.min_batcher_queue_size,
        max_batcher_queue_size = EXCLUDED.max_batcher_queue_size,
        average_batcher_queue_size = EXCLUDED.average_batcher_queue_size,
        average_batcher_intensity = EXCLUDED.average_batcher_intensity,
        average_batcher_lower_threshold = EXCLUDED.average_batcher_lower_threshold,
        average_batcher_upper_threshold = EXCLUDED.average_batcher_upper_threshold,
        average_batcher_max_block_size = EXCLUDED.average_batcher_max_block_size,
        average_batcher_max_tx_size = EXCLUDED.average_batcher_max_tx_size,
        is_complete = TRUE,
        aggregated_at = NOW()`,
      [
        metrics.rangeSize.toString(),
        metrics.rangeStart.toString(),
        metrics.rangeEnd.toString(),
        metrics.minBlockDate,
        metrics.maxBlockDate,
        metrics.averageBlockTimeSeconds,
        metrics.minBlockTimeSeconds,
        metrics.maxBlockTimeSeconds,
        metrics.minBaseFeeWei,
        metrics.maxBaseFeeWei,
        metrics.averageBaseFeeWei,
        metrics.totalGasUsed,
        metrics.averageTotalGasUsed,
        metrics.minTotalGasUsed,
        metrics.maxTotalGasUsed,
        metrics.totalInputDataSizeBytes,
        metrics.averageTotalInputDataSizeBytes,
        metrics.minTotalInputDataSizeBytes,
        metrics.maxTotalInputDataSizeBytes,
        metrics.totalInputDataCompressedSizeBytes,
        metrics.averageTotalInputDataCompressedSizeBytes,
        metrics.minTotalInputDataCompressedSizeBytes,
        metrics.maxTotalInputDataCompressedSizeBytes,
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
        metrics.averageTransactionInputDataSizeBytes,
        metrics.averageTransactionInputDataCompressedSizeBytes,
        metrics.averagePriorityFeeWeightedWei,
        metrics.averagePriorityFeeWei,
        metrics.minBatcherQueueSize ?? null,
        metrics.maxBatcherQueueSize ?? null,
        metrics.averageBatcherQueueSize ?? null,
        metrics.averageBatcherIntensity ?? null,
        metrics.averageBatcherLowerThreshold ?? null,
        metrics.averageBatcherUpperThreshold ?? null,
        metrics.averageBatcherMaxBlockSize ?? null,
        metrics.averageBatcherMaxTxSize ?? null,
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
        average_block_time_seconds,
        min_block_time_seconds,
        max_block_time_seconds,
        min_base_fee_wei,
        max_base_fee_wei,
        average_base_fee_wei,
        total_gas_used,
        average_total_gas_used,
        min_total_gas_used,
        max_total_gas_used,
        total_input_data_size_bytes,
        average_total_input_data_size_bytes,
        min_total_input_data_size_bytes,
        max_total_input_data_size_bytes,
        total_input_data_compressed_size_bytes,
        average_total_input_data_compressed_size_bytes,
        min_total_input_data_compressed_size_bytes,
        max_total_input_data_compressed_size_bytes,
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
        average_transaction_input_data_size_bytes,
        average_transaction_input_data_compressed_size_bytes,
        average_priority_fee_weighted_wei,
        average_priority_fee_wei,
        min_batcher_queue_size,
        max_batcher_queue_size,
        average_batcher_queue_size,
        average_batcher_intensity,
        average_batcher_lower_threshold,
        average_batcher_upper_threshold,
        average_batcher_max_block_size,
        average_batcher_max_tx_size
      FROM ${this.qBlockRanges}
      WHERE ${clauses.join(" AND ")}
      ORDER BY range_start ${order}
      LIMIT $${params.length}
    `;

    const result = await this.db.query<{
      range_size: string;
      range_start: string;
      range_end: string;
      min_block_date: string;
      max_block_date: string;
      average_block_time_seconds: string;
      min_block_time_seconds: string;
      max_block_time_seconds: string;
      min_base_fee_wei: string;
      max_base_fee_wei: string;
      average_base_fee_wei: string;
      total_gas_used: string;
      average_total_gas_used: string;
      min_total_gas_used: string;
      max_total_gas_used: string;
      total_input_data_size_bytes: string;
      average_total_input_data_size_bytes: string;
      min_total_input_data_size_bytes: string;
      max_total_input_data_size_bytes: string;
      total_input_data_compressed_size_bytes: string;
      average_total_input_data_compressed_size_bytes: string;
      min_total_input_data_compressed_size_bytes: string;
      max_total_input_data_compressed_size_bytes: string;
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
      average_transaction_input_data_size_bytes: string;
      average_transaction_input_data_compressed_size_bytes: string;
      average_priority_fee_weighted_wei: string;
      average_priority_fee_wei: string;
      min_batcher_queue_size: string | null;
      max_batcher_queue_size: string | null;
      average_batcher_queue_size: string | null;
      average_batcher_intensity: string | null;
      average_batcher_lower_threshold: string | null;
      average_batcher_upper_threshold: string | null;
      average_batcher_max_block_size: string | null;
      average_batcher_max_tx_size: string | null;
    }>(sql, params);

    return result.rows.map((row) => ({
      rangeSize: Number(row.range_size),
      rangeStart: Number(row.range_start),
      rangeEnd: Number(row.range_end),
      minBlockDate: row.min_block_date,
      maxBlockDate: row.max_block_date,
      averageBlockTimeSeconds: row.average_block_time_seconds,
      minBlockTimeSeconds: row.min_block_time_seconds,
      maxBlockTimeSeconds: row.max_block_time_seconds,
      minBaseFeeWei: row.min_base_fee_wei,
      maxBaseFeeWei: row.max_base_fee_wei,
      averageBaseFeeWei: row.average_base_fee_wei,
      totalGasUsed: row.total_gas_used,
      averageTotalGasUsed: row.average_total_gas_used,
      minTotalGasUsed: row.min_total_gas_used,
      maxTotalGasUsed: row.max_total_gas_used,
      totalInputDataSizeBytes: row.total_input_data_size_bytes,
      averageTotalInputDataSizeBytes: row.average_total_input_data_size_bytes,
      minTotalInputDataSizeBytes: row.min_total_input_data_size_bytes,
      maxTotalInputDataSizeBytes: row.max_total_input_data_size_bytes,
      totalInputDataCompressedSizeBytes: row.total_input_data_compressed_size_bytes,
      averageTotalInputDataCompressedSizeBytes: row.average_total_input_data_compressed_size_bytes,
      minTotalInputDataCompressedSizeBytes: row.min_total_input_data_compressed_size_bytes,
      maxTotalInputDataCompressedSizeBytes: row.max_total_input_data_compressed_size_bytes,
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
      averageTransactionInputDataSizeBytes: row.average_transaction_input_data_size_bytes,
      averageTransactionInputDataCompressedSizeBytes: row.average_transaction_input_data_compressed_size_bytes,
      averagePriorityFeeWeightedWei: row.average_priority_fee_weighted_wei,
      averagePriorityFeeWei: row.average_priority_fee_wei,
      minBatcherQueueSize: row.min_batcher_queue_size,
      maxBatcherQueueSize: row.max_batcher_queue_size,
      averageBatcherQueueSize: row.average_batcher_queue_size,
      averageBatcherIntensity: row.average_batcher_intensity,
      averageBatcherLowerThreshold: row.average_batcher_lower_threshold,
      averageBatcherUpperThreshold: row.average_batcher_upper_threshold,
      averageBatcherMaxBlockSize: row.average_batcher_max_block_size,
      averageBatcherMaxTxSize: row.average_batcher_max_tx_size,
    }));
  }

  async getMinStoredBlock(): Promise<bigint | undefined> {
    const result = await this.db.query<{ value: string | null }>(
      `SELECT MIN(block_number)::text AS value FROM ${this.qBlocks}`,
    );
    const row = result.rows[0];
    return row && row.value !== null ? BigInt(row.value) : undefined;
  }

  async getMaxStoredBlock(): Promise<bigint | undefined> {
    const result = await this.db.query<{ value: string | null }>(
      `SELECT MAX(block_number)::text AS value FROM ${this.qBlocks}`,
    );
    const row = result.rows[0];
    return row && row.value !== null ? BigInt(row.value) : undefined;
  }

  async getStoredBlockBounds(): Promise<StoredBlockBounds | undefined> {
    const result = await this.db.query<{
      min_block: string | null;
      min_block_date: string | null;
      max_block: string | null;
      max_block_date: string | null;
    }>(
      // block_number is BIGINT and Bun.sql already returns it as a string, so
      // no ::text cast is needed. Do NOT cast here: a block_number::text output column would shadow
      // the BIGINT in ORDER BY and sort lexicographically ("1000000" < "999999"), giving min > max.
      `SELECT
         (SELECT block_number FROM ${this.qBlocks} ORDER BY block_number ASC LIMIT 1) AS min_block,
         (SELECT block_date FROM ${this.qBlocks} ORDER BY block_number ASC LIMIT 1) AS min_block_date,
         (SELECT block_number FROM ${this.qBlocks} ORDER BY block_number DESC LIMIT 1) AS max_block,
         (SELECT block_date FROM ${this.qBlocks} ORDER BY block_number DESC LIMIT 1) AS max_block_date`,
    );
    const row = result.rows[0];
    if (!row || row.min_block === null || row.max_block === null) {
      return undefined;
    }
    return {
      minBlock: BigInt(row.min_block),
      minBlockDate: row.min_block_date ?? "",
      maxBlock: BigInt(row.max_block),
      maxBlockDate: row.max_block_date ?? "",
    };
  }

  async getRangeBlockCoverage(rangeStart: bigint, rangeSize: bigint): Promise<RangeBlockCoverage> {
    assertSupportedRangeSize(rangeSize);
    const rangeEnd = rangeEndFor(rangeStart, rangeSize);
    const result = await this.db.query<{
      present: string;
      latest_block: string | null;
      latest_block_date: string | null;
      first_missing: string | null;
    }>(
      // LEFT JOIN every block number the range expects against stored blocks. This yields the present
      // count and — key for diagnosing a stuck range — the first block that is absent. The MIN/MAX
      // aggregates run on the BIGINT before the ::text cast, so they stay numeric (no lexicographic
      // sorting); the cast only affects how the result is transported back.
      `SELECT
         COUNT(b.block_number)::text AS present,
         MAX(b.block_number)::text AS latest_block,
         MAX(b.block_date) AS latest_block_date,
         (MIN(expected.block_number) FILTER (WHERE b.block_number IS NULL))::text AS first_missing
       FROM generate_series($1::bigint, $2::bigint) AS expected(block_number)
       LEFT JOIN ${this.qBlocks} AS b ON b.block_number = expected.block_number`,
      [rangeStart.toString(), rangeEnd.toString()],
    );
    const row = result.rows[0];
    return {
      rangeStart,
      rangeEnd,
      blocksPresent: Number(row?.present ?? "0"),
      blocksExpected: Number(rangeSize),
      ...(row?.latest_block != null ? { latestBlock: BigInt(row.latest_block) } : {}),
      ...(row?.latest_block_date != null ? { latestBlockDate: row.latest_block_date } : {}),
      ...(row?.first_missing != null ? { firstMissingBlock: BigInt(row.first_missing) } : {}),
    };
  }

  async getLatestCompleteBlockRange(rangeSize: bigint): Promise<LatestCompleteBlockRange | undefined> {
    assertSupportedRangeSize(rangeSize);
    const result = await this.db.query<{
      range_start: string;
      range_end: string;
      min_block_date: string;
      max_block_date: string;
    }>(
      // range_start/range_end are BIGINT and Bun.sql already returns them as
      // strings, so no ::text cast is needed. Do NOT cast: a range_start::text output column would
      // shadow the BIGINT in ORDER BY and sort lexicographically ("999900" > "1000050").
      `SELECT range_start, range_end, min_block_date, max_block_date
       FROM ${this.qBlockRanges}
       WHERE range_size = $1 AND is_complete = TRUE
       ORDER BY range_start DESC
       LIMIT 1`,
      [rangeSize.toString()],
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    return {
      rangeStart: BigInt(row.range_start),
      rangeEnd: BigInt(row.range_end),
      minBlockDate: row.min_block_date,
      maxBlockDate: row.max_block_date,
    };
  }

  /**
   * Find internal holes in the stored block sequence: maximal runs of absent block numbers that sit
   * *between* two stored blocks. Detected with a LEAD window over the blocks primary key, so it is a
   * single index scan rather than a generate_series over the whole span. Gaps below the minimum or
   * above the maximum stored block are intentionally NOT reported — those are backfill/head concerns,
   * not internal gaps. `limit` caps the number of gap ranges returned (ascending by block number).
   */
  async findBlockGaps(limit = 1000): Promise<BlockGap[]> {
    const resolvedLimit = resolveLimit(limit, MAX_BLOCKS_PER_QUERY);
    const result = await this.db.query<{ gap_start: string; gap_end: string }>(
      // Arithmetic and ORDER BY run on the BIGINT block_number; the ::text casts only shape the
      // output for transport (Bun.sql returns BIGINT as string). Do NOT order by a ::text
      // alias — it would sort lexicographically.
      `SELECT
         (s.block_number + 1)::text AS gap_start,
         (s.next_block - 1)::text AS gap_end
       FROM (
         SELECT
           block_number,
           LEAD(block_number) OVER (ORDER BY block_number) AS next_block
         FROM ${this.qBlocks}
       ) s
       WHERE s.next_block IS NOT NULL AND s.next_block > s.block_number + 1
       ORDER BY s.block_number
       LIMIT $1`,
      [resolvedLimit],
    );
    return result.rows.map((row) => {
      const gapStart = BigInt(row.gap_start);
      const gapEnd = BigInt(row.gap_end);
      return { gapStart, gapEnd, missingCount: gapEnd - gapStart + 1n };
    });
  }

  private async applyProgressUpdate(
    client: DbQueryable,
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
    client: DbQueryable,
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
    await this.db.close();
  }
}

function resolveLimit(requested: number | undefined, hardMax: number): number {
  if (requested === undefined) return hardMax;
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), hardMax);
}

function resolvePageOffset(page: number | undefined, limit: number): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) return 0;
  const offset = (Math.floor(page) - 1) * limit;
  if (!Number.isSafeInteger(offset)) {
    throw new Error("Transaction page offset is too large");
  }
  return offset;
}

function resolveQueryOrder(order: QueryOrder | undefined): "ASC" | "DESC" {
  return order === "asc" ? "ASC" : "DESC";
}

function buildTransactionWhereClause(
  filter: TransactionQueryFilter,
): { where: string; params: Array<string | number> } {
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

  if (filter.fromAddress !== undefined) {
    params.push(filter.fromAddress.toLowerCase());
    clauses.push(`LOWER(from_address) = $${params.length}`);
  }

  if (filter.nonceGt !== undefined) {
    params.push(filter.nonceGt.toString());
    clauses.push(`nonce::numeric > $${params.length}::numeric`);
  }

  if (filter.nonceLt !== undefined) {
    params.push(filter.nonceLt.toString());
    clauses.push(`nonce::numeric < $${params.length}::numeric`);
  }

  if (filter.dateGt !== undefined) {
    params.push(filter.dateGt);
    clauses.push(`block_date > $${params.length}`);
  }

  if (filter.dateLt !== undefined) {
    params.push(filter.dateLt);
    clauses.push(`block_date < $${params.length}`);
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

function quoteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

interface BaseloadConfigSummaryRow {
  name: string;
  worker_count: number;
  created_at_utc: string;
  updated_at_utc: string;
}

interface BaseloadConfigRow extends BaseloadConfigSummaryRow {
  config_json: string;
}

interface SenderStatsRow {
  address: string;
  latest_nonce: string | null;
  transaction_count: string;
  total_gas_used: string;
  total_transaction_fee_wei: string;
  total_value_wei: string;
  average_gas_used: string;
  average_transaction_fee_wei: string;
  first_block_number: string;
  last_block_number: string;
  first_block_date: string;
  last_block_date: string;
  aggregated_at_utc: string;
}

type TransactionRecordRow = {
  category: string;
  record_value: string;
  rank: number;
  recorded_at_utc: string;
} & TransactionRow;

interface TransactionOperationRow {
  op_index: number;
  operation_type: number;
  operation: string;
  entity_key: string | null;
  content_type: string | null;
  payload_size_bytes: number;
  attributes: ArkivOperationAttribute[] | string;
  expires_at_blocks: string | null;
  new_owner: string | null;
  is_reference: boolean;
  // The `| string` union mirrors `attributes`: defends against a legacy
  // double-encoded jsonb row written before Bun.sql object-binding.
  payload_reference: ArkivPayloadReference | string | null;
  reference_verification: ArkivReferenceVerification | string | null;
  reference_error: string | null;
}

type EntityOperationRow = TransactionOperationRow & {
  block_number: string;
  position: number;
  hash: string;
  block_date: string;
};

interface TransactionRow {
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
  input_data_size_bytes: string;
  input_data_compressed_size_bytes: string;
  cumulative_gas_used: string | null;
  gas_price_wei: string | null;
  max_fee_per_gas_wei: string | null;
  max_priority_fee_per_gas_wei: string | null;
  effective_gas_price_wei: string;
  priority_fee_wei: string;
  transaction_fee_wei: string;
  status: string | null;
  contract_address: string | null;
}

function emptyTransactionRecordsByCategory(): StoredTransactionRecordsByCategory {
  return {
    gas_used: [],
    transaction_fee: [],
    effective_fee: [],
  };
}

function recordValueForCategory(
  category: TransactionRecordCategory,
  transaction: InspectedTransaction,
): string {
  switch (category) {
    case "gas_used":
      return transaction.gasUsed;
    case "transaction_fee":
      return transaction.transactionFeeWei;
    case "effective_fee":
      return transaction.effectiveGasPriceWei;
  }
}

function compareTransactionRecordCandidates(
  left: { recordValue: string; transaction: InspectedTransaction },
  right: { recordValue: string; transaction: InspectedTransaction },
): number {
  const leftValue = BigInt(left.recordValue);
  const rightValue = BigInt(right.recordValue);
  if (leftValue > rightValue) return -1;
  if (leftValue < rightValue) return 1;
  return right.transaction.position - left.transaction.position;
}

function mapBaseloadConfigSummaryRow(row: BaseloadConfigSummaryRow): StoredBaseloadConfigSummary {
  return {
    name: row.name,
    workerCount: row.worker_count,
    createdAt: row.created_at_utc,
    updatedAt: row.updated_at_utc,
  };
}

function mapBaseloadConfigRow(row: BaseloadConfigRow): StoredBaseloadConfig {
  return {
    ...mapBaseloadConfigSummaryRow(row),
    config: JSON.parse(row.config_json) as BaseloadConfig,
  };
}

function mapSenderStatsRow(row: SenderStatsRow): StoredSenderStats {
  return {
    address: row.address,
    latestNonce: row.latest_nonce,
    transactionCount: row.transaction_count,
    totalGasUsed: row.total_gas_used,
    totalTransactionFeeWei: row.total_transaction_fee_wei,
    totalValueWei: row.total_value_wei,
    averageGasUsed: row.average_gas_used,
    averageTransactionFeeWei: row.average_transaction_fee_wei,
    firstBlockNumber: Number(row.first_block_number),
    firstBlockNumberDecimal: row.first_block_number,
    lastBlockNumber: Number(row.last_block_number),
    lastBlockNumberDecimal: row.last_block_number,
    firstBlockDate: row.first_block_date,
    lastBlockDate: row.last_block_date,
    aggregatedAt: row.aggregated_at_utc,
  };
}

function mapTransactionRecordRow(row: TransactionRecordRow): StoredTransactionRecord {
  const category = parseTransactionRecordCategory(row.category);
  return {
    ...mapTransactionRow(row),
    category,
    recordValue: row.record_value,
    rank: row.rank,
    recordedAt: row.recorded_at_utc,
  };
}

function parseTransactionRecordCategory(value: string): TransactionRecordCategory {
  if (value === "gas_used" || value === "transaction_fee" || value === "effective_fee") {
    return value;
  }
  throw new Error(`Unknown transaction record category: ${value}`);
}

function mapTransactionOperationRow(row: TransactionOperationRow): ArkivOperation {
  return {
    opIndex: row.op_index,
    operationType: row.operation_type,
    operation: row.operation,
    entityKey: row.entity_key,
    contentType: row.content_type,
    payloadSizeBytes: row.payload_size_bytes,
    // Bun.sql parses jsonb on read, so attributes normally arrive as an array.
    // Rows written while Bun double-encoded stringified params surface as JSON
    // strings instead; parse those. expires_at_blocks is BIGINT (string).
    attributes:
      typeof row.attributes === "string"
        ? (JSON.parse(row.attributes) as ArkivOperationAttribute[])
        : row.attributes,
    expiresAtBlocks: Number(row.expires_at_blocks ?? 0),
    newOwner: row.new_owner,
    // is_reference is NOT NULL DEFAULT FALSE, so always a real boolean.
    isReference: row.is_reference,
    payloadReference: parseJsonbColumn<ArkivPayloadReference>(row.payload_reference),
    referenceVerification: parseJsonbColumn<ArkivReferenceVerification>(row.reference_verification),
    referenceError: row.reference_error,
  };
}

/**
 * Read a nullable jsonb column. Bun.sql parses jsonb to a JS value on read, but
 * a legacy double-encoded row surfaces as a JSON string — parse those, mirroring
 * the attributes handling above.
 */
function parseJsonbColumn<T>(value: T | string | null): T | null {
  if (value === null) return null;
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

function mapTransactionRow(row: TransactionRow): StoredTransaction {
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
    inputDataSizeBytes: row.input_data_size_bytes,
    inputDataCompressedSizeBytes: row.input_data_compressed_size_bytes,
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
    inputDataSizeBytes: row.inputDataSizeBytes,
    inputDataCompressedSizeBytes: row.inputDataCompressedSizeBytes,
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
