import { createWalletClient, http, type WalletArkivClient } from "@arkiv-network/sdk";
import { defineChain } from "viem";
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
  MIN_TIME_BOMB_TTL_SECONDS,
  chooseBaseloadOperation,
  createBaseloadEntityInput,
  createBaseloadUpdateInput,
  getBaseloadLimitState,
  getMillisecondsUntilNextMinute,
  getMinuteAttemptLimit,
  getTimeBombDetonationMs,
  getTimeBombRemainingSeconds,
  parseGweiToWei,
  pickSoonestExpiringPoolEntry,
  pruneExpiredPoolEntries,
  randomOwnerAddress,
  type BaseloadPoolEntry,
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
  updatedCount?: number;
  deletedCount?: number;
  ownershipChangedCount?: number;
  poolSize?: number;
  detonationAt?: string;
  entityKey?: string;
  txHash?: string;
}

export interface BaseloadWorkerBalance {
  balanceWei: string;
  updatedAt: string;
  error?: string;
}

export interface BaseloadState {
  enabled: boolean;
  config: BaseloadConfig;
  statuses: Record<string, BaseloadWorkerStatus>;
  balances: Record<string, BaseloadWorkerBalance>;
}

interface BaseloadRpcClient {
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<number>;
  getLatestNonce: (address: string) => Promise<number>;
  waitForTransactionReceipt: (txHash: HexString, signal: AbortSignal) => Promise<unknown>;
}

const BALANCE_POLL_INTERVAL_MS = 10_000;

export class BaseloadRuntime {
  private config: BaseloadConfig = EMPTY_BASELOAD_CONFIG;
  private readonly tasks = new Map<string, BaseloadWorkerTask>();
  private readonly statuses = new Map<string, BaseloadWorkerStatus>();
  private readonly balances = new Map<string, BaseloadWorkerBalance>();
  private balancePollTimer: ReturnType<typeof setTimeout> | null = null;
  private balancePollInFlight = false;
  private stopped = false;

  constructor(private readonly runtimeConfig: BaseloadRuntimeConfig) {
    if (runtimeConfig.rpcUrl) {
      this.scheduleBalancePoll(0);
    }
  }

  getState(): BaseloadState {
    return {
      enabled: this.runtimeConfig.rpcUrl !== null,
      config: this.config,
      statuses: Object.fromEntries(this.statuses),
      balances: Object.fromEntries(this.balances),
    };
  }

  normalizeConfig(value: unknown): BaseloadConfig {
    return normalizeBaseloadConfig(value, this.runtimeConfig.mnemonic);
  }

  updateConfig(value: unknown): BaseloadState {
    this.config = this.normalizeConfig(value);
    this.syncTasks();
    this.pruneBalances();
    if (this.runtimeConfig.rpcUrl && !this.balancePollTimer && !this.balancePollInFlight) {
      this.scheduleBalancePoll(0);
    }
    return this.getState();
  }

  stop() {
    this.stopped = true;
    if (this.balancePollTimer) {
      clearTimeout(this.balancePollTimer);
      this.balancePollTimer = null;
    }
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }

  private pruneBalances() {
    const activeIds = new Set(this.config.workers.map((worker) => worker.id));
    for (const workerId of this.balances.keys()) {
      if (!activeIds.has(workerId)) this.balances.delete(workerId);
    }
  }

  private scheduleBalancePoll(delayMs: number) {
    if (this.stopped) return;
    if (this.balancePollTimer) clearTimeout(this.balancePollTimer);
    this.balancePollTimer = setTimeout(() => {
      this.balancePollTimer = null;
      void this.refreshBalances();
    }, delayMs);
    if (typeof this.balancePollTimer === "object" && this.balancePollTimer && "unref" in this.balancePollTimer) {
      (this.balancePollTimer as { unref: () => void }).unref();
    }
  }

