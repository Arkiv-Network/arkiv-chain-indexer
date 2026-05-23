export interface ScannerConfig {
  rpcUrl: string;
  databaseUrl: string;
  fromBlock?: bigint;
  toBlock?: bigint;
  oldestBackfillBlock: bigint;
  confirmationDepth: bigint;
  pollMs: number;
  retryMs: number;
  txReceiptConcurrency: number;
  saveTransactionData: boolean;
  disableBackfill: boolean;
  batcherCollectorUrl?: string;
}

const DEFAULT_CONFIRMATION_DEPTH = 3n;
const DEFAULT_OLDEST_BACKFILL_BLOCK = 25_000_000n;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_TX_RECEIPT_CONCURRENCY = 20;

export function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): ScannerConfig {
  const parsed = parseArgs(args);

  if (parsed.help) {
    throw new HelpRequested(usage());
  }

  const rpcUrl = env.SCANNER_RPC_FULL_NODE;
  if (!rpcUrl) {
    throw new Error("SCANNER_RPC_FULL_NODE is required");
  }

  const databaseUrl =
    parsed.values["database-url"] ?? env.DATABASE_URL ?? env.SCANNER_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const fromBlockRaw = parsed.values["from-block"] ?? parsed.values.from ?? env.SCANNER_FROM_BLOCK;
  const toBlockRaw = parsed.values["to-block"] ?? env.SCANNER_TO_BLOCK;
  if (toBlockRaw && !fromBlockRaw) {
    throw new Error("--from-block is required when --to-block is set");
  }
  const batcherCollectorUrl =
    parsed.values["batcher-collector-url"] ?? env.BATCHER_COLLECTOR_URL ?? env.SCANNER_BATCHER_COLLECTOR_URL;

  return {
    rpcUrl,
    databaseUrl,
    ...(fromBlockRaw ? { fromBlock: parseBigIntOption("--from-block", fromBlockRaw) } : {}),
    ...(toBlockRaw
      ? { toBlock: parseBigIntOption("--to-block", toBlockRaw) }
      : {}),
    oldestBackfillBlock: parseBigIntOption(
      "--oldest-backfill-block",
      parsed.values["oldest-backfill-block"] ??
        env.SCANNER_OLDEST_BACKFILL_BLOCK ??
        DEFAULT_OLDEST_BACKFILL_BLOCK.toString(),
    ),
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
    txReceiptConcurrency: parsePositiveNumberOption(
      "--tx-receipt-concurrency",
      parsed.values["tx-receipt-concurrency"] ??
        env.SCANNER_TX_RECEIPT_CONCURRENCY ??
        DEFAULT_TX_RECEIPT_CONCURRENCY.toString(),
    ),
    saveTransactionData: parseBooleanOption(
      "--save-transaction-data",
      parsed.values["save-transaction-data"] ??
        env.SCANNER_SAVE_TRANSACTION_DATA ??
        env.SAVE_TRANSACTION_DATA ??
        "true",
    ),
    disableBackfill: parseBooleanOption(
      "--disable-backfill",
      parsed.values["disable-backfill"] ??
        env.SCANNER_DISABLE_BACKFILL ??
        "false",
    ),
    ...(batcherCollectorUrl ? { batcherCollectorUrl } : {}),
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

function parsePositiveNumberOption(name: string, value: string): number {
  const parsed = parseNumberOption(name, value);
  if (parsed === 0) {
    throw new Error(`${name} must be greater than zero`);
  }

  return parsed;
}

function parseBooleanOption(name: string, value: string): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

function usage(): string {
  return `Usage:
  SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \\
    DATABASE_URL=postgres://user:pass@host:5432/db \\
    bun run scan

Options:
  --database-url <url>              PostgreSQL connection string (or DATABASE_URL env).
  --from-block <number>             First block for bounded --to-block scans.
  --to-block <number>               Optional inclusive block to stop at.
  --oldest-backfill-block <number>  Oldest block to backfill to. Defaults to 25000000.
  --confirmation-depth <number>     Blocks to stay behind latest head. Defaults to 3.
  --poll-ms <number>                Delay while waiting for new safe blocks. Defaults to 2000.
  --retry-ms <number>               Delay before retrying a failed block. Defaults to 5000.
  --tx-receipt-concurrency <n>      Legacy setting accepted for compatibility; receipts are fetched sequentially.
  --save-transaction-data <bool>    Store inspected transaction rows. Defaults to true (or SCANNER_SAVE_TRANSACTION_DATA / SAVE_TRANSACTION_DATA).
  --disable-backfill <bool>         Skip the historical backfill phase and only scan forward from the safe head. Defaults to false.
  --batcher-collector-url <url>     Optional BATCHER_COLLECTOR_URL base for recent block batcher metrics.
  --help                            Show this message.`;
}
