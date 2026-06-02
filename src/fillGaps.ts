import {
  CliHelpRequested,
  coerceBoolean,
  coerceInt,
  coercePositiveInt,
  parseCli,
  type CliSpec,
} from "./cli";
import { EthereumRpcClient } from "./rpc";
import { scanOneBlock } from "./scanner";
import { ScannerStorage, type BlockGap } from "./storage";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_BLOCKS_PER_CYCLE = 500;
const DEFAULT_BLOCK_SLEEP_MS = 50;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_TX_RECEIPT_CONCURRENCY = 20;

interface FillGapsConfig {
  databaseUrl: string;
  rpcUrl: string;
  intervalMs: number;
  maxBlocksPerCycle: number;
  blockSleepMs: number;
  retryMs: number;
  maxRetries: number;
  txReceiptConcurrency: number;
  saveTransactionData: boolean;
  once: boolean;
}

class FillGapsHelpRequested extends CliHelpRequested {}

const SPEC: CliSpec = {
  name: "fill-gaps",
  summary: `SCANNER_RPC_FULL_NODE=https://mainnet.rpc-node.dev.golem.network/ \\
  DATABASE_URL=postgres://user:pass@host:5432/db \\
  bun run fill-gaps

Detects internal holes in the stored block sequence (missing block numbers between the
earliest and latest stored blocks) and re-scans them from RPC. Forward and backfill scanner
progress are left untouched.`,
  options: [
    {
      flags: "--database-url <url>",
      description: "PostgreSQL connection string (or DATABASE_URL env).",
      env: ["DATABASE_URL", "SCANNER_DATABASE_URL"],
    },
    {
      flags: "--interval-ms <number>",
      description: "Sleep between gap-fill cycles. Defaults to 60000.",
      env: ["GAP_FILL_INTERVAL_MS"],
      default: DEFAULT_INTERVAL_MS.toString(),
    },
    {
      flags: "--max-blocks-per-cycle <number>",
      description: "Maximum blocks re-scanned per cycle (caps RPC load). Defaults to 500.",
      env: ["GAP_FILL_MAX_BLOCKS_PER_CYCLE"],
      default: DEFAULT_MAX_BLOCKS_PER_CYCLE.toString(),
    },
    {
      flags: "--block-sleep-ms <number>",
      description: "Delay after each filled block. Defaults to 50.",
      env: ["GAP_FILL_BLOCK_SLEEP_MS"],
      default: DEFAULT_BLOCK_SLEEP_MS.toString(),
    },
    {
      flags: "--retry-ms <number>",
      description: "Delay before retrying a failed block. Defaults to 5000.",
      env: ["GAP_FILL_RETRY_MS", "SCANNER_RETRY_MS"],
      default: DEFAULT_RETRY_MS.toString(),
    },
    {
      flags: "--max-retries <number>",
      description: "Attempts per block before skipping it for this cycle. Defaults to 5.",
      env: ["GAP_FILL_MAX_RETRIES"],
      default: DEFAULT_MAX_RETRIES.toString(),
    },
    {
      flags: "--tx-receipt-concurrency <n>",
      description: "Legacy setting accepted for compatibility; receipts are fetched sequentially.",
      env: ["SCANNER_TX_RECEIPT_CONCURRENCY"],
      default: DEFAULT_TX_RECEIPT_CONCURRENCY.toString(),
    },
    {
      flags: "--save-transaction-data <bool>",
      description:
        "Store inspected transaction rows for filled blocks. Defaults to true (or SCANNER_SAVE_TRANSACTION_DATA / SAVE_TRANSACTION_DATA).",
      env: ["SCANNER_SAVE_TRANSACTION_DATA", "SAVE_TRANSACTION_DATA"],
      default: "true",
    },
    { flags: "--once", description: "Run a single gap-fill cycle then exit." },
  ],
};

function parseConfig(args: string[], env: NodeJS.ProcessEnv = process.env): FillGapsConfig {
  const cli = parseCli(SPEC, args, env);

  if (cli.helpRequested) {
    throw new FillGapsHelpRequested(cli.helpText);
  }

  const rpcUrl = env.SCANNER_RPC_FULL_NODE;
  if (!rpcUrl) {
    throw new Error("SCANNER_RPC_FULL_NODE is required");
  }

  const databaseUrl = cli.value("database-url");
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or --database-url) is required");
  }

  return {
    databaseUrl,
    rpcUrl,
    intervalMs: coerceInt("--interval-ms", cli.value("interval-ms")!),
    maxBlocksPerCycle: coercePositiveInt(
      "--max-blocks-per-cycle",
      cli.value("max-blocks-per-cycle")!,
    ),
    blockSleepMs: coerceInt("--block-sleep-ms", cli.value("block-sleep-ms")!),
    retryMs: coerceInt("--retry-ms", cli.value("retry-ms")!),
    maxRetries: coercePositiveInt("--max-retries", cli.value("max-retries")!),
    txReceiptConcurrency: coercePositiveInt(
      "--tx-receipt-concurrency",
      cli.value("tx-receipt-concurrency")!,
    ),
    saveTransactionData: coerceBoolean("--save-transaction-data", cli.value("save-transaction-data")!),
    once: cli.flag("once"),
  };
}

