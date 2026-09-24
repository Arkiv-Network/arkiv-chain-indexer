import { setTimeout as delay } from "node:timers/promises";
import { CliHelpRequested, coercePositiveInt, parseCli, type CliSpec } from "./cli";
import { openDb } from "./db";
import { DEFAULT_STATISTICS_FILE, DEFAULT_STATISTICS_INTERVAL_MS, gatherIndexerStatistics } from "./indexerStatistics";
import { writeStatisticsFile } from "./statisticsFile";

const SPEC: CliSpec = {
  name: "collect-statistics",
  summary: "Periodically publishes all-time totals, 1h/2h/6h/12h/24h/48h/72h/7d activity and current entity state. No database writes or RPC calls.",
  options: [
    { flags: "--database-url <url>", description: "PostgreSQL connection string.", env: ["DATABASE_URL", "SCANNER_DATABASE_URL"] },
    { flags: "--output <path>", description: "Snapshot file shared with the backend.", env: ["STATISTICS_FILE"], default: DEFAULT_STATISTICS_FILE },
    { flags: "--interval-ms <ms>", description: "Pause after each sweep (default 300000).", env: ["STATISTICS_INTERVAL_MS"], default: String(DEFAULT_STATISTICS_INTERVAL_MS) },
    { flags: "--statement-timeout-ms <ms>", description: "Timeout per database query (default 120000).", env: ["STATISTICS_STATEMENT_TIMEOUT_MS"], default: "120000" },
    { flags: "--once", description: "Write one snapshot, print its JSON and exit. Failures exit nonzero." },
  ],
};

export function parseStatisticsConfig(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const cli = parseCli(SPEC, args, env);
  if (cli.helpRequested) throw new CliHelpRequested(cli.helpText);
  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) throw new Error("DATABASE_URL (or --database-url) is required");
  return {
    databaseUrl,
    output: cli.value("output") || DEFAULT_STATISTICS_FILE,
    intervalMs: coercePositiveInt("--interval-ms", cli.value("interval-ms") || String(DEFAULT_STATISTICS_INTERVAL_MS)),
    statementTimeoutMs: coercePositiveInt("--statement-timeout-ms", cli.value("statement-timeout-ms") || "120000"),
    once: cli.flag("once"),
  };
}

async function main(): Promise<void> {
  const config = parseStatisticsConfig(process.argv.slice(2));
  // Deliberately do not open ScannerStorage: its startup runs schema migrations.
  const db = openDb(config.databaseUrl, { max: 1 });
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    while (!stop.signal.aborted) {
      const started = Date.now();
      try {
        const snapshot = await gatherIndexerStatistics(db, config);
        snapshot.refreshIntervalMs = Math.max(config.intervalMs, snapshot.durationMs * 4);
        await writeStatisticsFile(config.output, snapshot);
        if (config.once) {
          console.log(JSON.stringify(snapshot, null, 2));
          return;
        }
        console.log(`Statistics gathered at ${snapshot.gatheredAtUtc}: blocks=${snapshot.blocks.indexed} transactions=${snapshot.transactions.indexed} elapsed_ms=${snapshot.durationMs}`);
      } catch (error) {
        if (config.once) throw error;
        // Avoid logging database URLs, SQL parameters or stored attribute values.
        console.error("Statistics sweep failed; keeping the previous snapshot and retrying.");
      }
      // A costly sweep gets breathing room; never overlap sweeps or monopolize the DB.
      const waitMs = Math.max(config.intervalMs, (Date.now() - started) * 4);
      await delay(waitMs, undefined, { signal: stop.signal }).catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await db.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof CliHelpRequested) console.log(error.message);
    else {
      console.error("Statistics worker failed. Check database availability, schema and worker configuration.");
      process.exitCode = 1;
    }
  }
}
