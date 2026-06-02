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

function formatDate(date: string | undefined): string {
  return date !== undefined && date.length > 0 ? date : "?";
}

async function runSweep(storage: ScannerStorage): Promise<void> {
  const bounds = await storage.getStoredBlockBounds();
  if (!bounds) {
    console.log("sweep: no blocks stored yet — nothing to aggregate");
    return;
  }

  console.log(
    `sweep start: stored blocks ${bounds.minBlock.toString()} (${formatDate(bounds.minBlockDate)})` +
      ` .. ${bounds.maxBlock.toString()} (${formatDate(bounds.maxBlockDate)})`,
  );

  for (const rangeSize of SUPPORTED_RANGE_SIZES) {
    const startedAt = Date.now();
    const result = await aggregateRanges(storage, {
      rangeSize,
      skipCompleted: true,
      stopAfterIncomplete: true,
    });
    const elapsedMs = Date.now() - startedAt;

    const latestComplete = await storage.getLatestCompleteBlockRange(rangeSize);
    const lastCompleteText = latestComplete
      ? `${latestComplete.rangeStart.toString()}..${latestComplete.rangeEnd.toString()}` +
        ` (${formatDate(latestComplete.maxBlockDate)})`
      : "none";

    let nextRangeText = "none";
    if (result.incomplete > 0 && result.processedLastRangeStart !== undefined) {
      const coverage = await storage.getRangeBlockCoverage(result.processedLastRangeStart, rangeSize);
      const latestInRange =
        coverage.latestBlock !== undefined
          ? `${coverage.latestBlock.toString()} (${formatDate(coverage.latestBlockDate)})`
          : "none";
      const firstMissing =
        coverage.firstMissingBlock !== undefined ? coverage.firstMissingBlock.toString() : "none";
      // Classify why this range is stuck. A range only completes once every block in it is stored, so
      // the sweep parks on the first incomplete one. Split its missing blocks into three buckets:
      //   below_min — blocks before the earliest stored block. They predate our data and will never
      //               arrive, so the range can never complete. Aggregation skips these prefix ranges,
      //               but keep the label defensive for explicit bounds or future call paths.
      //   head_gap  — blocks past the latest stored block; we are simply waiting for the indexer.
      //   internal  — a genuine hole inside [minBlock, maxBlock]; first_missing names the block to
      //               backfill.
      const missing = coverage.blocksExpected - coverage.blocksPresent;
      const belowMin =
        coverage.rangeStart < bounds.minBlock ? Number(bounds.minBlock - coverage.rangeStart) : 0;
      const headGap =
        coverage.rangeEnd > bounds.maxBlock ? Number(coverage.rangeEnd - bounds.maxBlock) : 0;
      const internalMissing = Math.max(0, missing - belowMin - headGap);
      const reason =
        internalMissing > 0
          ? "internal_gap"
          : belowMin > 0
            ? "below_min"
            : headGap > 0
              ? "awaiting_head"
              : "unknown";
      nextRangeText =
        `${coverage.rangeStart.toString()}..${coverage.rangeEnd.toString()}` +
        ` present=${coverage.blocksPresent.toString()}/${coverage.blocksExpected.toString()}` +
        ` first_missing=${firstMissing}` +
        ` latest_in_range=${latestInRange}` +
        ` below_min=${belowMin.toString()} head_gap=${headGap.toString()} reason=${reason}`;
    }

    console.log(
      `range_size=${rangeSize.toString()} written=${result.written} incomplete=${result.incomplete}` +
        ` skipped_complete=${result.skippedComplete} elapsed_ms=${elapsedMs}` +
        ` last_complete_range=${lastCompleteText} next_range=${nextRangeText}`,
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
