import pg from "pg";
import { ScannerStorage } from "./storage";

const { Pool } = pg;

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export const hasPostgresForTests = (): boolean => Boolean(TEST_DATABASE_URL);

const adminPools: pg.Pool[] = [];

function adminPool(url: string): pg.Pool {
  const pool = new Pool({ connectionString: url, max: 2 });
  adminPools.push(pool);
  return pool;
}

export async function createIsolatedStorage(prefix = "test"): Promise<{
  storage: ScannerStorage;
  cleanup: () => Promise<void>;
}> {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required to create an isolated storage instance");
  }

  const suffix = Math.random().toString(36).slice(2, 10);
  const schema = `${prefix}_${suffix}`.toLowerCase();
  const admin = adminPool(TEST_DATABASE_URL);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

  const storage = await ScannerStorage.open(TEST_DATABASE_URL, { schema });

  const cleanup = async () => {
    try {
      await storage.close();
    } catch {
      // ignore
    }
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // ignore
    }
  };

  return { storage, cleanup };
}

export async function closeTestPools(): Promise<void> {
  while (adminPools.length > 0) {
    const pool = adminPools.pop();
    if (pool) {
      try {
        await pool.end();
      } catch {
        // ignore
      }
    }
  }
}
