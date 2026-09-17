#!/usr/bin/env bun
/**
 * Offline genesis import: load the entities a seeded chain carries in its
 * block-0 state straight from the `state.jsonl` dump that
 * `arkiv-cli seed-genesis` wrote (arkiv-prefill's `artifacts/<run>/seed/`),
 * into this indexer's entity index.
 *
 * The backend imports small genesis sets by walking the node's `arkiv_query`
 * at block 0 on its own (`ENTITY_INDEX_GENESIS=auto`); a node pages that walk
 * in O(N) per page, so past `ENTITY_INDEX_GENESIS_RPC_LIMIT` entities the
 * backend records `waiting` and this script does the job: it streams the dump
 * once (the records are decoded, the payload only measured), proves the
 * records' file order is the node's entity-id order against the system
 * account's id slots, writes batches under the index's fold lock, and hands
 * the import to the running backend, whose projector refolds the genesis keys
 * that have later operations and marks it `done` (see `/health` →
 * `entityQueryIndex.genesis`). An interrupted run resumes from its last batch.
 *
 * This is the only script in the repository that writes to Postgres. It runs
 * against the backend's database, typically from inside the compose network:
 *
 *   docker compose --env-file .env.sourcify.local -f docker-compose.yml -f docker-compose.prefill.yml \
 *     run --rm backend bun run scripts/importGenesisState.ts \
 *       --dump /prefill/seed/state.jsonl --rpc http://arkiv-sourcify-node-1:8545 \
 *       --progress-file /prefill/index/genesis-import-progress.json
 *
 * Output is one JSON document per line (`--log json`, the default): the same
 * progress document the `--progress-file` receives, plus an `event` field
 * (`start`, `phase`, `progress`, `done`, `stopped`, `error`), so
 * `tail -1 | jq .percent` works on the log as well as on the file.
 *
 * Options:
 *   --dump <file>                the state.jsonl dump (required)
 *   --manifest <file>            its manifest (default: <dump>.manifest.json)
 *   --database-url <url>         the indexer's Postgres (default: $DATABASE_URL)
 *   --rpc <url>                  a node on the same chain; its chain id, genesis hash,
 *                                block-0 state root and entity count must match the dump
 *                                (API key from $SHADOW_RPC_UPSTREAM_API_KEY)
 *   --batch <n>                  entities per transaction (default 5000)
 *   --rebuild-indexes <mode>     auto|always|never: drop the secondary indexes for the
 *                                load and rebuild them after (default auto = on an empty index)
 *   --progress-file <file>       write the progress document here, atomically, on every
 *                                update (default: $ENTITY_INDEX_GENESIS_PROGRESS_FILE)
 *   --progress-interval <s>      seconds between progress updates (default 2)
 *   --log <json|text>            output format (default json)
 *
 * Exit status: 0 handed off to the backend, 1 failed, 2 usage, 130 stopped by a signal.
 */

import { parseArgs } from "node:util";
import { createRpcGenesisSource } from "../src/entityGenesis";
import { fileDumpSource } from "../src/entityGenesisDump";
import {
  GenesisImportRefused,
  GenesisImportStopped,
  importGenesisDump,
  parseDumpManifest,
  type GenesisDumpExpectation,
  type RebuildIndexes,
} from "../src/entityGenesisDumpImport";
import { EntityIndexStorage } from "../src/entityIndexStorage";
import {
  GenesisProgressTracker,
  createGenesisProgressFileWriter,
  describeGenesisProgress,
  type GenesisProgressDocument,
} from "../src/genesisProgress";

