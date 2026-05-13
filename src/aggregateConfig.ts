import { SUPPORTED_RANGE_SIZES, parseRangeSize } from "./ranges";

export interface AggregateConfig {
  dbPath: string;
  rangeSize: bigint;
  fromBlock?: bigint;
  toBlock?: bigint;
}

const DEFAULT_DB_PATH = "scanner.sqlite";

export class AggregateHelpRequested extends Error {}

export function parseAggregateConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): AggregateConfig {
  const parsed = parseArgs(args);

  if (parsed.help) {
    throw new AggregateHelpRequested(usage());
  }

  const rangeRaw = parsed.values.range ?? env.AGGREGATE_RANGE;
  if (!rangeRaw) {
    throw new Error("--range is required (one of: " +
      SUPPORTED_RANGE_SIZES.map((value) => value.toString()).join(", ") + ")");
  }
  const rangeSize = parseRangeSize(rangeRaw);

  const dbPath = parsed.values.db ?? env.SCANNER_DB_PATH ?? DEFAULT_DB_PATH;

  const fromBlockRaw = parsed.values["from-block"] ?? env.AGGREGATE_FROM_BLOCK;
  const toBlockRaw = parsed.values["to-block"] ?? env.AGGREGATE_TO_BLOCK;

  return {
    dbPath,
    rangeSize,
    ...(fromBlockRaw ? { fromBlock: parseBigIntOption("--from-block", fromBlockRaw) } : {}),
    ...(toBlockRaw ? { toBlock: parseBigIntOption("--to-block", toBlockRaw) } : {}),
  };
}

interface ParsedArgs {
  help: boolean;
  values: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, values: {} };

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

function parseBigIntOption(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(value);
}

function usage(): string {
  const sizes = SUPPORTED_RANGE_SIZES.map((value) => value.toString()).join(", ");
  return `Usage:
  bun run aggregate -- --range <size>

Aggregates already-scanned blocks into fixed-size windows and writes them to the
block_ranges table. Windows are [k*M, k*M + M - 1] where M is the range size.
Only windows whose blocks are all present in the blocks table are written.

Options:
  --range <size>            Window size. One of: ${sizes}.
  --db <path>               SQLite database path. Defaults to scanner.sqlite (or SCANNER_DB_PATH).
  --from-block <number>     Optional lower bound. Only windows whose end >= from-block are considered.
  --to-block <number>       Optional upper bound. Only windows whose start <= to-block are considered.
  --help                    Show this message.`;
}
