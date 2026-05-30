import { CliHelpRequested, coerceInt, parseCli, type CliSpec } from "./cli";
import { aggregateRanges } from "./aggregator";
import { SUPPORTED_RANGE_SIZES } from "./ranges";
import { ScannerStorage } from "./storage";

const DEFAULT_INTERVAL_MS = 30_000;

interface AggregateAllConfig {
  databaseUrl: string;
  intervalMs: number;
  once: boolean;
}

class HelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "aggregate-all",
  summary: `DATABASE_URL=postgres://... bun run aggregate-all

Periodically aggregates every supported range size (2, 5, 10, 20, 50, 100, 200, 500, 1000).`,
  options: [
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--interval-ms <number>",
      description: "Sleep after each full sweep. Defaults to 30000.",
      env: ["AGGREGATE_INTERVAL_MS"],
      default: DEFAULT_INTERVAL_MS.toString(),
    },
    { flags: "--once", description: "Run a single sweep then exit." },
  ],
};

function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): AggregateAllConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new HelpRequested(cli.helpText);
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

async function runSweep(storage: ScannerStorage): Promise<void> {
  for (const rangeSize of SUPPORTED_RANGE_SIZES) {
    const startedAt = Date.now();
    const result = await aggregateRanges(storage, {
      rangeSize,
      skipCompleted: true,
      stopAfterIncomplete: true,
    });
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `range_size=${rangeSize.toString()} written=${result.written} incomplete=${result.incomplete} skipped_complete=${result.skippedComplete} elapsed_ms=${elapsedMs}`,
    );
  }
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

    console.log(
      `Aggregator loop starting (interval=${config.intervalMs}ms, sizes=${SUPPORTED_RANGE_SIZES.map(
        (value) => value.toString(),
      ).join(",")})`,
    );

    while (!stopping) {
      try {
        await runSweep(storage);
      } catch (error) {
        console.error("Sweep failed:", error);
      }
      if (config.once || stopping) break;

      await sleep(config.intervalMs);
    }
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

await main();
