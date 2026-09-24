import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDb, type DbQueryable } from "../db";
import { SimulatorStorage } from "./storage";
import { HttpSimulatorSource } from "./source";
import { runNativeScanner, scanTick } from "./scanner";
import { SimulatorError } from "./common";
import {
  genesis,
  history,
  status,
  next,
  op,
  row,
  OWNER,
  ZERO,
} from "./testFixtures";
const url = process.env.TEST_DATABASE_URL;
async function isolated(
  body: (s: SimulatorStorage, schema: string) => Promise<void>,
) {
  const schema = "sim_fault_" + randomUUID().replaceAll("-", "");
  const s = await SimulatorStorage.open(url!, genesis(), schema);
  try {
    await body(s, schema);
  } finally {
    await s.close();
    const db = openDb(url!);
    try {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.close();
    }
  }
}
async function oldState(s: SimulatorStorage, schema: string) {
  expect(await s.progress()).toMatchObject({
    height: "0",
    blocks: "1",
    transactions: "0",
    operations: "0",
    liveRecords: "0",
    namespaces: "0",
    spentUnits: "0",
  });
  expect(await s.header("1")).toBeNull();
  for (const table of [
    "transactions",
    "operations",
    "namespace_versions",
    "record_versions",
    "record_attributes",
    "raw_versions",
  ]) {
    expect(
      (
        await s.db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM "${schema}".${table}`,
        )
      ).rows[0]!.n,
    ).toBe("0");
  }
}

describe.skipIf(!url)("native ingestion PostgreSQL failure boundaries", () => {
  for (const code of ["ChainConflict", "IdentityMismatch", "UnsupportedVersion"])
    test(`${code} fences scanner across storage reopen even when the peer becomes consistent`, () =>
      isolated(async (s, schema) => {
        await s.ingest(genesis());
        await expect(
          runNativeScanner(
            {
              status: async () => {
                throw new SimulatorError(code, 409);
              },
              block: async () => genesis(),
            },
            s,
          ),
        ).rejects.toThrow(code);
        expect((await s.progress()).health).toBe(code);
        const reopened = await SimulatorStorage.open(url!, genesis(), schema);
        let reads = 0;
        try {
          await expect(
            runNativeScanner(
              {
                status: async () => {
                  reads++;
                  return status(genesis());
                },
                block: async () => genesis(),
              },
              reopened,
            ),
          ).rejects.toThrow(code);
          expect(reads).toBe(0);
          expect((await reopened.progress()).health).toBe(code);
          expect((await reopened.progress()).height).toBe("0");
        } finally {
          await reopened.close();
        }
      }));
  test("a persisted transient source failure can resume after reopen", () =>
    isolated(async (s, schema) => {
      await s.health("SourceBehind");
      const reopened = await SimulatorStorage.open(url!, genesis(), schema),
        controller = new AbortController();
      try {
        await runNativeScanner(
          {
            status: async () => {
              controller.abort();
              return status(genesis());
            },
            block: async () => genesis(),
          },
          reopened,
          1,
          controller.signal,
        );
        expect(await reopened.progress()).toMatchObject({
          height: "0",
          health: "running",
        });
      } finally {
        await reopened.close();
      }
    }));
  test(
    "every DML/notification boundary and immediately before COMMIT rolls back exact state",
    () =>
      isolated(async (s, schema) => {
        const initial = history()[1]!;
        const baseline = next(
          genesis(),
          [
            ...initial.changes,
            {
              kind: "rawUpsert",
              namespaceId: "1",
              key: "0x03",
              byteLength: "4",
              digest: ZERO,
            },
            {
              kind: "rawUpsert",
              namespaceId: "1",
              key: "0x04",
              byteLength: "4",
              digest: ZERO,
            },
          ],
          [
            ...initial.operations,
            op("put", "1", null, "0x03"),
            op("put", "1", null, "0x04"),
          ],
        );
        const block = next(
          baseline,
          [
            {
              kind: "namespaceUpsert",
              namespaceId: "1",
              name: "first",
              owner: OWNER,
              revision: "1",
            },
            {
              kind: "namespaceUpsert",
              namespaceId: "3",
              name: "third",
              owner: OWNER,
              revision: "0",
            },
            {
              kind: "recordDelete",
              namespaceId: "1",
              recordId: "1",
              recordKey: "0x01",
            },
            row("2"),
            row("1", "0x01", "2"),
            {
              kind: "rawUpsert",
              namespaceId: "1",
              key: "0x03",
              byteLength: "8",
              digest: ZERO,
            },
            { kind: "rawDelete", namespaceId: "1", key: "0x04" },
          ],
          [
            op("transferNamespace", "1"),
            op("createNamespace", "3"),
            op("deleteRecord", "1", "1", "0x01"),
            op("createRecord", "1", "2", "0x01"),
            op("patchRecord", "2", "1", "0x01"),
            op("put", "1", null, "0x03"),
            op("delete", "1", null, "0x04"),
          ],
        );
        await s.ingest(genesis());
        await s.ingest(baseline);
        const dump = async () => {
          const result: Record<string, unknown> = {};
          for (const table of [
            "progress",
            "blocks",
            "transactions",
            "operations",
            "namespace_versions",
            "record_versions",
            "record_attributes",
            "raw_versions",
          ]) {
            result[table] = (
              await s.db.query(
                `SELECT to_jsonb(t)::text AS value FROM "${schema}".${table} t ORDER BY 1`,
              )
            ).rows;
          }
          return result;
        };
        const before = await dump();
        const transaction = s.db.transaction.bind(s.db);
        let boundary = 0,
          total = 0,
          cut = Infinity,
          notificationCount = 0;
        const subscription = await s.db.listen(`sim_${schema}`, () => {
          notificationCount++;
        });
        // The wrapper executes real SQL on the real transaction's dedicated connection.
        // The final sentinel is thrown after the callback but before the driver's COMMIT.
        function install(beforeCommit = false) {
          s.db.transaction = <T>(
            fn: (tx: DbQueryable) => Promise<T>,
          ): Promise<T> =>
            transaction(async (tx) => {
              const result = await fn({
                query: async <R>(sql: string, args: unknown[] = []) => {
                  const result = await tx.query<R>(sql, args);
                  if (/^(INSERT|UPDATE|SELECT pg_notify)/.test(sql)) {
                    boundary++;
                    if (boundary === cut) throw Error("InjectedWriteBoundary");
                  }
                  return result;
                },
              });
              if (beforeCommit) throw Error("InjectedBeforeCommit");
              return result;
            });
        }
        try {
          install(true);
          await expect(s.ingest(block)).rejects.toThrow("InjectedBeforeCommit");
          total = boundary;
          expect(total).toBeGreaterThan(20);
          expect(await dump()).toEqual(before);
          for (cut = 1; cut <= total; cut++) {
            boundary = 0;
            install();
            await expect(s.ingest(block)).rejects.toThrow(
              "InjectedWriteBoundary",
            );
            expect(await dump()).toEqual(before);
          }
          console.info(
            `Verified rollback after all ${total} DML/notification statements and before COMMIT`,
          );
          await Bun.sleep(10);
          expect(notificationCount).toBe(0);
          s.db.transaction = transaction;
          await s.ingest(block);
          for (let i = 0; i < 50 && notificationCount === 0; i++)
            await Bun.sleep(5);
          expect(notificationCount).toBe(1);
          expect(await s.progress()).toMatchObject({
            height: "2",
            blocks: "3",
            transactions: "2",
            operations: "13",
            namespaces: "3",
            liveRecords: "2",
            rawRecords: "1",
          });
        } finally {
          s.db.transaction = transaction;
          await subscription.unlisten();
        }
      }),
    20000,
  );
  test("COMMIT succeeds but its response is lost: reopen and exact retry deduplicate without double counts", () =>
    isolated(async (s, schema) => {
      await s.ingest(genesis());
      const transaction = s.db.transaction.bind(s.db);
      s.db.transaction = async (fn) => {
        await transaction(fn);
        throw Error("LostCommitResponse");
      };
      try {
        await expect(s.ingest(history()[1]!)).rejects.toThrow(
          "LostCommitResponse",
        );
      } finally {
        s.db.transaction = transaction;
      }
      const reopened = await SimulatorStorage.open(url!, genesis(), schema);
      try {
        const before = await reopened.progress();
        expect(before).toMatchObject({
          height: "1",
          blocks: "2",
          transactions: "1",
          operations: "4",
        });
        expect(await reopened.ingest(history()[1]!)).toBe("duplicate");
        expect(await reopened.progress()).toEqual(before);
        expect(await reopened.block("1")).toEqual(history()[1]!);
      } finally {
        await reopened.close();
      }
    }));
  test("terminating the actual in-progress PostgreSQL connection rolls back block and projection", () =>
    isolated(async (s, schema) => {
      await s.ingest(genesis());
      const transaction = s.db.transaction.bind(s.db),
        killer = openDb(url!);
      let killed = false;
      s.db.transaction = (fn) =>
        transaction(async (tx) => {
          const pid = (
            await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]!.pid;
          return fn({
            query: async <R>(sql: string, args: unknown[] = []) => {
              const result = await tx.query<R>(sql, args);
              if (
                !killed &&
                sql.startsWith(`INSERT INTO "${schema}".operations`)
              ) {
                killed = true;
                expect(
                  (
                    await killer.query<{ terminated: boolean }>(
                      "SELECT pg_terminate_backend($1) AS terminated",
                      [pid],
                    )
                  ).rows[0]!.terminated,
                ).toBe(true);
                throw Error("TerminatedTransactionConnection");
              }
              return result;
            },
          });
        });
      try {
        await expect(s.ingest(history()[1]!)).rejects.toThrow();
        expect(killed).toBe(true);
      } finally {
        s.db.transaction = transaction;
        await killer.close();
      }
      const reopened = await SimulatorStorage.open(url!, genesis(), schema);
      try {
        await oldState(reopened, schema);
        await reopened.ingest(history()[1]!);
        expect((await reopened.progress()).height).toBe("1");
      } finally {
        await reopened.close();
      }
    }));
  test("interrupted real HTTP metadata response retries the same uncommitted height", () =>
    isolated(async (s) => {
      const blocks = history();
      let attempts = 0;
      const seen: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/sim/v1/status")
            return Response.json(status(blocks[1]!));
          const h = path.slice(path.lastIndexOf("/") + 1);
          seen.push(h);
          if (h === "1" && attempts++ === 0)
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode('{"feedVersion":1,"header":'),
                  );
                  controller.close();
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          return Response.json(blocks[Number(h)]);
        },
      });
      try {
        const source = new HttpSimulatorSource(
          `http://127.0.0.1:${server.port}`,
          genesis(),
        );
        await expect(scanTick(source, s)).rejects.toThrow("Transport");
        expect((await s.progress()).height).toBe("0");
        await scanTick(source, s);
        expect(seen).toEqual(["0", "1", "1"]);
        expect((await s.progress()).height).toBe("1");
      } finally {
        await server.stop(true);
      }
    }));
});
