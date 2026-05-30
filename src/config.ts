import {
  CliHelpRequested,
  coerceBigInt,
  coerceBoolean,
  coerceInt,
  coercePositiveInt,
  parseCli,
  type CliSpec,
} from "./cli";

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
  backfillOnly: boolean;
  backfillSleepMs: number;
  batcherCollectorUrl?: string;
}

const DEFAULT_CONFIRMATION_DEPTH = 3n;
const DEFAULT_OLDEST_BACKFILL_BLOCK = 25_000_000n;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_TX_RECEIPT_CONCURRENCY = 20;
const DEFAULT_BACKFILL_SLEEP_MS = 100;

/** Help text raised when the scanner is invoked with `--help`. */
export class HelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "scan",
  summary: `SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \\
  DATABASE_URL=postgres://user:pass@host:5432/db \\
  bun run scan`,
  options: [
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--from-block <number>",
      description: "First block for bounded --to-block scans.",
    },
    { flags: "--from <number>", description: "Alias for --from-block.", hidden: true },
    {
      flags: "--to-block <number>",
      description: "Optional inclusive block to stop at.",
      env: ["SCANNER_TO_BLOCK"],
    },
    {
      flags: "--oldest-backfill-block <number>",
      description: "Oldest block to backfill to. Defaults to 25000000.",
      env: ["SCANNER_OLDEST_BACKFILL_BLOCK"],
      default: DEFAULT_OLDEST_BACKFILL_BLOCK.toString(),
    },
    {
      flags: "--confirmation-depth <number>",
      description: "Blocks to stay behind latest head. Defaults to 3.",
      env: ["SCANNER_CONFIRMATION_DEPTH"],
      default: DEFAULT_CONFIRMATION_DEPTH.toString(),
    },
    {
      flags: "--poll-ms <number>",
      description: "Delay while waiting for new safe blocks. Defaults to 2000.",
      env: ["SCANNER_POLL_MS"],
      default: DEFAULT_POLL_MS.toString(),
    },
    {
      flags: "--retry-ms <number>",
      description: "Delay before retrying a failed block. Defaults to 5000.",
      env: ["SCANNER_RETRY_MS"],
      default: DEFAULT_RETRY_MS.toString(),
    },
    {
      flags: "--tx-receipt-concurrency <n>",
      description:
        "Legacy setting accepted for compatibility; receipts are fetched sequentially.",
      env: ["SCANNER_TX_RECEIPT_CONCURRENCY"],
      default: DEFAULT_TX_RECEIPT_CONCURRENCY.toString(),
    },
    {
      flags: "--save-transaction-data <bool>",
      description:
        "Store inspected transaction rows. Defaults to true (or SCANNER_SAVE_TRANSACTION_DATA / SAVE_TRANSACTION_DATA).",
      env: ["SCANNER_SAVE_TRANSACTION_DATA", "SAVE_TRANSACTION_DATA"],
      default: "true",
    },
    {
      flags: "--disable-backfill <bool>",
      description:
        "Skip the historical backfill phase and only scan forward from the safe head. Defaults to false.",
      env: ["SCANNER_DISABLE_BACKFILL"],
      default: "false",
    },
    {
      flags: "--backfill-only <bool>",
      description: "Only run the historical backfill loop in continuous mode. Defaults to false.",
      env: ["SCANNER_BACKFILL_ONLY"],
      default: "false",
    },
    {
      flags: "--backfill-sleep-ms <number>",
      description: "Delay after each successful backfill block. Defaults to 100.",
      env: ["SCANNER_BACKFILL_SLEEP_MS"],
      default: DEFAULT_BACKFILL_SLEEP_MS.toString(),
    },
    {
      flags: "--batcher-collector-url <url>",
      description: "Optional BATCHER_COLLECTOR_URL base for recent block batcher metrics.",
      env: ["BATCHER_COLLECTOR_URL", "SCANNER_BATCHER_COLLECTOR_URL"],
    },
  ],
};

export function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): ScannerConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new HelpRequested(cli.helpText);
  }

  const rpcUrl = env.SCANNER_RPC_FULL_NODE;
  if (!rpcUrl) {
    throw new Error("SCANNER_RPC_FULL_NODE is required");
  }

  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  const fromBlockRaw = cli.value("from-block") ?? cli.value("from") ?? env.SCANNER_FROM_BLOCK;
  const toBlockRaw = cli.value("to-block");
  if (toBlockRaw && !fromBlockRaw) {
    throw new Error("--from-block is required when --to-block is set");
  }

  const disableBackfill = coerceBoolean("--disable-backfill", cli.value("disable-backfill")!);
  const backfillOnly = coerceBoolean("--backfill-only", cli.value("backfill-only")!);
  if (disableBackfill && backfillOnly) {
    throw new Error("--backfill-only cannot be combined with --disable-backfill");
  }

  const batcherCollectorUrl = cli.value("batcher-collector-url");

  return {
    rpcUrl,
    databaseUrl,
    ...(fromBlockRaw ? { fromBlock: coerceBigInt("--from-block", fromBlockRaw) } : {}),
    ...(toBlockRaw ? { toBlock: coerceBigInt("--to-block", toBlockRaw) } : {}),
    oldestBackfillBlock: coerceBigInt("--oldest-backfill-block", cli.value("oldest-backfill-block")!),
    confirmationDepth: coerceBigInt("--confirmation-depth", cli.value("confirmation-depth")!),
    pollMs: coerceInt("--poll-ms", cli.value("poll-ms")!),
    retryMs: coerceInt("--retry-ms", cli.value("retry-ms")!),
    txReceiptConcurrency: coercePositiveInt(
      "--tx-receipt-concurrency",
      cli.value("tx-receipt-concurrency")!,
    ),
    saveTransactionData: coerceBoolean("--save-transaction-data", cli.value("save-transaction-data")!),
    disableBackfill,
    backfillOnly,
    backfillSleepMs: coerceInt("--backfill-sleep-ms", cli.value("backfill-sleep-ms")!),
    ...(batcherCollectorUrl ? { batcherCollectorUrl } : {}),
  };
}
