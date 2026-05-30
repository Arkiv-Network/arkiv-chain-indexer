import { CliHelpRequested, coercePositiveInt, parseCli, type CliSpec } from "./cli";
import { HttpBatcherCollector } from "./batcher";
import { fillRecentMissingBatcherMetrics } from "./scanner";
import { ScannerStorage } from "./storage";
import type { BatcherMetricsSource } from "./batcher";

export interface BatcherCollectorConfig {
  databaseUrl: string;
  batcherCollectorUrl: string;
  intervalMs: number;
  once: boolean;
}

export interface BatcherCollectorRuntime {
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

const DEFAULT_INTERVAL_MS = 10_000;

const defaultRuntime: BatcherCollectorRuntime = {
  sleep,
  log: (message) => console.log(message),
};

/** Help text raised when the batcher collector is invoked with `--help`. */
export class HelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "collect-batcher",
  summary: `DATABASE_URL=postgres://user:pass@host:5432/db \\
  BATCHER_COLLECTOR_URL=https://batcher-collector.example \\
  bun run collect-batcher`,
  options: [
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--batcher-collector-url <url>",
      description: "BATCHER_COLLECTOR_URL base for recent block batcher metrics.",
      env: ["BATCHER_COLLECTOR_URL", "SCANNER_BATCHER_COLLECTOR_URL"],
    },
    {
      flags: "--interval-ms <number>",
      description: "Delay between collector sweeps. Defaults to 10000.",
      env: ["BATCHER_COLLECTOR_INTERVAL_MS"],
      default: DEFAULT_INTERVAL_MS.toString(),
    },
    { flags: "--once", description: "Run one collector sweep and exit." },
  ],
};

export function parseBatcherCollectorConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): BatcherCollectorConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new HelpRequested(cli.helpText);
  }

  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const batcherCollectorUrl = cli.value("batcher-collector-url");
  if (!batcherCollectorUrl) {
    throw new Error("BATCHER_COLLECTOR_URL (or --batcher-collector-url) is required");
  }

  return {
    databaseUrl,
    batcherCollectorUrl,
    intervalMs: coercePositiveInt("--interval-ms", cli.value("interval-ms")!),
    once: cli.flag("once"),
  };
}

export async function runBatcherCollector(
  config: BatcherCollectorConfig,
  storage: Pick<ScannerStorage, "queryRecentBlocksMissingBatcherMetrics" | "saveBatcherMetricsForBlock">,
  collector: BatcherMetricsSource = new HttpBatcherCollector(config.batcherCollectorUrl),
  runtime: BatcherCollectorRuntime = defaultRuntime,
): Promise<void> {
  runtime.log(`Batcher collector worker started for ${config.batcherCollectorUrl}`);

  while (true) {
    const updated = await fillRecentMissingBatcherMetrics(storage as ScannerStorage, collector);
    runtime.log(`Batcher collector worker updated ${updated.toString()} block(s)`);

    if (config.once) {
      return;
    }

    await runtime.sleep(config.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;

  try {
    const config = parseBatcherCollectorConfig();
    storage = await ScannerStorage.open(config.databaseUrl);
    await runBatcherCollector(config, storage);
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }

    console.error(error);
    process.exitCode = 1;
  } finally {
    await storage?.close();
  }
}

if (import.meta.main) {
  await main();
}
