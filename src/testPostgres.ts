import { SQL } from "bun";
import { ScannerStorage } from "./storage";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

export const hasPostgresForTests = (): boolean => Boolean(TEST_DATABASE_URL);

const adminClients: SQL[] = [];

function adminClient(url: string): SQL {
  const sql = new SQL(url, { max: 2 });
  adminClients.push(sql);
  return sql;
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
  const admin = adminClient(TEST_DATABASE_URL);
  await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

  const storage = await ScannerStorage.open(TEST_DATABASE_URL, { schema });

  const cleanup = async () => {
    try {
      await storage.close();
    } catch {
      // ignore
    }
    try {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // ignore
    }
  };

  return { storage, cleanup };
}

export async function closeTestPools(): Promise<void> {
  while (adminClients.length > 0) {
    const sql = adminClients.pop();
    if (sql) {
      try {
        await sql.close();
      } catch {
        // ignore
      }
    }
  }
}
