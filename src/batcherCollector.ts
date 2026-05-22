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

export function parseBatcherCollectorConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): BatcherCollectorConfig {
  const parsed = parseArgs(args);

  if (parsed.help) {
    throw new HelpRequested(usage());
  }

  const databaseUrl = parsed.values["database-url"] ?? env.DATABASE_URL ?? env.SCANNER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const batcherCollectorUrl =
    parsed.values["batcher-collector-url"] ?? env.BATCHER_COLLECTOR_URL ?? env.SCANNER_BATCHER_COLLECTOR_URL;
  if (!batcherCollectorUrl) {
    throw new Error("BATCHER_COLLECTOR_URL (or --batcher-collector-url) is required");
  }

  return {
    databaseUrl,
    batcherCollectorUrl,
    intervalMs: parsePositiveNumberOption(
      "--interval-ms",
      parsed.values["interval-ms"] ??
        env.BATCHER_COLLECTOR_INTERVAL_MS ??
        DEFAULT_INTERVAL_MS.toString(),
    ),
    once: parsed.once,
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

export class HelpRequested extends Error {}

interface ParsedArgs {
  help: boolean;
  once: boolean;
  values: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
    once: false,
    values: {},
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) {
      throw new Error(`Invalid argument: ${arg}`);
    }

    if (rawKey === "help") {
      result.help = true;
      continue;
    }

    if (rawKey === "once") {
      result.once = true;
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }

    result.values[rawKey] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return result;
}

function parsePositiveNumberOption(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is too large`);
  }

  if (parsed === 0) {
    throw new Error(`${name} must be greater than zero`);
  }

  return parsed;
}

function usage(): string {
  return `Usage:
  DATABASE_URL=postgres://user:pass@host:5432/db \\
    BATCHER_COLLECTOR_URL=https://batcher-collector.example \\
    bun run collect-batcher

Options:
  --database-url <url>           PostgreSQL connection string (or DATABASE_URL env).
  --batcher-collector-url <url>  BATCHER_COLLECTOR_URL base for recent block batcher metrics.
  --interval-ms <number>         Delay between collector sweeps. Defaults to 10000.
  --once                         Run one collector sweep and exit.
  --help                         Show this message.`;
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
