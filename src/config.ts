export interface ScannerConfig {
  rpcUrl: string;
  dbPath: string;
  fromBlock: bigint;
  toBlock?: bigint;
  confirmationDepth: bigint;
  pollMs: number;
  retryMs: number;
}

const DEFAULT_DB_PATH = "scanner.sqlite";
const DEFAULT_CONFIRMATION_DEPTH = 3n;
const DEFAULT_POLL_MS = 12_000;
const DEFAULT_RETRY_MS = 5_000;

export function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): ScannerConfig {
  const parsed = parseArgs(args);

  if (parsed.help) {
    throw new HelpRequested(usage());
  }

  const rpcUrl = env.SCANNER_RPC_FULL_NODE;
  if (!rpcUrl) {
    throw new Error("SCANNER_RPC_FULL_NODE is required");
  }

  const fromBlockRaw = parsed.values["from-block"] ?? parsed.values.from ?? env.SCANNER_FROM_BLOCK;
  if (!fromBlockRaw) {
    throw new Error("--from-block is required");
  }

  const toBlockRaw = parsed.values["to-block"] ?? env.SCANNER_TO_BLOCK;

  return {
    rpcUrl,
    dbPath: parsed.values.db ?? env.SCANNER_DB_PATH ?? DEFAULT_DB_PATH,
    fromBlock: parseBigIntOption("--from-block", fromBlockRaw),
    ...(toBlockRaw
      ? { toBlock: parseBigIntOption("--to-block", toBlockRaw) }
      : {}),
    confirmationDepth: parseBigIntOption(
      "--confirmation-depth",
      parsed.values["confirmation-depth"] ?? env.SCANNER_CONFIRMATION_DEPTH ?? DEFAULT_CONFIRMATION_DEPTH.toString(),
    ),
    pollMs: parseNumberOption(
      "--poll-ms",
      parsed.values["poll-ms"] ?? env.SCANNER_POLL_MS ?? DEFAULT_POLL_MS.toString(),
    ),
    retryMs: parseNumberOption(
      "--retry-ms",
      parsed.values["retry-ms"] ?? env.SCANNER_RETRY_MS ?? DEFAULT_RETRY_MS.toString(),
    ),
  };
}

export class HelpRequested extends Error {}

interface ParsedArgs {
  help: boolean;
  values: Record<string, string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
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

function parseBigIntOption(name: string, value: string | undefined): bigint {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return BigInt(value);
}

function parseNumberOption(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is too large`);
  }

  return parsed;
}

function usage(): string {
  return `Usage:
  SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ bun run scan -- --from-block 19000000

Options:
  --from-block <number>          First block to scan when no prior progress exists.
  --to-block <number>            Optional inclusive block to stop at.
  --db <path>                    SQLite database path. Defaults to scanner.sqlite.
  --confirmation-depth <number>  Blocks to stay behind latest head. Defaults to 3.
  --poll-ms <number>             Delay while waiting for new safe blocks. Defaults to 12000.
  --retry-ms <number>            Delay before retrying a failed block. Defaults to 5000.
  --help                         Show this message.`;
}
