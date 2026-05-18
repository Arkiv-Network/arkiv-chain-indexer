import { createWalletClient, http } from "@arkiv-network/sdk";
import { braga } from "@arkiv-network/sdk/chains";
import { mnemonicToAccount } from "viem/accounts";
import {
  BASELOAD_DERIVATION_PATH_PREFIX,
  EMPTY_BASELOAD_CONFIG,
  normalizeBaseloadConfig,
  type BaseloadConfig,
  type BaseloadRuntimeConfig,
  type BaseloadWorkerConfig,
} from "./baseloadConfig";
import {
  createBaseloadEntityInput,
  getBaseloadLimitState,
  getMillisecondsUntilNextMinute,
  getMinuteAttemptLimit,
  parseGweiToWei,
} from "./baseloadTaskHelpers";

type HexString = `0x${string}`;

export type BaseloadWorkerStatusName =
  | "starting"
  | "ready"
  | "updated"
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "stopped";

export interface BaseloadWorkerStatus {
  workerId: string;
  walletNumber: number;
  status: BaseloadWorkerStatusName;
  updatedAt: string;
  currentBlock?: number;
  message?: string;
  attemptedCount?: number;
  createdCount?: number;
  entityKey?: string;
  txHash?: string;
}

export interface BaseloadState {
  enabled: boolean;
  config: BaseloadConfig;
  statuses: Record<string, BaseloadWorkerStatus>;
}

interface BaseloadArkivClient {
  createEntity: (
    data: ReturnType<typeof createBaseloadEntityInput>,
    txParams: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  ) => Promise<{ entityKey: HexString; txHash: HexString }>;
}

interface BaseloadRpcClient {
  getBlockNumber: () => Promise<number>;
  waitForTransactionReceipt: (txHash: HexString, signal: AbortSignal) => Promise<void>;
}

export class BaseloadRuntime {
  private config: BaseloadConfig = EMPTY_BASELOAD_CONFIG;
  private readonly tasks = new Map<string, BaseloadWorkerTask>();
  private readonly statuses = new Map<string, BaseloadWorkerStatus>();

  constructor(private readonly runtimeConfig: BaseloadRuntimeConfig) {}

  getState(): BaseloadState {
    return {
      enabled: this.runtimeConfig.rpcUrl !== null,
      config: this.config,
      statuses: Object.fromEntries(this.statuses),
    };
  }

  updateConfig(value: unknown): BaseloadState {
    const nextConfig = normalizeBaseloadConfig(value, this.runtimeConfig.mnemonic);
    this.config = nextConfig;
    this.syncTasks();
    return this.getState();
  }

  stop() {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }

  private syncTasks() {
    const activeWorkerIds = new Set(this.config.workers.map((worker) => worker.id));

    for (const [workerId, task] of this.tasks) {
      if (!activeWorkerIds.has(workerId)) {
        task.stop();
        this.tasks.delete(workerId);
      }
    }

    for (const worker of this.config.workers) {
      const existing = this.tasks.get(worker.id);
      if (existing) {
        if (!existing.isFinished()) {
          existing.update(worker);
          continue;
        }
        this.tasks.delete(worker.id);
      }

      const task = new BaseloadWorkerTask(worker, this.runtimeConfig, (status) => {
        this.statuses.set(status.workerId, status);
      });
      this.tasks.set(worker.id, task);
      task.start();
    }
  }
}

class BaseloadWorkerTask {
  private worker: BaseloadWorkerConfig;
  private readonly abortController = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private finished = false;

  constructor(
    worker: BaseloadWorkerConfig,
    private readonly runtimeConfig: BaseloadRuntimeConfig,
    private readonly onStatus: (status: BaseloadWorkerStatus) => void,
  ) {
    this.worker = worker;
  }

  start() {
    this.postStatus("starting");
    this.loopPromise = this.run();
  }

  update(worker: BaseloadWorkerConfig) {
    this.worker = worker;
    this.postStatus("updated");
  }

  stop() {
    this.abortController.abort();
    this.postStatus("stopped");
  }

  isFinished(): boolean {
    return this.finished;
  }

