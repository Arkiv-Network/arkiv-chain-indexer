import { Database } from "bun:sqlite";
import type { BlockMetrics } from "./types";

const LAST_SUCCESSFUL_BLOCK_KEY = "last_successful_block";

export class ScannerStorage {
  private readonly insertBlock;
  private readonly upsertState;

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
    `);

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
  }

  static open(path: string): ScannerStorage {
    return new ScannerStorage(new Database(path, { create: true }));
  }

  getLastSuccessfulBlock(): bigint | undefined {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM scanner_state WHERE key = ?")
      .get(LAST_SUCCESSFUL_BLOCK_KEY);

    return row ? BigInt(row.value) : undefined;
  }

  saveBlockMetrics(metrics: BlockMetrics): void {
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
      this.upsertState.run(LAST_SUCCESSFUL_BLOCK_KEY, metrics.blockNumber.toString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
