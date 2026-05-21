import { ScannerStorage } from "./storage";

const DEFAULT_INTERVAL_MS = 60_000;

interface AggregateSendersConfig {
  databaseUrl: string;
  intervalMs: number;
  once: boolean;
}

class SenderAggregateHelpRequested extends Error {}

function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): AggregateSendersConfig {
  const values: Record<string, string> = {};
  let help = false;
  let once = false;

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
      help = true;
      continue;
    }
    if (rawKey === "once") {
      once = true;
      continue;
    }

    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    values[rawKey] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  if (help) {
    throw new SenderAggregateHelpRequested(usage());
  }

  const databaseUrl = values["database-url"] ?? env.DATABASE_URL ?? env.SCANNER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const intervalRaw = values["interval-ms"] ?? env.SENDER_AGGREGATE_INTERVAL_MS;
  const intervalMs =
    intervalRaw === undefined ? DEFAULT_INTERVAL_MS : parsePositiveInt("--interval-ms", intervalRaw);

  return { databaseUrl, intervalMs, once };
}

function parsePositiveInt(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is too large`);
  }
  return parsed;
}

function usage(): string {
  return `Usage:
  DATABASE_URL=postgres://... bun run aggregate-senders

Rebuilds the sender_stats table from stored transaction rows.

Options:
  --database-url <url>     PostgreSQL connection string (or DATABASE_URL env).
  --interval-ms <number>   Sleep between rebuilds. Defaults to 60000.
  --once                   Run a single rebuild then exit.
  --help                   Show this message.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let storage: ScannerStorage | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    const config = parseConfig(process.argv.slice(2));
    storage = await ScannerStorage.open(config.databaseUrl);

    console.log(`Sender aggregator starting (interval=${config.intervalMs}ms)`);

    while (!stopping) {
      const startedAt = Date.now();
      try {
        const senders = await storage.aggregateSenderStats();
        console.log(`sender_stats=${senders} elapsed_ms=${Date.now() - startedAt}`);
      } catch (error) {
        console.error("Sender aggregation failed:", error);
      }

      if (config.once || stopping) break;
      const wait = Math.max(0, config.intervalMs - (Date.now() - startedAt));
      if (wait > 0) {
        await sleep(wait);
      }
    }
  } catch (error) {
    if (error instanceof SenderAggregateHelpRequested) {
      console.log(error.message);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  } finally {
    await storage?.close();
  }
}

await main();