const { values: args } = parseArgs({
  options: {
    dump: { type: "string" },
    manifest: { type: "string" },
    "database-url": { type: "string" },
    rpc: { type: "string" },
    batch: { type: "string" },
    "rebuild-indexes": { type: "string" },
    "progress-file": { type: "string" },
    "progress-interval": { type: "string" },
    log: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

const usage = (): never => {
  console.error(
    "usage: bun run scripts/importGenesisState.ts --dump <state.jsonl> [--manifest <file>] [--database-url <url>]\n" +
      "         [--rpc <url>] [--batch <n>] [--rebuild-indexes auto|always|never]\n" +
      "         [--progress-file <file>] [--progress-interval <seconds>] [--log json|text]",
  );
  process.exit(args.help ? 0 : 2);
};

if (args.help || !args.dump) usage();
const dumpPath = args.dump!;
const manifestPath = args.manifest ?? `${dumpPath}.manifest.json`;
const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("importGenesisState: --database-url or DATABASE_URL is required");
  usage();
}
const logFormat = args.log ?? "json";
if (logFormat !== "json" && logFormat !== "text") usage();
const rebuildIndexes = (args["rebuild-indexes"] ?? "auto") as RebuildIndexes;
if (!["auto", "always", "never"].includes(rebuildIndexes)) usage();
const batchEntities = Number(args.batch ?? "5000");
if (!Number.isInteger(batchEntities) || batchEntities <= 0) usage();
const progressIntervalMs = Number(args["progress-interval"] ?? "2") * 1000;
if (!Number.isFinite(progressIntervalMs) || progressIntervalMs < 0) usage();
const progressFile = args["progress-file"] ?? process.env.ENTITY_INDEX_GENESIS_PROGRESS_FILE;

const tracker = new GenesisProgressTracker({ writer: "import-script", source: "dump" });
const file = progressFile ? createGenesisProgressFileWriter(progressFile, (line) => console.error(line)) : undefined;
const emit = (event: string, doc: GenesisProgressDocument = tracker.snapshot()): void => {
  if (logFormat === "json") console.log(JSON.stringify({ event, ...doc }));
  else console.log(`[${new Date(doc.updated_at * 1000).toISOString()}] ${event}: ${describeGenesisProgress(doc)}`);
  void file?.write(doc);
};
const note = (line: string): void => {
  if (logFormat === "json") console.log(JSON.stringify({ event: "note", message: line, updated_at: Date.now() / 1000 }));
  else console.log(`[${new Date().toISOString()}] ${line}`);
};

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    note(`${signal}: stopping at the next batch boundary`);
    controller.abort();
  });
}

let exitCode = 0;
try {
  emit("start");
  const source = fileDumpSource(dumpPath);
  if (source.size === 0) throw new GenesisImportRefused(`${dumpPath} is empty or missing`);
  const manifest = parseDumpManifest(await Bun.file(manifestPath).json());
  note(`dump ${dumpPath}: ${manifest.count.toLocaleString("en-US")} entities for chain ${manifest.chainId}, ${source.size.toLocaleString("en-US")} bytes`);

  let expected: GenesisDumpExpectation | undefined;
  if (args.rpc) {
    const apiKey = process.env.SHADOW_RPC_UPSTREAM_API_KEY;
    const node = createRpcGenesisSource({ url: args.rpc, ...(apiKey ? { apiKey } : {}), log: note });
    const chain = await node.describe();
    const count = await node.count();
    expected = { ...chain, count };
    note(`node ${args.rpc}: chain ${chain.chainId}, genesis ${chain.genesisHash ?? "?"}, state root ${chain.stateRoot ?? "?"}, ${count.toLocaleString("en-US")} entities at block 0`);
  }

  const storage = await EntityIndexStorage.open(databaseUrl!, { max: 2 });
  try {
    const result = await importGenesisDump({
      storage,
      source,
      dumpPath,
      manifest,
      ...(expected ? { expected } : {}),
      batchEntities,
      rebuildIndexes,
      progress: tracker,
      onProgress: (event, doc) => emit(event, doc),
      progressIntervalMs,
      signal: controller.signal,
      log: note,
    });
    note(
      `${result.imported.toLocaleString("en-US")} genesis entities are in the index` +
        (result.resumedFrom > 0 ? ` (${result.resumedFrom.toLocaleString("en-US")} from earlier runs)` : "") +
        "; the backend refolds the keys with later operations and marks the import done (watch /health → entityQueryIndex.genesis)",
    );
    emit("done");
  } finally {
    await storage.close();
  }
} catch (error) {
  if (error instanceof GenesisImportStopped) {
    emit("stopped");
    exitCode = 130;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    tracker.doc.error = message;
    if (tracker.phase !== "failed") tracker.setPhase("failed");
    emit("error");
    if (!(error instanceof GenesisImportRefused)) console.error(error);
    exitCode = 1;
  }
}
await file?.flush();
process.exit(exitCode);
