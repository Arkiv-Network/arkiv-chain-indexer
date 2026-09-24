/** Opt-in real Rust producer -> PostgreSQL experiment; no application .env is needed.
 * TEST_DATABASE_URL=... SIMULATOR_EXPERIMENT_BINARY=/abs/arkiv-simulator \
 * bun --no-env-file src/simulator/experiment.ts > report.jsonl
 * Creates isolated sim_measure_* schemas; removes them and stops its child on exit.
 * The private temporary producer directory is retained for backend cold-open measurements.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { openDb } from "../db";
import { metricsRegistry } from "../serverMetrics";
import { SimulatorStorage } from "./storage";
import { HttpSimulatorSource } from "./source";
import { parseStatus } from "./wire";
import { boundedJson, decimal, integer } from "./common";
import { parseIdentity, type SimulatorIdentity } from "./config";

const now = () => performance.now();
function memory() {
  const before = process.memoryUsage();
  Bun.gc(true);
  const after = process.memoryUsage();
  return {
    rssBytes: before.rss,
    postGcRssBytes: after.rss,
    heapUsedBytes: after.heapUsed,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}
async function queryCount() {
  const metrics = await metricsRegistry.render();
  return metrics
    .split("\n")
    .filter((x) => x.startsWith("indexer_db_queries_total{"))
    .reduce((n, x) => n + Number(x.slice(x.lastIndexOf(" ") + 1)), 0);
}
async function cold(url: string, id: SimulatorIdentity, schema: string) {
  const started = now(),
    store = await SimulatorStorage.open(url, id, schema);
  try {
    const progress = await store.progress();
    return {
      height: progress.height,
      openMs: now() - started,
      statements: await queryCount(),
      memory: memory(),
    };
  } finally {
    await store.close();
  }
}
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw Error(
    "TEST_DATABASE_URL required; application DATABASE_URL is never used",
  );
if (process.argv[2] === "cold") {
  const identity = parseIdentity(
    JSON.parse(process.env.SIMULATOR_EXPERIMENT_IDENTITY!),
  );
  console.log(
    JSON.stringify(
      await cold(
        databaseUrl,
        identity,
        process.env.SIMULATOR_EXPERIMENT_SCHEMA!,
      ),
    ),
  );
} else {
  const binary = process.env.SIMULATOR_EXPERIMENT_BINARY;
  if (!binary?.startsWith("/"))
    throw Error("absolute SIMULATOR_EXPERIMENT_BINARY required");
  const count = integer(
    Number(decimal(process.env.SIMULATOR_EXPERIMENT_BLOCKS ?? "10000", true)),
    10000,
  );
  const port = integer(
    Number(process.env.SIMULATOR_EXPERIMENT_PORT ?? "19640"),
    65534,
  );
  const directory = await mkdtemp(
      join(tmpdir(), "arkiv-sim-metadata-experiment-"),
    ),
    token = randomBytes(32).toString("hex"),
    origin = `http://127.0.0.1:${port}`,
    privateOrigin = `http://127.0.0.1:${port + 1}`;
  const child = Bun.spawn(
    [
      binary,
      "producer",
      "--unsigned-simulator",
      "--run-dir",
      directory,
      "--listen",
      `127.0.0.1:${port}`,
      "--admin-listen",
      `127.0.0.1:${port + 1}`,
      "--cache-bytes",
      "8388608",
    ],
    {
      env: { ...process.env, SIMULATOR_ADMIN_TOKEN: token },
      stdout: Bun.file(join(directory, "producer.log")),
      stderr: Bun.file(join(directory, "producer.err")),
    },
  );
  const schemas: string[] = [];
  let store: SimulatorStorage | undefined;
  const output = (value: unknown) => console.log(JSON.stringify(value));
  try {
    let status: ReturnType<typeof parseStatus> | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(origin + "/sim/v1/status", {
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          status = parseStatus(await boundedJson(r, 65536));
          break;
        }
      } catch {}
      await Bun.sleep(50);
    }
    if (!status || status.head.height !== "0" || child.exitCode !== null)
      throw Error("producer failed to start as a fresh run");
    const id = parseIdentity(status);
    output({
      phase: "start",
      directory,
      producerPid: child.pid,
      blocks: count,
      identity: id,
      workload: status.workload,
      memory: memory(),
    });
    const productionStart = now();
    let revision = status.configRevision;
    for (let height = 1; height <= count; height++) {
      const command = {
        commandId: "0x" + BigInt(height).toString(16).padStart(64, "0"),
        runId: id.runId,
        expectedRevision: revision,
        expectedHeight: String(height - 1),
        action: "step",
        config: null,
      };
      const response = await fetch(privateOrigin + "/sim/v1/control", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(command),
      });
      if (!response.ok)
        throw Error(`producer step failed at ${height}: ${response.status}`);
      const result = (await boundedJson(response, 4096)) as {
        configRevision: string;
        head: { height: string };
      };
      if (result.head.height !== String(height))
        throw Error("producer height mismatch");
      revision = result.configRevision;
      if (height === 100 || height % 1000 === 0)
        output({
          phase: "produce",
          height,
          elapsedMs: now() - productionStart,
          producerStatus: await readFile(
            `/proc/${child.pid}/status`,
            "utf8",
          ).then((s) => s.split("\n").filter((l) => /^Vm(RSS|HWM):/.test(l))),
          fileBytes: (await stat(join(directory, "node.redb"))).size,
        });
    }
    let firstHead: string | null = null;
    for (const pass of ["catch-up", "rebuild"]) {
      const schema = "sim_measure_" + randomUUID().replaceAll("-", "");
      schemas.push(schema);
      store = await SimulatorStorage.open(databaseUrl, id, schema);
      let feedBytes = 0,
        feedReads = 0,
        feedMs = 0;
      const source = new HttpSimulatorSource(origin, id, async (request) => {
        const response = await fetch(request);
        if (request.url.includes("/feed/blocks/")) {
          feedReads++;
          if (!response.body) throw Error("emptyfeed");
          return new Response(
            response.body.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  feedBytes += chunk.byteLength;
                  controller.enqueue(chunk);
                },
              }),
            ),
            { status: response.status, headers: response.headers },
          );
        }
        return response;
      });
      await store.observe(await source.status());
      const started = now(),
        startQueries = await queryCount();
      for (let height = 0; height <= count; height++) {
        const readStart = now(),
          block = await source.block(String(height));
        feedMs += now() - readStart;
        await store.ingest(block);
        if (height === 100 || height === 1000 || height === count) {
          const coldChild = Bun.spawn(
            [process.execPath, "--no-env-file", import.meta.path, "cold"],
            {
              env: {
                ...process.env,
                TEST_DATABASE_URL: databaseUrl,
                SIMULATOR_EXPERIMENT_IDENTITY: JSON.stringify(id),
                SIMULATOR_EXPERIMENT_SCHEMA: schema,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const coldOutput = await new Response(coldChild.stdout).text();
          if ((await coldChild.exited) !== 0) throw Error("cold child failed");
          output({
            phase: pass,
            height,
            elapsedMs: now() - started,
            feedMs,
            feedReads,
            feedBytes,
            statements: (await queryCount()) - startQueries,
            memory: memory(),
            coldOpen: JSON.parse(coldOutput),
          });
        }
      }
      const progress = await store.progress();
      if (firstHead !== null && firstHead !== progress.hash)
        throw Error("rebuild head mismatch");
      firstHead = progress.hash;
      const sizes = await store.db.query<{ bytes: string }>(
        "SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'",
        [schema],
      );
      output({
        phase: pass + "-complete",
        progress,
        pgRelationBytes: sizes.rows[0]!.bytes,
        memory: memory(),
      });
      await store.close();
      store = undefined;
    }
  } finally {
    await store?.close();
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    const db = openDb(databaseUrl);
    try {
      for (const schema of schemas)
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.close();
    }
    output({
      phase: "finished",
      directory,
      producerStopped: true,
      schemasDropped: schemas.length,
    });
  }
}
