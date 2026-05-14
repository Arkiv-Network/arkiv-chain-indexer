import { aggregateRanges } from "./aggregator";
import { SUPPORTED_RANGE_SIZES } from "./ranges";
import { ScannerStorage } from "./storage";

const DEFAULT_INTERVAL_MS = 60_000;

interface AggregateAllConfig {
  databaseUrl: string;
  intervalMs: number;
  once: boolean;
}

class HelpRequested extends Error {}

function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): AggregateAllConfig {
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
    throw new HelpRequested(usage());
  }

  const databaseUrl =
    values["database-url"] ?? env.DATABASE_URL ?? env.SCANNER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const intervalRaw = values["interval-ms"] ?? env.AGGREGATE_INTERVAL_MS;
  const intervalMs = intervalRaw === undefined ? DEFAULT_INTERVAL_MS : parsePositiveInt("--interval-ms", intervalRaw);

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
  DATABASE_URL=postgres://... bun run aggregate-all

Periodically aggregates every supported range size (2, 5, 10, 20, 50, 100, 200, 500, 1000).

Options:
  --database-url <url>     PostgreSQL connection string (or DATABASE_URL env).
  --interval-ms <number>   Sleep between full sweeps. Defaults to 60000.
  --once                   Run a single sweep then exit.
  --help                   Show this message.`;
}

async function runSweep(storage: ScannerStorage): Promise<void> {
  for (const rangeSize of SUPPORTED_RANGE_SIZES) {
    const startedAt = Date.now();
    const result = await aggregateRanges(storage, { rangeSize });
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `range_size=${rangeSize.toString()} written=${result.written} incomplete=${result.incomplete} elapsed_ms=${elapsedMs}`,
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
      const sweepStart = Date.now();
      try {
        await runSweep(storage);
      } catch (error) {
        console.error("Sweep failed:", error);
      }
      if (config.once || stopping) break;

      const elapsed = Date.now() - sweepStart;
      const wait = Math.max(0, config.intervalMs - elapsed);
      if (wait > 0) {
        await sleep(wait);
      }
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
