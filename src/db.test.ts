import { afterAll, describe, expect, test } from "bun:test";
import { openDb, textArrayLiteral, type Db } from "./db";
import { TEST_DATABASE_URL, hasPostgresForTests } from "./testPostgres";

// Pins the Bun.sql decoding behaviors the storage layer depends on. If a Bun
// upgrade changes any of these, this suite fails before storage corrupts data.

if (!hasPostgresForTests()) {
  describe.skip("db adapter (skipped: set TEST_DATABASE_URL to run)", () => {});
} else {
  const db: Db = openDb(TEST_DATABASE_URL!, { max: 2 });

  afterAll(async () => {
    await db.close();
  });

  describe("db adapter", () => {
    test("BIGINT and NUMERIC columns decode as exact strings", async () => {
      const result = await db.query<{ huge: unknown; just_over: unknown; n: unknown; c: unknown }>(
        `SELECT
           9223372036854775807::bigint AS huge,
           9007199254740995::bigint AS just_over,
           12345678901234567890123::numeric AS n,
           COUNT(*) AS c
         FROM (VALUES (1), (2)) v`,
      );
      const row = result.rows[0]!;
      expect(row.huge).toBe("9223372036854775807");
      expect(row.just_over).toBe("9007199254740995");
      expect(row.n).toBe("12345678901234567890123");
      expect(row.c).toBe("2");
    });

    test("INTEGER columns decode as numbers", async () => {
      const result = await db.query<{ i: unknown }>(`SELECT 42::integer AS i`);
      expect(result.rows[0]!.i).toBe(42);
    });

    test("jsonb columns are parsed to JS values on read", async () => {
      const result = await db.query<{ j: unknown }>(`SELECT '[{"k":"a","v":1}]'::jsonb AS j`);
      expect(result.rows[0]!.j).toEqual([{ k: "a", v: 1 }]);
    });

    test("JS objects bound to jsonb params serialize as documents", async () => {
      const result = await db.query<{ t: string; len: number }>(
        `SELECT jsonb_typeof($1::jsonb) AS t,
                jsonb_array_length($1::jsonb->'workers') AS len`,
        [{ workers: [{ id: 1 }] }],
      );
      expect(result.rows[0]!.t).toBe("object");
      expect(result.rows[0]!.len).toBe(1);
    });

    test("pre-stringified JSON bound to jsonb params double-encodes (do not do this)", async () => {
      const result = await db.query<{ t: string }>(`SELECT jsonb_typeof($1::jsonb) AS t`, [
        JSON.stringify({ workers: [] }),
      ]);
      expect(result.rows[0]!.t).toBe("string");
    });

    test("textArrayLiteral works with ANY($1::text[])", async () => {
      const result = await db.query<{ x: string }>(
        `SELECT x FROM unnest(ARRAY['a','b','c,d','e"f']) x WHERE x = ANY($1::text[]) ORDER BY x`,
        [textArrayLiteral(["a", "c,d", 'e"f'])],
      );
      expect(result.rows.map((row) => row.x)).toEqual(["a", "c,d", 'e"f']);
    });

    test("rowCount reflects INSERT/upsert/DELETE affected rows", async () => {
      await db.query(`CREATE TEMP TABLE db_test_t (id int primary key, v text)`);
      const ins = await db.query(`INSERT INTO db_test_t VALUES (1,'a'), (2,'b')`);
      expect(ins.rowCount).toBe(2);
      const ups = await db.query(
        `INSERT INTO db_test_t VALUES (1,'z') ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v`,
      );
      expect(ups.rowCount).toBe(1);
      const del = await db.query(`DELETE FROM db_test_t WHERE id = 1`);
      expect(del.rowCount).toBe(1);
      await db.query(`DROP TABLE db_test_t`);
    });

    test("transaction commits work and rollbacks undo writes", async () => {
      await db.query(`CREATE TABLE IF NOT EXISTS db_test_tx (id int primary key)`);
      await db.query(`DELETE FROM db_test_tx`);

      await db.transaction(async (tx) => {
        await tx.query(`INSERT INTO db_test_tx VALUES (1)`);
        await tx.query(`INSERT INTO db_test_tx VALUES (2)`);
      });
      const committed = await db.query<{ c: string }>(`SELECT COUNT(*) AS c FROM db_test_tx`);
      expect(committed.rows[0]!.c).toBe("2");

      await expect(
        db.transaction(async (tx) => {
          await tx.query(`INSERT INTO db_test_tx VALUES (3)`);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const afterRollback = await db.query<{ c: string }>(`SELECT COUNT(*) AS c FROM db_test_tx`);
      expect(afterRollback.rows[0]!.c).toBe("2");

      await db.query(`DROP TABLE db_test_tx`);
    });
  });
}
