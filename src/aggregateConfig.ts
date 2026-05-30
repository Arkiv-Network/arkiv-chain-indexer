import { CliHelpRequested, coerceBigInt, parseCli, type CliSpec } from "./cli";
import { SUPPORTED_RANGE_SIZES, parseRangeSize } from "./ranges";

export interface AggregateConfig {
  databaseUrl: string;
  rangeSize: bigint;
  fromBlock?: bigint;
  toBlock?: bigint;
}

/** Help text raised when the aggregator is invoked with `--help`. */
export class AggregateHelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "aggregate",
  summary: `DATABASE_URL=postgres://user:pass@host:5432/db bun run aggregate -- --range <size>

Aggregates already-scanned blocks into fixed-size windows and writes them to the
block_ranges table. Windows are [k*M, k*M + M - 1] where M is the range size.
Only windows whose blocks are all present in the blocks table are written.`,
  options: [
    {
      flags: "--range <size>",
      description: `Window size. One of: ${SUPPORTED_RANGE_SIZES.map((value) => value.toString()).join(", ")}.`,
      env: ["AGGREGATE_RANGE"],
    },
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--from-block <number>",
      description: "Optional lower bound. Only windows whose end >= from-block are considered.",
      env: ["AGGREGATE_FROM_BLOCK"],
    },
    {
      flags: "--to-block <number>",
      description: "Optional upper bound. Only windows whose start <= to-block are considered.",
      env: ["AGGREGATE_TO_BLOCK"],
    },
  ],
};

export function parseAggregateConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): AggregateConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new AggregateHelpRequested(cli.helpText);
  }

  const rangeRaw = cli.value("range");
  if (!rangeRaw) {
    throw new Error(
      "--range is required (one of: " +
        SUPPORTED_RANGE_SIZES.map((value) => value.toString()).join(", ") +
        ")",
    );
  }
  const rangeSize = parseRangeSize(rangeRaw);

  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const fromBlockRaw = cli.value("from-block");
  const toBlockRaw = cli.value("to-block");

  return {
    databaseUrl,
    rangeSize,
    ...(fromBlockRaw ? { fromBlock: coerceBigInt("--from-block", fromBlockRaw) } : {}),
    ...(toBlockRaw ? { toBlock: coerceBigInt("--to-block", toBlockRaw) } : {}),
  };
}
