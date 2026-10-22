/** Long-lived pod worker; completed imports stay healthy and are reused across restarts. */
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { EntityIndexStorage } from "../src/entityIndexStorage";
import { createRpcGenesisSource } from "../src/entityGenesis";
import { fileDumpSource } from "../src/entityGenesisDump";
import { GenesisImportRefused, importGenesisDump, parseDumpManifest, recordGenesisVerificationFailure } from "../src/entityGenesisDumpImport";
import { BootstrapIntegrityError, bootstrapDisposition, createBootstrapFetcher, downloadGenesisBootstrap, parseBootstrapReference, prepareBootstrapScratch, releaseBootstrapScratch } from "../src/genesisBootstrap";

if (process.argv.includes("--help")) {
  console.log("bootstrapGenesis: managed pod worker. Requires DATABASE_URL, GENESIS_BOOTSTRAP_RPC, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY. Optional GENESIS_BOOTSTRAP_REFERENCE (default /bootstrap/reference.json), GENESIS_BOOTSTRAP_SCRATCH (default /bootstrap-scratch), AWS_REGION (default auto). Waits for the private reference; exits only on SIGTERM/SIGINT. Completion is genesis_import=done, not process exit.");
  process.exit(0);
}

const referencePath = process.env.GENESIS_BOOTSTRAP_REFERENCE ?? "/bootstrap/reference.json";
const scratch = process.env.GENESIS_BOOTSTRAP_SCRATCH ?? "/bootstrap-scratch";
const databaseUrl = process.env.DATABASE_URL;
const rpc = process.env.GENESIS_BOOTSTRAP_RPC;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!databaseUrl || !rpc || !accessKeyId || !secretAccessKey) {
  console.error("genesis bootstrap: required database, node or storage configuration is missing");
  process.exit(2);
}
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop.abort());
let storage: EntityIndexStorage | undefined;
let lastStatus = "";
function report(status: string) {
  if (status !== lastStatus) { console.log(`genesis bootstrap: ${status}`); lastStatus = status; }
}
const node = createRpcGenesisSource({ url: rpc,
  ...(process.env.SHADOW_RPC_UPSTREAM_API_KEY ? { apiKey: process.env.SHADOW_RPC_UPSTREAM_API_KEY } : {}),
  log: () => {} });

try {
  await prepareBootstrapScratch(scratch);
  while (!stop.signal.aborted) {
    try {
      // Kubernetes projects the private reference only after the chain is running.
      // Bound config reads, and never include its contents or URIs in log output.
      if ((await stat(referencePath)).size > 64 * 1024) throw new Error("invalid reference");
      const reference = parseBootstrapReference(JSON.parse(await readFile(referencePath, "utf8")));
      const chain = await node.describe();
      if (chain.chainId !== BigInt(reference.chainId) || chain.stateRoot !== reference.stateRoot || !chain.genesisHash) {
        report("refused: node genesis does not match the retained reference");
      } else {
        storage ??= await EntityIndexStorage.open(databaseUrl, { max: 3 });
        const current = await storage.getGenesisImport();
        const identity = { chainId: chain.chainId, genesisHash: chain.genesisHash, sha256: reference.sha256 };
        const disposition = bootstrapDisposition(reference, chain.genesisHash, current);
        if (disposition === "identity-mismatch") {
          report("refused: database identity differs from the retained reference");
        } else if (disposition === "reset-required") {
          report("failed: explicit entity reset is required");
        } else if (disposition === "done") {
          await releaseBootstrapScratch(reference, scratch);
          report("done");
        } else if (disposition === "repair") {
          report("waiting for backend repair");
        } else {
          const count = await node.count();
          if (count !== reference.entityCount) {
            await recordGenesisVerificationFailure(storage, identity, "block-zero entity count differs from the retained reference");
            report("failed: block-zero entity count mismatch");
          } else {
            try {
              report("downloading and verifying retained artifacts");
              const fetcher = createBootstrapFetcher(reference, { accessKeyId, secretAccessKey,
                region: process.env.AWS_REGION ?? "auto",
                ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) });
              const files = await downloadGenesisBootstrap(reference, scratch, fetcher, stop.signal);
              report("importing genesis entities");
              await importGenesisDump({ storage, source: fileDumpSource(files.dump), dumpPath: files.dump,
                manifest: async () => parseDumpManifest(await Bun.file(files.manifest).json()), sha256: reference.sha256,
                expected: { ...chain, count }, signal: stop.signal,
                log: () => {}, onProgress: (event, doc) => {
                  if (event === "phase") report(`import phase ${doc.phase}`);
                } });
              report("waiting for backend repair");
            } catch (error) {
              if (error instanceof BootstrapIntegrityError) {
                await recordGenesisVerificationFailure(storage, identity, error.message);
                report("failed: retained artifact integrity mismatch");
              } else throw error;
            }
          }
        }
      }
    } catch (error) {
      // Transport/availability errors are retryable. Never print SDK/RPC errors:
      // they can contain private object names, credentials or node URLs.
      if (!stop.signal.aborted) report(error instanceof GenesisImportRefused
        ? "refused: import requires explicit operator resolution"
        : "waiting for reference, database, node or object storage; retrying");
    }
    try { await delay(5_000, undefined, { signal: stop.signal }); } catch { break; }
  }
} finally {
  await storage?.close();
}
