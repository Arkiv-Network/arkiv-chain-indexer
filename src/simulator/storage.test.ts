import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDb } from "../db";
import { SimulatorStorage } from "./storage";
import {
  genesis,
  history,
  next,
  op,
  row,
  status,
  redigest,
  OWNER,
  ZERO,
} from "./testFixtures";
import { scanTick } from "./scanner";
import { fail } from "./common";
import { createNativeHandler } from "./server";
import { parsePredicate } from "./query";
const url = process.env.TEST_DATABASE_URL;
const pg = describe.skipIf(!url);
async function isolated(
  body: (storage: SimulatorStorage, schema: string) => Promise<void>,
): Promise<void> {
  const schema = "sim_test_" + randomUUID().replaceAll("-", "");
  const store = await SimulatorStorage.open(url!, genesis(), schema);
  try {
    await body(store, schema);
  } finally {
    await store.close();
    const db = openDb(url!);
    try {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.close();
    }
  }
}
pg("native PostgreSQL projection", () => {
  test("atomically resumes, rejects changed identity/conflicting duplicate, no failed-block skip", () =>
    isolated(async (s, schema) => {
      const blocks = history();
      let failed = true;
      const requested: string[] = [];
      const source = {
        status: async () => status(blocks[2]!),
        block: async (h: string) => {
          requested.push(h);
          if (h === "1" && failed) {
            failed = false;
            return fail("Transport", 503);
          }
          return blocks[Number(h)]!;
        },
      };
      await expect(scanTick(source, s)).rejects.toThrow("Transport");
      expect((await s.progress()).height).toBe("0");
      await scanTick(source, s);
      expect(requested).toEqual(["0", "1", "1", "2"]);
      expect((await s.progress()).height).toBe("2");
      expect(await s.ingest(blocks[1])).toBe("duplicate");
      await expect(
        s.ingest(
          redigest({
            ...blocks[1]!,
            changes: [
              {
                kind: "namespaceUpsert",
                namespaceId: "1",
                owner: OWNER,
                revision: "0",
                name: "changed",
              },
              ...blocks[1]!.changes.slice(1),
            ],
          }),
        ),
      ).rejects.toThrow("ChainConflict");
      await expect(
        SimulatorStorage.open(url!, { ...genesis(), chainId: "2" }, schema),
      ).rejects.toThrow("IdentityMismatch");
      const reopened = await SimulatorStorage.open(url!, genesis(), schema);
      try {
        expect((await reopened.progress()).height).toBe("2");
        expect(await scanTick(source, reopened)).toBe(0);
      } finally {
        await reopened.close();
      }
      expect((await s.progress()).blocks).toBe("3");
    }));
  test("failure after block/operations insertion rolls back every table and progress", () =>
    isolated(async (s, schema) => {
      const [g, b] = history();
      await s.ingest(g);
      await s.db.query(
        `CREATE FUNCTION "${schema}".reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`,
      );
      await s.db.query(
        `CREATE TRIGGER reject_projection BEFORE INSERT ON "${schema}".record_versions FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_projection()`,
      );
      await expect(s.ingest(b)).rejects.toThrow();
      expect((await s.progress()).height).toBe("0");
      for (const table of [
        "transactions",
        "operations",
        "namespace_versions",
        "record_versions",
      ]) {
        expect(
          (
            await s.db.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM "${schema}".${table}`,
            )
          ).rows[0]!.n,
        ).toBe("0");
      }
      expect(await s.header("1")).toBeNull();
      await s.db.query(
        `DROP TRIGGER reject_projection ON "${schema}".record_versions`,
      );
      await s.ingest(b);
      expect((await s.progress()).height).toBe("1");
    }));
  test("record incarnation, historical UTF8/NUL values, namespace isolation, numeric and typed predicates", () =>
    isolated(async (s) => {
      const blocks = history();
      for (const b of blocks) await s.ingest(b);
      const old = await s.page("records", { namespaceId: "1", atHeight: "1" });
      expect(old.rows[0]).toMatchObject({
        recordId: "1",
        createdAtHeight: "1",
      });
      expect((old.rows[0] as any).attributes[2].value).toBe(
        "nul\u0000unicodeé",
      );
      const current = await s.page("records", { namespaceId: "1" });
      expect(current.rows[0]).toMatchObject({
        recordId: "2",
        createdAtHeight: "2",
      });
      expect(
        (await s.page("records", { namespaceId: "2" })).rows[0],
      ).toMatchObject({ recordId: "1" });
      for (const [predicate, n] of [
        [
          {
            op: "eq",
            attribute: {
              name: "n",
              type: "u64",
              value: "18446744073709551615",
            },
          },
          1,
        ],
        [
          {
            op: "lt",
            attribute: {
              name: "minus",
              type: "i64",
              value: "-9007199254740992",
            },
          },
          1,
        ],
        [{ op: "eq", attribute: { name: "n", type: "i64", value: "7" } }, 0],
        [
          {
            op: "prefix",
            attribute: { name: "text", type: "str", value: "nul\u0000" },
          },
          1,
        ],
        [{ op: "not", arg: { op: "exists", name: "absent" } }, 1],
      ] as const) {
        expect(
          (
            await s.page("records", {
              namespaceId: "1",
              predicate: parsePredicate(predicate),
            })
          ).rows.length,
        ).toBe(n);
      }
      const historyPage = await s.page("record-history", {
        namespaceId: "1",
        recordKey: "0x01",
      });
      expect(historyPage.rows.map((x: any) => x.kind)).toEqual([
        "createRecord",
        "deleteRecord",
        "createRecord",
      ]);
      await expect(s.page("records", { namespaceId: "3" })).rejects.toThrow(
        "NamespaceNotFound",
      );
      await expect(
        s.page("records", { namespaceId: "1", atHeight: "3" }),
      ).rejects.toThrow("CoverageUnavailable");
    }));
  test("cursor pins snapshot while producer advances, cannot change namespace/filter/limit/run", () =>
    isolated(async (s) => {
      const [g, b] = history();
      await s.ingest(g);
      await s.ingest(b);
      const first = await s.page("blocks", { limit: 1 });
      expect(first.snapshot.height).toBe("1");
      expect(first.nextCursor).not.toBeNull();
      await s.ingest(next(b!));
      const second = await s.page("blocks", {
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.snapshot.height).toBe("1");
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      await expect(
        s.page("blocks", { limit: 2, cursor: first.nextCursor! }),
      ).rejects.toThrow("CursorMismatch");
      await expect(
        s.page("blocks", {
          limit: 1,
          cursor: first.nextCursor!,
          atHeight: "2",
        }),
      ).rejects.toThrow("CursorMismatch");
      const namespaces = await s.page("namespaces", { limit: 1 });
      await expect(
        s.page("records", {
          namespaceId: "1",
          limit: 1,
          cursor: namespaces.nextCursor!,
        }),
      ).rejects.toThrow("CursorMismatch");
    }));
  test("rollback outcomes do not project, expiry tombstone and raw metadata counts are exact", () =>
    isolated(async (s) => {
      let b = history()[1]!;
      await s.ingest(genesis());
      await s.ingest(b);
      const rolled = {
        ...op("createRecord", "1", "2", "0x02"),
        outcome: "rolledBack" as const,
      };
      const rejected = {
        ...op("patchRecord", "1", null, "0x03"),
        outcome: "rejected" as const,
        reason: "EngineRejected",
      };
      b = next(b, [], [rolled, rejected]);
      await s.ingest(b);
      expect((await s.page("records", { namespaceId: "1" })).rows).toHaveLength(
        1,
      );
      b = next(
        b,
        [
          {
            kind: "recordDelete",
            namespaceId: "1",
            recordId: "1",
            recordKey: "0x01",
          },
          {
            kind: "rawUpsert",
            namespaceId: "1",
            key: "0x",
            byteLength: "7",
            digest: ZERO,
          },
        ],
        [
          { ...op("expireRecord", "1", "1", "0x01"), phase: "expiry" },
          op("put", "1", null, "0x"),
        ],
      );
      b.operations[1]!.operationPosition = 0;
      redigest(b);
      await s.ingest(b);
      expect((await s.page("records", { namespaceId: "1" })).rows).toHaveLength(
        0,
      );
      expect((await s.page("raw", { namespaceId: "1" })).rows[0]).toMatchObject(
        { key: "0x", byteLength: "7" },
      );
      expect((await s.progress()).liveRecords).toBe("1");
      expect((await s.progress()).rawRecords).toBe("1");
      b = next(b, [row("2")], [op("createRecord", "1", "2", "0x01")]);
      await s.ingest(b);
      expect(
        (await s.page("records", { namespaceId: "1" })).rows[0],
      ).toMatchObject({ recordId: "2", createdAtHeight: "4" });
      expect((await s.block("1")).changes).toEqual(history()[1]!.changes);
    }));
  test("concurrent consumers are idempotent and request IDs cannot be included again", () =>
    isolated(async (s, schema) => {
      const other = await SimulatorStorage.open(url!, genesis(), schema);
      try {
        const [g, b] = history();
        expect(
          (await Promise.all([s.ingest(g), other.ingest(g)])).sort(),
        ).toEqual(["committed", "duplicate"]);
        await s.ingest(b);
        const repeated = next(
          b!,
          [
            {
              kind: "rawUpsert",
              namespaceId: "1",
              key: "0x",
              byteLength: "1",
              digest: ZERO,
            },
          ],
          [op("put", "1", null, "0x")],
        );
        repeated.transactions[0]!.requestId = b!.transactions[0]!.requestId;
        redigest(repeated);
        await expect(s.ingest(repeated)).rejects.toThrow("RequestConflict");
        expect((await s.progress()).height).toBe("1");
      } finally {
        await other.close();
      }
    }));
  test("public metadata service starts with only PG and never invokes Ethereum or upstream for reads", () =>
    isolated(async (s) => {
      for (const b of history()) await s.ingest(b);
      const handle = createNativeHandler({
        storage: s,
        fetcher: async () => {
          throw Error("unexpected network");
        },
      });
      expect(
        await (await handle(new Request("http://test/health"))).json(),
      ).toMatchObject({ sourceKind: "arkiv-native-simulator" });
      for (const path of [
        "status",
        "statistics",
        "blocks",
        "blocks/1",
        "transactions",
        "operations",
        "namespaces",
        "records?namespaceId=1",
        "raw?namespaceId=1",
        "record-history?namespaceId=1&recordKey=0x01",
      ]) {
        const r = await handle(new Request("http://test/sim/v1/" + path));
        expect(r.status).toBe(200);
        expect(await r.text()).not.toContain("calldata");
      }
      const query = await handle(
        new Request("http://test/sim/v1/query", {
          method: "POST",
          body: JSON.stringify({
            namespaceId: "1",
            predicate: {
              op: "eq",
              attribute: {
                name: "n",
                type: "u64",
                value: "18446744073709551615",
              },
            },
          }),
        }),
      );
      expect(((await query.json()) as any).rows).toHaveLength(1);
      const bad = await handle(
        new Request("http://test/sim/v1/records?namespaceId=1&payload=true"),
      );
      expect(bad.status).toBe(400);
      expect(
        (
          await handle(
            new Request("http://test/shadow-rpc", { method: "POST" }),
          )
        ).status,
      ).toBe(405);
    }));
  test("explicit new run isolates progress, old cursors and data remain bound to original run", () =>
    isolated(async (s, schema) => {
      for (const b of history()) await s.ingest(b);
      const old = await s.page("blocks", { limit: 1 });
      const fresh = redigest({ ...genesis(), runId: "22".repeat(16) }),
        other = await SimulatorStorage.open(url!, fresh, schema);
      try {
        expect((await other.progress()).height).toBeNull();
        await other.ingest(fresh);
        expect((await other.progress()).height).toBe("0");
        expect((await s.progress()).height).toBe("2");
        await expect(
          other.page("blocks", { limit: 1, cursor: old.nextCursor! }),
        ).rejects.toThrow("CursorMismatch");
      } finally {
        await other.close();
      }
    }));
  test("covered missing block is corruption, future block is unavailable, authentic stale source retries", () =>
    isolated(async (s, schema) => {
      const blocks = history();
      for (const b of blocks) await s.ingest(b);
      await expect(s.observe(status(blocks[1]!))).rejects.toThrow(
        "SourceBehind",
      );
      expect((await s.progress()).height).toBe("2");
      await expect(
        s.observe({
          ...status(blocks[1]!),
          head: { ...status(blocks[1]!).head, hash: ZERO },
        }),
      ).rejects.toThrow("ChainConflict");
      await s.db.query(`DELETE FROM "${schema}".blocks WHERE height=0`);
      await expect(s.snapshot("0")).rejects.toThrow("StorageCorrupt");
      await expect(s.snapshot("3")).rejects.toThrow("CoverageUnavailable");
    }));
});