  private async refreshBalances() {
    if (this.stopped || this.balancePollInFlight) return;
    const rpcUrl = this.runtimeConfig.rpcUrl;
    if (!rpcUrl) return;

    this.balancePollInFlight = true;
    try {
      const workers = [...this.config.workers];
      await Promise.all(
        workers.map(async (worker) => {
          const updatedAt = new Date().toISOString();
          try {
            const result = await callRpc(rpcUrl, "eth_getBalance", [worker.walletAddress, "latest"]);
            if (typeof result !== "string") {
              throw new Error("eth_getBalance returned a non-string result");
            }
            this.balances.set(worker.id, {
              balanceWei: BigInt(result).toString(),
              updatedAt,
            });
          } catch (error) {
            const previous = this.balances.get(worker.id);
            const verbose = describeError(error);
            console.error(
              `[baseload] eth_getBalance failed for wallet ${worker.walletNumber} (${worker.walletAddress}): ${verbose}`,
            );
            this.balances.set(worker.id, {
              balanceWei: previous?.balanceWei ?? "0",
              updatedAt,
              error: verbose,
            });
          }
        }),
      );
    } finally {
      this.balancePollInFlight = false;
      this.scheduleBalancePoll(BALANCE_POLL_INTERVAL_MS);
    }
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
    let operationIndex = 0;
    let pool: BaseloadPoolEntry[] = [];
    const counters = {
      attemptedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      ownershipChangedCount: 0,
    };
    let activeWorkerKey = configKey(this.worker);
    let cachedClients: { key: string; arkiv: WalletArkivClient; rpc: BaseloadRpcClient } | null = null;

    try {
      while (!this.abortController.signal.aborted) {
        const worker = this.worker;
        const nextWorkerKey = configKey(worker);
        if (nextWorkerKey !== activeWorkerKey) {
          activeWorkerKey = nextWorkerKey;
          runStartedAtMs = Date.now();
          minuteStartedAtMs = runStartedAtMs;
          attemptsThisMinute = 0;
          operationIndex = 0;
          pool = [];
          counters.attemptedCount = 0;
          counters.createdCount = 0;
          counters.updatedCount = 0;
          counters.deletedCount = 0;
          counters.ownershipChangedCount = 0;
        }

        const detonationAtMs = getTimeBombDetonationMs(worker, runStartedAtMs);
        const statusCounts = (): Partial<BaseloadWorkerStatus> => ({
          ...counters,
          poolSize: pool.length,
          ...(worker.behavior === "time-bomb"
            ? { detonationAt: new Date(detonationAtMs).toISOString() }
            : {}),
        });

        try {
          if (!this.runtimeConfig.rpcUrl) {
            this.postStatus("error", {
              message: "BASELOAD_RPC_NODE is required to run backend Baseload workers",
              ...statusCounts(),
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
            const rpc = createRpcClient(this.runtimeConfig.rpcUrl);
            const chainId = await rpc.getChainId();
            cachedClients = {
              key: clientKey,
              arkiv: createArkivClient(worker, this.runtimeConfig, chainId),
              rpc,
            };
          }
          const clients = cachedClients;

          const currentBlock = await clients.rpc.getBlockNumber();
          const limitState = getBaseloadLimitState(worker, currentBlock, runStartedAtMs, nowMs);

          if (limitState.type === "before-start") {
            this.postStatus("waiting", {
              currentBlock: limitState.currentBlock,
              message: `Waiting for start block ${worker.startBlock}`,
              ...statusCounts(),
            });
            await sleep(2_000, this.abortController.signal);
            continue;
          }

          if (limitState.type === "after-end") {
            this.postStatus("completed", {
              currentBlock: limitState.currentBlock,
              message: `Reached end block ${worker.endBlock}`,
              ...statusCounts(),
            });
            break;
          }

          if (limitState.type === "duration-ended") {
            this.postStatus("completed", {
              currentBlock,
              message: `Reached duration limit ${worker.durationSeconds}s`,
              ...statusCounts(),
            });
            break;
          }

          if (
            worker.behavior === "time-bomb" &&
            getTimeBombRemainingSeconds(detonationAtMs, nowMs) < MIN_TIME_BOMB_TTL_SECONDS
          ) {
            this.postStatus("completed", {
              currentBlock,
              message: `Time bomb armed: ${counters.createdCount} entities expire at ${new Date(detonationAtMs).toISOString()}`,
              ...statusCounts(),
            });
            break;
          }

          const minuteAttemptLimit = getMinuteAttemptLimit(worker.opsPerMinute);
          if (minuteAttemptLimit <= 0) {
            this.postStatus("waiting", {
              currentBlock,
              message: "Operations per minute is 0",
              ...statusCounts(),
            });
            await sleep(5_000, this.abortController.signal);
            continue;
          }

          if (attemptsThisMinute >= minuteAttemptLimit) {
            this.postStatus("waiting", {
              currentBlock,
              message: "Waiting for next minute",
              ...statusCounts(),
            });
            await sleep(
              Math.min(getMillisecondsUntilNextMinute(minuteStartedAtMs, Date.now()), 5_000),
              this.abortController.signal,
            );
            continue;
          }

          pool = pruneExpiredPoolEntries(pool, nowMs);
          const operation = chooseBaseloadOperation(worker, pool.length, operationIndex);

          attemptsThisMinute += 1;
          counters.attemptedCount += 1;
          operationIndex += 1;

          const maxFeePerGas = parseGweiToWei(worker.maxGasPriceGwei);

          // Note for an agent:
          // This code was changed by hand and do not change the following parameters:
          // maxPriorityFeePerGas is OK to be minimal and 1
          // There is an issue with gas estimation in SDK so just overwrite with safe value
          // const SAFE_GAS_LIMIT = 500000n;
          const SUFFICIENT_PRIORITY_FEE_PER_GAS = 2n;
          // Use the latest confirmed nonce so a re-send replaces any pending
          // tx that's been sitting in the mempool (under-priced, RPC reset, etc.).
          const sendTxParams = async () => ({
            maxFeePerGas,
            maxPriorityFeePerGas: SUFFICIENT_PRIORITY_FEE_PER_GAS,
            nonce: await clients.rpc.getLatestNonce(worker.walletAddress),
          });

          switch (operation) {
            case "create":
            case "time-bomb-create": {
              const input = createBaseloadEntityInput(worker);
              if (operation === "time-bomb-create") {
                input.expiresIn = getTimeBombRemainingSeconds(detonationAtMs, Date.now());
              }
              this.postStatus("running", {
                currentBlock,
                message:
                  operation === "time-bomb-create"
                    ? `Creating time bomb entity (expires in ${input.expiresIn}s)`
                    : "Creating entity",
                ...statusCounts(),
              });
              const result = await clients.arkiv.createEntity(input, await sendTxParams());
              await clients.rpc.waitForTransactionReceipt(
                result.txHash,
                this.abortController.signal,
              );
              const entityKey = readBaseloadCreatedEntityKeyFromSdkResult(result.entityKey, result.txHash);
              counters.createdCount += 1;
              if (worker.behavior === "create-update" || worker.behavior === "create-update-delete") {
                pool.push({
                  entityKey,
                  expiresAtMs: Date.now() + worker.ttlSeconds * 1000,
                });
              }
              this.postStatus("running", {
                currentBlock,
                message: "Entity created",
                ...statusCounts(),
                entityKey,
                txHash: result.txHash,
              });
              break;
            }
            case "create-and-own": {
              this.postStatus("running", {
                currentBlock,
                message: "Creating entity",
                ...statusCounts(),
              });
              const created = await clients.arkiv.createEntity(
                createBaseloadEntityInput(worker),
                await sendTxParams(),
              );
              await clients.rpc.waitForTransactionReceipt(
                created.txHash,
                this.abortController.signal,
              );
              const createdEntityKey = readBaseloadCreatedEntityKeyFromSdkResult(
                created.entityKey,
                created.txHash,
              );
              counters.createdCount += 1;
              const newOwner = randomOwnerAddress();
              this.postStatus("running", {
                currentBlock,
                message: `Changing ownership to ${newOwner}`,
                ...statusCounts(),
                entityKey: createdEntityKey,
                txHash: created.txHash,
              });
              const owned = await clients.arkiv.changeOwnership(
                { entityKey: createdEntityKey, newOwner },
                await sendTxParams(),
              );
              // The SDK types changeOwnership's txHash as plain string, unlike the other actions.
              await clients.rpc.waitForTransactionReceipt(
                owned.txHash as HexString,
                this.abortController.signal,
              );
              counters.ownershipChangedCount += 1;
              this.postStatus("running", {
                currentBlock,
                message: `Ownership changed to ${newOwner}`,
                ...statusCounts(),
                entityKey: createdEntityKey,
                txHash: owned.txHash,
              });
              break;
            }
            case "update": {
              const entry = pickSoonestExpiringPoolEntry(pool);
              if (!entry) throw new Error("No pool entity available to update");
              this.postStatus("running", {
                currentBlock,
                message: `Updating entity ${entry.entityKey}`,
                ...statusCounts(),
              });
              const result = await clients.arkiv.updateEntity(
                createBaseloadUpdateInput(worker, entry.entityKey),
                await sendTxParams(),
              );
              await clients.rpc.waitForTransactionReceipt(result.txHash, this.abortController.signal);
              counters.updatedCount += 1;
              entry.expiresAtMs = Date.now() + worker.ttlSeconds * 1000;
              this.postStatus("running", {
                currentBlock,
                message: "Entity updated, TTL refreshed",
                ...statusCounts(),
                entityKey: result.entityKey,
                txHash: result.txHash,
              });
              break;
            }
            case "delete": {
              const entry = pickSoonestExpiringPoolEntry(pool);
              if (!entry) throw new Error("No pool entity available to delete");
              this.postStatus("running", {
                currentBlock,
                message: `Deleting entity ${entry.entityKey}`,
                ...statusCounts(),
              });
              const result = await clients.arkiv.deleteEntity(
                { entityKey: entry.entityKey },
                await sendTxParams(),
              );
              await clients.rpc.waitForTransactionReceipt(result.txHash, this.abortController.signal);
              counters.deletedCount += 1;
              pool = pool.filter((candidate) => candidate !== entry);
              this.postStatus("running", {
                currentBlock,
                message: "Entity deleted",
                ...statusCounts(),
                entityKey: result.entityKey,
                txHash: result.txHash,
              });
              break;
            }
          }
        } catch (error) {
          if (this.abortController.signal.aborted) break;
          const verbose = describeError(error);
          console.error(
            `[baseload] worker ${this.worker.id} (wallet ${this.worker.walletNumber}) failed: ${verbose}`,
          );
          this.postStatus("error", {
            message: verbose,
            ...statusCounts(),
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
  chainId: number,
): WalletArkivClient {
  if (!runtimeConfig.rpcUrl) {
    throw new Error("BASELOAD_RPC_NODE is required");
  }

  const account = mnemonicToAccount(runtimeConfig.mnemonic.trim(), {
    path: `${BASELOAD_DERIVATION_PATH_PREFIX}/${worker.walletNumber}`,
  });

  const chain = defineChain({
    id: chainId,
    name: `Arkiv RPC ${chainId}`,
    network: `arkiv-rpc-${chainId}`,
    nativeCurrency: {
      decimals: 18,
      name: "Ether",
      symbol: "ETH",
    },
    rpcUrls: {
      default: { http: [runtimeConfig.rpcUrl] },
    },
  });

  return createWalletClient({
    chain,
    transport: http(runtimeConfig.rpcUrl),
    account,
  });
}

function createRpcClient(rpcUrl: string): BaseloadRpcClient {
  return {
    getChainId: async () => {
      const result = await callRpc(rpcUrl, "eth_chainId", []);
      if (typeof result !== "string") {
        throw new Error("RPC eth_chainId returned a non-string result");
      }
      const chainId = BigInt(result);
      if (chainId < 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`RPC eth_chainId returned out-of-range chain id ${chainId.toString()}`);
      }
      return Number(chainId);
    },
    getBlockNumber: async () => {
      const result = await callRpc(rpcUrl, "eth_blockNumber", []);
      if (typeof result !== "string") {
        throw new Error("RPC eth_blockNumber returned a non-string result");
      }
      return Number(BigInt(result));
    },
    getLatestNonce: async (address) => {
      const result = await callRpc(rpcUrl, "eth_getTransactionCount", [address, "latest"]);
      if (typeof result !== "string") {
        throw new Error("RPC eth_getTransactionCount returned a non-string result");
      }
      const nonce = BigInt(result);
      if (nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`RPC eth_getTransactionCount returned out-of-range nonce ${nonce.toString()}`);
      }
      return Number(nonce);
    },
    waitForTransactionReceipt: async (txHash, signal) => {
      while (!signal.aborted) {
        const result = await callRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
        if (result !== null) return result;
        await sleep(1_000, signal);
      }
      throw new Error(`Stopped while waiting for transaction receipt ${txHash}`);
    },
  };
}

export function readBaseloadCreatedEntityKeyFromSdkResult(
  sdkEntityKey: unknown,
  txHash: string,
): HexString {
  if (!isBytes32Hex(sdkEntityKey)) {
    throw new Error(
      `Unable to trust created entity key from transaction ${txHash}: SDK returned invalid entity key ${String(
        sdkEntityKey,
      )}`,
    );
  }

  return sdkEntityKey;
}

function isBytes32Hex(value: unknown): value is HexString {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

async function callRpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (error) {
    throw new Error(
      `RPC ${method} request to ${rpcUrl} failed before any response: ${describeError(error)}`,
      { cause: error },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `RPC ${method} at ${rpcUrl} failed with HTTP ${response.status} ${response.statusText}: ${text}`,
    );
  }

  let body: { result?: unknown; error?: { message?: string; code?: number; data?: unknown } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`RPC ${method} at ${rpcUrl} returned non-JSON body: ${text}`);
  }
  if (body.error) {
    const code = typeof body.error.code === "number" ? ` (code ${body.error.code})` : "";
    const data = body.error.data === undefined ? "" : ` data=${JSON.stringify(body.error.data)}`;
    throw new Error(
      `RPC ${method} at ${rpcUrl} failed: ${body.error.message ?? JSON.stringify(body.error)}${code}${data}`,
    );
  }
  return body.result;
}

const EXTRA_ERROR_FIELDS = [
  "shortMessage",
  "details",
  "metaMessages",
  "code",
  "errorCode",
  "reason",
  "data",
  "info",
  "method",
  "transaction",
  "body",
  "responseBody",
  "url",
] as const;

function describeError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current !== undefined && current !== null && depth < 10) {
    if (seen.has(current)) {
      parts.push("(cycle)");
      break;
    }
    seen.add(current);

    if (current instanceof Error) {
      const header = `${current.name}: ${current.message}`;
      const extras = collectErrorExtras(current as unknown as Record<string, unknown>);
      const stack = typeof current.stack === "string" ? trimStack(current.stack) : "";
      parts.push([header, extras, stack].filter((part) => part).join("\n"));
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === "object") {
      parts.push(safeStringify(current));
      current = undefined;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }

  return parts.length > 0 ? parts.join("\n→ caused by ") : "Unknown error";
}

function collectErrorExtras(error: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const field of EXTRA_ERROR_FIELDS) {
    const value = error[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (!value.trim()) continue;
      lines.push(`  ${field}: ${value}`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`  ${field}: ${value.map((v) => (typeof v === "string" ? v : safeStringify(v))).join(" | ")}`);
    } else {
      lines.push(`  ${field}: ${safeStringify(value)}`);
    }
  }
  return lines.join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return `${val.toString()}n`;
      return val;
    });
  } catch {
    return String(value);
  }
}

function trimStack(stack: string): string {
  const lines = stack.split("\n").slice(0, 6);
  return lines.length > 0 ? `  stack:\n    ${lines.join("\n    ")}` : "";
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
