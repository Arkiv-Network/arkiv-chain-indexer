import { openDb, type Db } from "./db";
import { ScannerStorage } from "./storage";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export const hasPostgresForTests = (): boolean => Boolean(TEST_DATABASE_URL);

const adminDbs: Db[] = [];

function adminDb(url: string): Db {
  const db = openDb(url, { max: 2 });
  adminDbs.push(db);
  return db;
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
  const admin = adminDb(TEST_DATABASE_URL);
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
  while (adminDbs.length > 0) {
    const db = adminDbs.pop();
    if (db) {
      try {
        await db.close();
      } catch {
        // ignore
      }
    }
  }
}