  private async run() {
    let runStartedAtMs = Date.now();
    let minuteStartedAtMs = runStartedAtMs;
    let attemptsThisMinute = 0;
    let attemptedCount = 0;
    let createdCount = 0;
    let activeWorkerKey = configKey(this.worker);
    let cachedClients: { key: string; arkiv: BaseloadArkivClient; rpc: BaseloadRpcClient } | null = null;

    try {
      while (!this.abortController.signal.aborted) {
        const worker = this.worker;
        const nextWorkerKey = configKey(worker);
        if (nextWorkerKey !== activeWorkerKey) {
          activeWorkerKey = nextWorkerKey;
          runStartedAtMs = Date.now();
          minuteStartedAtMs = runStartedAtMs;
          attemptsThisMinute = 0;
          attemptedCount = 0;
          createdCount = 0;
        }

        try {
          if (!this.runtimeConfig.rpcUrl) {
            this.postStatus("error", {
              message: "BASELOAD_RPC_NODE is required to run backend Baseload workers",
              attemptedCount,
              createdCount,
            });
            await sleep(5_000, this.abortController.signal);
            continue;
          }

          const nowMs = Date.now();
          if (nowMs - minuteStartedAtMs >= 60_000) {
            minuteStartedAtMs = nowMs;
            attemptsThisMinute = 0;
          }

          const clientKey = `${this.runtimeConfig.rpcUrl}:${this.runtimeConfig.mnemonic}:${worker.walletNumber}`;
          if (cachedClients === null || cachedClients.key !== clientKey) {
            cachedClients = {
              key: clientKey,
              arkiv: createArkivClient(worker, this.runtimeConfig),
              rpc: createRpcClient(this.runtimeConfig.rpcUrl),
            };
          }

          const currentBlock = await cachedClients.rpc.getBlockNumber();
          const limitState = getBaseloadLimitState(worker, currentBlock, runStartedAtMs, nowMs);

          if (limitState.type === "before-start") {
            this.postStatus("waiting", {
              currentBlock: limitState.currentBlock,
              message: `Waiting for start block ${worker.startBlock}`,
              attemptedCount,
              createdCount,
            });
            await sleep(2_000, this.abortController.signal);
            continue;
          }

          if (limitState.type === "after-end") {
            this.postStatus("completed", {
              currentBlock: limitState.currentBlock,
              message: `Reached end block ${worker.endBlock}`,
              attemptedCount,
              createdCount,
            });
            break;
          }

          if (limitState.type === "duration-ended") {
            this.postStatus("completed", {
              currentBlock,
              message: `Reached duration limit ${worker.durationSeconds}s`,
              attemptedCount,
              createdCount,
            });
            break;
          }

          const minuteAttemptLimit = getMinuteAttemptLimit(worker.createsPerMinute);
          if (minuteAttemptLimit <= 0) {
            this.postStatus("waiting", {
              currentBlock,
              message: "Creates per minute is 0",
              attemptedCount,
              createdCount,
            });
            await sleep(5_000, this.abortController.signal);
            continue;
          }

          if (attemptsThisMinute >= minuteAttemptLimit) {
            this.postStatus("waiting", {
              currentBlock,
              message: "Waiting for next minute",
              attemptedCount,
              createdCount,
            });
            await sleep(
              Math.min(getMillisecondsUntilNextMinute(minuteStartedAtMs, Date.now()), 5_000),
              this.abortController.signal,
            );
            continue;
          }

          attemptsThisMinute += 1;
          attemptedCount += 1;
          this.postStatus("running", {
            currentBlock,
            message: "Creating entity",
            attemptedCount,
            createdCount,
          });

          const maxFeePerGas = parseGweiToWei(worker.maxGasPriceGwei);
          const result = await cachedClients.arkiv.createEntity(createBaseloadEntityInput(worker), {
            maxFeePerGas,
            maxPriorityFeePerGas: maxFeePerGas,
          });
          await cachedClients.rpc.waitForTransactionReceipt(result.txHash, this.abortController.signal);

          createdCount += 1;
          this.postStatus("running", {
            currentBlock,
            message: "Entity created",
            attemptedCount,
            createdCount,
            entityKey: result.entityKey,
            txHash: result.txHash,
          });
        } catch (error) {
          if (this.abortController.signal.aborted) break;
          this.postStatus("error", {
            message: error instanceof Error ? error.message : String(error),
            attemptedCount,
            createdCount,
          });
          await sleep(5_000, this.abortController.signal).catch(() => undefined);
        }
      }
    } finally {
      this.finished = true;
    }
  }

  private postStatus(
    status: BaseloadWorkerStatusName,
    details: Omit<
      Partial<BaseloadWorkerStatus>,
      "workerId" | "walletNumber" | "status" | "updatedAt"
    > = {},
  ) {
    this.onStatus({
      workerId: this.worker.id,
      walletNumber: this.worker.walletNumber,
      status,
      updatedAt: new Date().toISOString(),
      ...details,
    });
  }
}

function createArkivClient(
  worker: BaseloadWorkerConfig,
  runtimeConfig: BaseloadRuntimeConfig,
): BaseloadArkivClient {
  if (!runtimeConfig.rpcUrl) {
    throw new Error("BASELOAD_RPC_NODE is required");
  }

  const account = mnemonicToAccount(runtimeConfig.mnemonic.trim(), {
    path: `${BASELOAD_DERIVATION_PATH_PREFIX}/${worker.walletNumber}`,
  });

  return createWalletClient({
    chain: braga,
    transport: http(runtimeConfig.rpcUrl),
    account,
  }) as unknown as BaseloadArkivClient;
}

function createRpcClient(rpcUrl: string): BaseloadRpcClient {
  return {
    getBlockNumber: async () => {
      const result = await callRpc(rpcUrl, "eth_blockNumber", []);
      if (typeof result !== "string") {
        throw new Error("RPC eth_blockNumber returned a non-string result");
      }
      return Number(BigInt(result));
    },
    waitForTransactionReceipt: async (txHash, signal) => {
      while (!signal.aborted) {
        const result = await callRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
        if (result !== null) return;
        await sleep(1_000, signal);
      }
    },
  };
}

async function callRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RPC ${method} failed with HTTP ${response.status}: ${text}`);
  }

  const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    throw new Error(`RPC ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  return body.result;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Task stopped"));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Task stopped"));
      },
      { once: true },
    );
  });
}

function configKey(worker: BaseloadWorkerConfig): string {
  return JSON.stringify(worker);
}
