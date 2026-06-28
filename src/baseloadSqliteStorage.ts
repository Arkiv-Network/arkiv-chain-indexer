import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { normalizeBaseloadConfig, type BaseloadConfig } from "./baseloadConfig";
import type { BaseloadConfigStorage } from "./server";
import type { StoredBaseloadConfig, StoredBaseloadConfigSummary } from "./storage";

export class BaseloadSqliteStorage implements BaseloadConfigStorage {
  private constructor(private readonly db: Database) {}

  static async open(databasePath: string): Promise<BaseloadSqliteStorage> {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const db = new Database(databasePath, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run(`
      CREATE TABLE IF NOT EXISTS baseload_configs (
        name TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    return new BaseloadSqliteStorage(db);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async listBaseloadConfigs(): Promise<StoredBaseloadConfigSummary[]> {
    const rows = this.db
      .query<BaseloadConfigRow, []>(
        `SELECT name, config_json, created_at, updated_at
         FROM baseload_configs
         ORDER BY name ASC`,
      )
      .all();
    return rows.map(mapSummaryRow);
  }

  async getBaseloadConfig(name: string): Promise<StoredBaseloadConfig | undefined> {
    const row = this.db
      .query<BaseloadConfigRow, [string]>(
        `SELECT name, config_json, created_at, updated_at
         FROM baseload_configs
         WHERE name = ?`,
      )
      .get(name);
    return row ? mapConfigRow(row) : undefined;
  }

  async saveBaseloadConfig(name: string, config: BaseloadConfig): Promise<StoredBaseloadConfig> {
    const normalized = normalizeBaseloadConfig(config);
    const configJson = JSON.stringify(normalized);
    this.db
      .query<[string, string], [string, string]>(
        `INSERT INTO baseload_configs (name, config_json, created_at, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(name) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(name, configJson);

    const saved = await this.getBaseloadConfig(name);
    if (!saved) throw new Error("Failed to save Baseload config");
    return saved;
  }

  async deleteBaseloadConfig(name: string): Promise<boolean> {
    const result = this.db.query<never, [string]>("DELETE FROM baseload_configs WHERE name = ?").run(name);
    return result.changes > 0;
  }
}

interface BaseloadConfigRow {
  name: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

function mapSummaryRow(row: BaseloadConfigRow): StoredBaseloadConfigSummary {
  const config = JSON.parse(row.config_json) as BaseloadConfig;
  return {
    name: row.name,
    workerCount: Array.isArray(config.workers) ? config.workers.length : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConfigRow(row: BaseloadConfigRow): StoredBaseloadConfig {
  return {
    ...mapSummaryRow(row),
    config: JSON.parse(row.config_json) as BaseloadConfig,
  };
}
