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
  oldestBackfillBlock: bigint;
  confirmationDepth: bigint;
  pollMs: number;
  retryMs: number;
  txReceiptConcurrency: number;
  saveTransactionData: boolean;
  trackBalances: boolean;
  disableBackfill: boolean;
  backfillOnly: boolean;
  backfillSleepMs: number;
  batcherCollectorUrl?: string;
  redisUrl?: string;
  decoderUrl?: string;
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
        "Max concurrent eth_getTransactionReceipt requests per block. Higher values keep " +
        "up with heavy blocks but spend more of the RPC rate-limit budget.",
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
      flags: "--track-balances <bool>",
      description:
        "Record each block's sender/recipient balances by reading them from the node (one batched eth_getBalance per block). Feeds eth_getBalance and GET /balances. Defaults to false (or SCANNER_TRACK_BALANCES).",
      env: ["SCANNER_TRACK_BALANCES"],
      default: "false",
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
    {
      flags: "--redis-url <url>",
      description:
        "Optional Redis connection string. When set, recent senders are tracked for the guzzlers API.",
      env: ["REDIS_URL", "SCANNER_REDIS_URL"],
    },
    {
      flags: "--decoder-url <url>",
      description:
        "Optional arkiv-transaction-decoder base URL. When set (and transaction rows are stored), Arkiv registry transactions are decoded and operation metadata (no payload) is stored.",
      env: ["DECODER_URL", "SCANNER_DECODER_URL"],
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

  const disableBackfill = coerceBoolean("--disable-backfill", cli.value("disable-backfill")!);
  const backfillOnly = coerceBoolean("--backfill-only", cli.value("backfill-only")!);

  const batcherCollectorUrl = cli.value("batcher-collector-url");
  const redisUrl = cli.value("redis-url");
  const decoderUrl = cli.value("decoder-url");

  return {
    rpcUrl,
    databaseUrl,
    oldestBackfillBlock: coerceBigInt("--oldest-backfill-block", cli.value("oldest-backfill-block")!),
    confirmationDepth: coerceBigInt("--confirmation-depth", cli.value("confirmation-depth")!),
    pollMs: coerceInt("--poll-ms", cli.value("poll-ms")!),
    retryMs: coerceInt("--retry-ms", cli.value("retry-ms")!),
    txReceiptConcurrency: coercePositiveInt(
      "--tx-receipt-concurrency",
      cli.value("tx-receipt-concurrency")!,
    ),
    saveTransactionData: coerceBoolean("--save-transaction-data", cli.value("save-transaction-data")!),
    trackBalances: coerceBoolean("--track-balances", cli.value("track-balances")!),
    disableBackfill,
    backfillOnly,
    backfillSleepMs: coerceInt("--backfill-sleep-ms", cli.value("backfill-sleep-ms")!),
    ...(batcherCollectorUrl ? { batcherCollectorUrl } : {}),
    ...(redisUrl ? { redisUrl } : {}),
    ...(decoderUrl ? { decoderUrl } : {}),
  };
}
