import { type BaseloadWorkerConfig } from "./baseloadConfig";
import {
  createBaseloadEntityInput,
  getBaseloadLimitState,
  getMillisecondsUntilNextMinute,
  getMinuteAttemptLimit,
} from "./baseloadTaskHelpers";
import { createWalletClient, http } from "@arkiv-network/sdk";
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts";
import { braga } from "@arkiv-network/sdk/chains";
import { HDNodeWallet, parseUnits } from "ethers";

type HexString = `0x${string}`;

type BaseloadWorkerMessage =
  | { type: "start"; worker: BaseloadWorkerConfig; mnemonic: string }
  | { type: "update"; worker: BaseloadWorkerConfig; mnemonic: string }
  | { type: "stop" };

type BaseloadWorkerStatus =
  | "ready"
  | "updated"
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "stopped";

interface BaseloadArkivClient {
  getBlockNumber: () => Promise<bigint>;
  createEntity: (
    data: ReturnType<typeof createBaseloadEntityInput>,
    txParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ) => Promise<{ entityKey: HexString; txHash: HexString }>;
}

let currentWorker: BaseloadWorkerConfig | null = null;
let currentMnemonic = "";
let loopRunning = false;

self.onmessage = (event: MessageEvent<BaseloadWorkerMessage>) => {
  if (event.data.type === "stop") {
    currentWorker = null;
    postStatus("stopped");
    return;
  }

  currentWorker = event.data.worker;
  currentMnemonic = event.data.mnemonic;
  postStatus(event.data.type === "start" ? "ready" : "updated");
  void runBaseloadLoop();
};

async function runBaseloadLoop() {
  if (loopRunning) return;
  loopRunning = true;

  let activeWorkerId: string | null = null;
  let runStartedAtMs = Date.now();
  let minuteStartedAtMs = runStartedAtMs;
  let attemptsThisMinute = 0;
  let attemptedCount = 0;
  let createdCount = 0;
  let cachedClient: { cacheKey: string; client: BaseloadArkivClient } | null = null;

  try {
    while (currentWorker) {
      const worker = currentWorker;
      const mnemonic = currentMnemonic;
      if (activeWorkerId !== worker.id) {
        activeWorkerId = worker.id;
        runStartedAtMs = Date.now();
        minuteStartedAtMs = runStartedAtMs;
        attemptsThisMinute = 0;
        attemptedCount = 0;
        createdCount = 0;
      }

      try {
        const nowMs = Date.now();
        if (nowMs - minuteStartedAtMs >= 60_000) {
          minuteStartedAtMs = nowMs;
          attemptsThisMinute = 0;
        }

        const cacheKey = `${mnemonic}:${worker.walletNumber}`;
        if (cachedClient === null || cachedClient.cacheKey !== cacheKey) {
          cachedClient = { cacheKey, client: createClient(worker, mnemonic) };
        }

        const currentBlock = Number(await cachedClient.client.getBlockNumber());
        const limitState = getBaseloadLimitState(worker, currentBlock, runStartedAtMs, nowMs);

        if (limitState.type === "before-start") {
          postStatus("waiting", {
            currentBlock: limitState.currentBlock,
            message: `Waiting for start block ${worker.startBlock}`,
            attemptedCount,
            createdCount,
          });
          await sleep(2_000);
          continue;
        }

        if (limitState.type === "after-end") {
          postStatus("completed", {
            currentBlock: limitState.currentBlock,
            message: `Reached end block ${worker.endBlock}`,
            attemptedCount,
            createdCount,
          });
          currentWorker = null;
          break;
        }

        if (limitState.type === "duration-ended") {
          postStatus("completed", {
            currentBlock,
            message: `Reached duration limit ${worker.durationSeconds}s`,
            attemptedCount,
            createdCount,
          });
          currentWorker = null;
          break;
        }

        const minuteAttemptLimit = getMinuteAttemptLimit(worker.createsPerMinute);
        if (minuteAttemptLimit <= 0) {
          postStatus("waiting", {
            currentBlock,
            message: "Creates per minute is 0",
            attemptedCount,
            createdCount,
          });
          await sleep(5_000);
          continue;
        }

        if (attemptsThisMinute >= minuteAttemptLimit) {
          postStatus("waiting", {
            currentBlock,
            message: "Waiting for next minute",
            attemptedCount,
            createdCount,
          });
          await sleep(Math.min(getMillisecondsUntilNextMinute(minuteStartedAtMs, Date.now()), 5_000));
          continue;
        }

        attemptsThisMinute += 1;
        attemptedCount += 1;
        postStatus("running", {
          currentBlock,
          message: "Creating entity",
          attemptedCount,
          createdCount,
        });

        const maxFeePerGas = parseUnits(String(worker.maxGasPriceGwei), "gwei");
        const result = await cachedClient.client.createEntity(createBaseloadEntityInput(worker), {
          maxFeePerGas,
          maxPriorityFeePerGas: maxFeePerGas,
        });

        createdCount += 1;
        postStatus("running", {
          currentBlock,
          message: "Entity created",
          attemptedCount,
          createdCount,
          entityKey: result.entityKey,
          txHash: result.txHash,
        });
      } catch (err) {
        postStatus("error", {
          message: err instanceof Error ? err.message : String(err),
          attemptedCount,
          createdCount,
        });
        await sleep(5_000);
      }
    }
  } finally {
    loopRunning = false;
  }
}

function createClient(worker: BaseloadWorkerConfig, mnemonic: string) {
  const wallet = HDNodeWallet.fromPhrase(mnemonic.trim(), undefined, `m/44'/60'/0'/0/${worker.walletNumber}`);
  return createWalletClient({
    chain: braga,
    transport: http(),
    account: privateKeyToAccount(wallet.privateKey as HexString),
  }) as unknown as BaseloadArkivClient;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function postStatus(
  status: BaseloadWorkerStatus,
  details: {
    currentBlock?: number;
    message?: string;
    attemptedCount?: number;
    createdCount?: number;
    entityKey?: string;
    txHash?: string;
  } = {},
) {
  self.postMessage({
    type: "status",
    status,
    workerId: currentWorker?.id ?? null,
    walletNumber: currentWorker?.walletNumber ?? null,
    updatedAt: new Date().toISOString(),
    ...details,
  });
}
