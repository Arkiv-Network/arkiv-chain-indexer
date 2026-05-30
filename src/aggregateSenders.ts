import { CliHelpRequested, coerceInt, parseCli, type CliSpec } from "./cli";
import { ScannerStorage } from "./storage";

const DEFAULT_INTERVAL_MS = 60_000;

interface AggregateSendersConfig {
  databaseUrl: string;
  intervalMs: number;
  once: boolean;
}

class SenderAggregateHelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "aggregate-senders",
  summary: `DATABASE_URL=postgres://... bun run aggregate-senders

Rebuilds the sender_stats table from stored transaction rows.`,
  options: [
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--interval-ms <number>",
      description: "Sleep between rebuilds. Defaults to 60000.",
      env: ["SENDER_AGGREGATE_INTERVAL_MS"],
      default: DEFAULT_INTERVAL_MS.toString(),
    },
    { flags: "--once", description: "Run a single rebuild then exit." },
  ],
};

function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): AggregateSendersConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new SenderAggregateHelpRequested(cli.helpText);
  }

  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  return {
    databaseUrl,
    intervalMs: coerceInt("--interval-ms", cli.value("interval-ms")!),
    once: cli.flag("once"),
  };
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