/**
 * Flatten gap ranges into an ascending list of individual block numbers, capped at `maxBlocks`.
 * `truncated` is true when more missing blocks remain beyond the cap (picked up next cycle).
 */
export function expandGaps(
  gaps: BlockGap[],
  maxBlocks: number,
): { blocks: bigint[]; truncated: boolean } {
  const blocks: bigint[] = [];
  for (const gap of gaps) {
    for (let block = gap.gapStart; block <= gap.gapEnd; block += 1n) {
      if (blocks.length >= maxBlocks) {
        return { blocks, truncated: true };
      }
      blocks.push(block);
    }
  }
  return { blocks, truncated: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-scan a single missing block, retrying up to `maxRetries` times. Uses progress update kind
 * "none" so it never moves the forward or backfill cursors. Returns false (after logging) when the
 * block could not be fetched, so one bad block does not wedge the rest of the cycle.
 */
async function fillBlockWithRetry(
  blockNumber: bigint,
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  config: FillGapsConfig,
): Promise<boolean> {
  for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
    try {
      await scanOneBlock(
        blockNumber,
        rpc,
        storage,
        config.txReceiptConcurrency,
        { kind: "none" },
        {},
        config.saveTransactionData,
      );
      return true;
    } catch (error) {
      const lastAttempt = attempt >= config.maxRetries;
      console.error(
        `gap-fill: failed to scan block ${blockNumber.toString()} ` +
          `(attempt ${attempt}/${config.maxRetries})` +
          (lastAttempt ? "; skipping for this cycle" : `; retrying after ${config.retryMs}ms`),
        error,
      );
      if (lastAttempt) {
        return false;
      }
      await sleep(config.retryMs);
    }
  }
  return false;
}

async function runCycle(
  rpc: EthereumRpcClient,
  storage: ScannerStorage,
  config: FillGapsConfig,
  isStopping: () => boolean,
): Promise<void> {
  const startedAt = Date.now();
  const gaps = await storage.findBlockGaps(config.maxBlocksPerCycle);
  const scanMs = Date.now() - startedAt;
  if (gaps.length === 0) {
    console.log(`gap-fill: no gaps scan_ms=${scanMs} elapsed_ms=${Date.now() - startedAt}`);
    return;
  }

  const { blocks, truncated } = expandGaps(gaps, config.maxBlocksPerCycle);
  let filled = 0;
  let failed = 0;
  for (const block of blocks) {
    if (isStopping()) {
      break;
    }
    const ok = await fillBlockWithRetry(block, rpc, storage, config);
    if (ok) {
      filled += 1;
    } else {
      failed += 1;
    }
    if (config.blockSleepMs > 0) {
      await sleep(config.blockSleepMs);
    }
  }

  console.log(
    `gap-fill: gaps=${gaps.length} missing=${blocks.length} filled=${filled} failed=${failed}` +
      ` truncated=${truncated} scan_ms=${scanMs} elapsed_ms=${Date.now() - startedAt}`,
  );
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
    const rpc = new EthereumRpcClient(config.rpcUrl);
    storage = await ScannerStorage.open(config.databaseUrl);

    console.log(
      `Gap filler starting (interval=${config.intervalMs}ms, ` +
        `max_blocks_per_cycle=${config.maxBlocksPerCycle}, rpc=${rpc.rpcUrl})`,
    );

    while (!stopping) {
      const startedAt = Date.now();
      try {
        await runCycle(rpc, storage, config, () => stopping);
      } catch (error) {
        console.error("Gap-fill cycle failed:", error);
      }

      if (config.once || stopping) break;
      const wait = Math.max(0, config.intervalMs - (Date.now() - startedAt));
      if (wait > 0) {
        await sleep(wait);
      }
    }
  } catch (error) {
    if (error instanceof FillGapsHelpRequested) {
      console.log(error.message);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  } finally {
    await storage?.close();
  }
}

if (import.meta.main) {
  await main();
}
