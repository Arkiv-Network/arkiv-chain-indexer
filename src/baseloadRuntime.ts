import {
  createWalletClient,
  decodeMutationResult,
  ExpirationTime,
  sendMutation,
  type EntityMutationOps,
  type WalletArkivClient,
} from "@arkiv-network/sdk";
import { u64 } from "@arkiv-network/sdk/attr";
import { defineChain, formatEther, http, type TransactionReceipt } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { BaseloadFaucetClient } from "./baseloadFaucet";
import {
  BaseloadRpcKeyPool,
  bareRpcEndpoint,
  maskKey,
  type BaseloadRpcEndpoint,
} from "./baseloadRpcKeys";
import { RpcKeyRing, attachRpcKeyRing } from "./rpcKeyRing";
import { describeBaseloadSchedule } from "./baseloadSchedule";
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
  getEntitiesPerRequestLimit,
  needsCurrentBlock,
  getBaseloadLimitState,
  getMillisecondsUntilNextMinute,
  getMinuteAttemptLimit,
  getTimeBombDetonationMs,
  getTimeBombRemainingSeconds,
  isFeeCapBelowBaseFeeError,
  BaseFeeCache,
  formatGweiShort,
  isOutpriced,
  parseGweiToWei,
  pickSoonestExpiringPoolEntries,
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
  /** Priced out: the worker's fee cap is below the current base fee. */
  | "outpriced"
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
  /** Base fee of the latest block, or null when the chain does not report one. */
  getBaseFeeWei: () => Promise<bigint | null>;
  /**
   * Polls for the receipt. `onStall` is consulted every {@link RECEIPT_STALL_CHECK_MS}
   * with the elapsed time; returning false abandons the wait.
   */
  waitForTransactionReceipt: (
    txHash: HexString,
    signal: AbortSignal,
    onStall?: (elapsedMs: number) => Promise<boolean>,
  ) => Promise<BaseloadTransactionReceipt>;
}

type BaseloadTransactionReceipt = {
  status?: unknown;
  [key: string]: unknown;
};

type BaseloadTxParams = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  /**
   * Supplying the limit keeps viem from spending an `eth_estimateGas` on every
   * send; it is learned from the gas a batch of the same shape actually burnt.
   */
  gas?: bigint;
  /**
   * Naming the chain stops viem probing the node with `eth_fillTransaction`
   * (which a plain Ethereum node rejects) before the first send on a client.
   */
  chainId?: number;
};

export type BaseloadMutationParameters = {
  creates?: ReturnType<typeof createBaseloadEntityInput>[];
  updates?: ReturnType<typeof createBaseloadUpdateInput>[];
  deletes?: Array<{ entityKey: HexString }>;
  extensions?: Array<{ entityKey: HexString; expiresIn: number }>;
  ownershipChanges?: Array<{ entityKey: HexString; newOwner: HexString }>;
};

type BaseloadMutationResult = {
  txHash: HexString;
  createdEntities: HexString[];
  updatedEntities: HexString[];
  deletedEntities: HexString[];
  extendedEntities: HexString[];
  ownershipChanges: HexString[];
};

const BALANCE_POLL_INTERVAL_MS = 10_000;
/** How often a worker without a block window refreshes the height just for display. */
const BLOCK_DISPLAY_REFRESH_MS = 15_000;
/** One block time: a receipt cannot land sooner, so polling earlier only burns budget. */
const RECEIPT_FIRST_POLL_DELAY_MS = 2_000;
const RECEIPT_POLL_INTERVAL_MS = 1_000;
/** How often a stalled receipt wait asks its owner whether to keep waiting. */
const RECEIPT_STALL_CHECK_MS = 20_000;
/** A pending transaction that is not merely underpriced is given up after this. */
const RECEIPT_WAIT_TIMEOUT_MS = 10 * 60_000;
/** One base-fee reading serves the whole fleet for about a block. */
const BASE_FEE_TTL_MS = 2_000;

/** Spreads fleet-wide waits over a window so polls do not land on one tick. */
function jitteredDelay(baseMs: number): number {
  return Math.round(baseMs * (0.75 + Math.random() * 0.5));
}

export class BaseloadRuntime {
  private config: BaseloadConfig = EMPTY_BASELOAD_CONFIG;
  private readonly tasks = new Map<string, BaseloadWorkerTask>();
  private readonly statuses = new Map<string, BaseloadWorkerStatus>();
  private readonly balances = new Map<string, BaseloadWorkerBalance>();
  private balancePollTimer: ReturnType<typeof setTimeout> | null = null;
  private balancePollInFlight = false;
  private stopped = false;
  private readonly faucet: BaseloadFaucetClient | null;
  private readonly baseFees = new BaseFeeCache(BASE_FEE_TTL_MS);
  private readonly rpcKeys: BaseloadRpcKeyPool | null;
  private rpcKeyRing: RpcKeyRing | null = null;

  constructor(private readonly runtimeConfig: BaseloadRuntimeConfig) {
    this.faucet = runtimeConfig.faucet ? new BaseloadFaucetClient(runtimeConfig.faucet) : null;
    this.rpcKeys = runtimeConfig.rpcKeys ? new BaseloadRpcKeyPool(runtimeConfig.rpcKeys) : null;
    // Load the shared rotating pool in the background; workers fall back to the
    // single configured key until it lands.
    void attachRpcKeyRing({ setKeyRing: (ring) => { this.rpcKeyRing = ring; } }, "baseload").catch(
      (error) => console.error(`[rpc-keys] baseload could not load the key pool: ${describeError(error)}`),
    );
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
          let balanceWei: bigint | null = null;
          try {
            // Poll each wallet through that worker's own key, so the poller does
            // not spend a shared key's rate-limit budget on behalf of the fleet.
            const endpoint = await resolveRpcEndpoint(this.rpcKeys, rpcUrl, worker.id, this.rpcKeyRing);
            const result = await callRpc(
              endpoint,
              "eth_getBalance",
              [worker.walletAddress, "latest"],
              this.rpcKeyRing,
            );
            if (typeof result !== "string") {
              throw new Error("eth_getBalance returned a non-string result");
            }
            balanceWei = BigInt(result);
            this.balances.set(worker.id, {
              balanceWei: balanceWei.toString(),
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
          if (balanceWei !== null) await this.topUpFromFaucet(worker, balanceWei);
        }),
      );
    } finally {
      this.balancePollInFlight = false;
      this.scheduleBalancePoll(BALANCE_POLL_INTERVAL_MS);
    }
  }

  /**
   * Keeps a worker wallet funded from the internal faucet. Never throws: a faucet
   * outage must not stop balance polling or the workers themselves.
   */
  private async topUpFromFaucet(worker: BaseloadWorkerConfig, balanceWei: bigint) {
    if (!this.faucet) return;
    try {
      const result = await this.faucet.maybeTopUp(worker.walletAddress, balanceWei);
      if (result.requested) {
        console.log(
          `[baseload] faucet dripped wallet ${worker.walletNumber} (${worker.walletAddress}) at ${formatEther(balanceWei)} ETH`,
        );
      }
    } catch (error) {
      console.error(
        `[baseload] faucet top-up failed for wallet ${worker.walletNumber} (${worker.walletAddress}): ${describeError(error)}`,
      );
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

      const task = new BaseloadWorkerTask(
        worker,
        this.runtimeConfig,
        (status) => {
          this.statuses.set(status.workerId, status);
        },
        this.rpcKeys,
        () => this.rpcKeyRing,
        this.baseFees,
      );
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
    private readonly rpcKeys: BaseloadRpcKeyPool | null = null,
    private readonly getKeyRing: () => RpcKeyRing | null = () => null,
    private readonly baseFees: BaseFeeCache = new BaseFeeCache(BASE_FEE_TTL_MS),
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
    let lastKnownBlock = 0;
    let lastBlockFetchedAtMs = 0;
    let activeWorkerKey = configKey(this.worker);
    let cachedClients: {
      key: string;
      arkiv: WalletArkivClient;
      rpc: BaseloadRpcClient;
      chainId: number;
    } | null = null;
    // The wallet sends one transaction at a time and waits for its receipt, so
    // the next nonce is simply the last confirmed one plus one. Reading it back
    // from the chain before every send used to cost a call per operation; it is
    // now read once and re-read only after a failure, when what the chain thinks
    // may no longer match.
    let nextNonce: number | null = null;
    // Gas limits observed per batch shape, so viem never has to estimate.
    const gasLimitByShape = new Map<string, bigint>();

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

          // Minting is lazy and slow (the generator solves a captcha), so the
          // first pass through the loop may sit here for a while; a failure
          // surfaces as a worker error and is retried on the next pass.
          const endpoint = await resolveRpcEndpoint(
            this.rpcKeys,
            this.runtimeConfig.rpcUrl,
            worker.id,
            this.rpcKeys ? null : this.getKeyRing(),
          );
          const clientKey = JSON.stringify({
            rpcUrl: endpoint.url,
            headers: endpoint.headers,
            mnemonic: this.runtimeConfig.mnemonic,
            payloadProvider: this.runtimeConfig.payloadProvider,
            walletNumber: worker.walletNumber,
          });
          if (cachedClients === null || cachedClients.key !== clientKey) {
            const rpc = createRpcClient(endpoint, this.getKeyRing());
            const chainId = await rpc.getChainId();
            cachedClients = {
              key: clientKey,
              arkiv: createArkivClient(worker, this.runtimeConfig, chainId, endpoint),
              rpc,
              chainId,
            };
            // A new endpoint may be a different node with a different view of
            // the mempool; re-read the nonce before trusting it again.
            nextNonce = null;
          }
          const clients = cachedClients;

          // Only spend a call on the height when a block window depends on it;
          // otherwise refresh it occasionally just so the status view is not stale.
          let currentBlock = lastKnownBlock;
          if (needsCurrentBlock(worker)) {
            currentBlock = await clients.rpc.getBlockNumber();
            lastKnownBlock = currentBlock;
            lastBlockFetchedAtMs = nowMs;
          } else if (nowMs - lastBlockFetchedAtMs >= BLOCK_DISPLAY_REFRESH_MS) {
            currentBlock = await clients.rpc.getBlockNumber();
            lastKnownBlock = currentBlock;
            lastBlockFetchedAtMs = nowMs;
          }
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

          if (limitState.type === "outside-schedule") {
            this.postStatus("waiting", {
              currentBlock: limitState.currentBlock,
              message: `Outside schedule (${describeBaseloadSchedule(worker)})`,
              ...statusCounts(),
            });
            // Windows are minute-granular; a short sleep keeps the status
            // fresh and the wake-up inside the first few seconds of a window.
            await sleep(5_000, this.abortController.signal);
            continue;
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

          const maxFeePerGas = parseGweiToWei(worker.maxGasPriceGwei);

          // The cap is a promise not to pay more than this. Sending under the
          // base fee would either be refused or sit in the mempool until the
          // fee drops, so hold the batch back and say why.
          const baseFeeWei = await this.baseFees.read(clients.rpc);
          if (isOutpriced(baseFeeWei, maxFeePerGas)) {
            this.postStatus("outpriced", {
              currentBlock,
              message: `Base fee ${formatGweiShort(baseFeeWei!)} gwei is above the ${worker.maxGasPriceGwei} gwei cap`,
              ...statusCounts(),
            });
            await sleep(5_000, this.abortController.signal);
            continue;
          }

          attemptsThisMinute += 1;
          counters.attemptedCount += 1;
          operationIndex += 1;

          // Note for an agent:
          // This code was changed by hand and do not change the following parameters:
          // maxPriorityFeePerGas is OK to be minimal and 1
          const SUFFICIENT_PRIORITY_FEE_PER_GAS = 2n;

          /**
           * Sends one batch and waits for it to land: one `eth_sendRawTransaction`
           * plus the receipt polls, and nothing else. Nonce, gas limit and chain
           * id are all supplied, so neither the SDK nor viem looks anything up.
           */
          const submitAndConfirm = async (
            parameters: BaseloadMutationParameters,
          ): Promise<BaseloadMutationResult> => {
            if (nextNonce === null) {
              // Reading the latest confirmed nonce also drops any stuck pending
              // transaction of ours: the next send reuses its slot.
              nextNonce = await clients.rpc.getLatestNonce(worker.walletAddress);
            }
            const shape = baseloadGasShapeKey(parameters);
            const gas = gasLimitByShape.get(shape);
            // Every send moves the wallet's nonce on, so anything that goes wrong
            // from here on leaves this worker's idea of it untrustworthy: forget
            // it and read the chain's again next time.
            let receipt: BaseloadTransactionReceipt;
            let txHash: HexString;
            try {
              txHash = await sendBaseloadMutation(
                clients.arkiv,
                parameters,
                {
                  maxFeePerGas,
                  maxPriorityFeePerGas: SUFFICIENT_PRIORITY_FEE_PER_GAS,
                  nonce: nextNonce,
                  chainId: clients.chainId,
                  // Unset for the first batch of a shape only: viem estimates it
                  // once, and the receipt below teaches us the limit from there on.
                  ...(gas !== undefined ? { gas } : {}),
                },
                estimateCurrentBlock(lastKnownBlock, lastBlockFetchedAtMs, Date.now()),
              );
              receipt = await waitForSuccessfulTransactionReceipt(
                clients.rpc,
                txHash,
                this.abortController.signal,
                async (elapsedMs) => {
                  const seconds = Math.round(elapsedMs / 1000);
                  const pendingBaseFee = await this.baseFees.read(clients.rpc).catch(() => null);
                  if (isOutpriced(pendingBaseFee, maxFeePerGas)) {
                    // The transaction is valid and will mine once the fee comes
                    // back under the cap; keep its nonce slot and keep waiting.
                    this.postStatus("outpriced", {
                      currentBlock: lastKnownBlock,
                      message: `Transaction pending ${seconds}s: base fee ${formatGweiShort(pendingBaseFee!)} gwei is above the ${worker.maxGasPriceGwei} gwei cap`,
                      txHash,
                      ...statusCounts(),
                    });
                    return true;
                  }
                  if (elapsedMs >= RECEIPT_WAIT_TIMEOUT_MS) return false;
                  this.postStatus("waiting", {
                    currentBlock: lastKnownBlock,
                    message: `Waiting ${seconds}s for the receipt`,
                    txHash,
                    ...statusCounts(),
                  });
                  return true;
                },
              );
            } catch (error) {
              nextNonce = null;
              // A batch that ran out of gas must not reuse the limit that starved it.
              gasLimitByShape.delete(shape);
              throw error;
            }
            nextNonce += 1;
            const gasUsed = readReceiptQuantity(receipt, "gasUsed");
            if (gasUsed !== null && gasUsed > 0n) {
              gasLimitByShape.set(shape, learnBaseloadGasLimit(gasUsed));
            }
            // Every receipt names the block it landed in, which keeps the height
            // the next batch resolves its expiry against fresh for free.
            const minedBlock = readReceiptQuantity(receipt, "blockNumber");
            if (minedBlock !== null && Number(minedBlock) > lastKnownBlock) {
              lastKnownBlock = Number(minedBlock);
              lastBlockFetchedAtMs = Date.now();
            }
            return decodeBaseloadMutationReceipt(txHash, receipt);
          };
          const entitiesPerRequest = getEntitiesPerRequestLimit(worker.entitiesPerRequest);

          switch (operation) {
            case "create":
            case "time-bomb-create": {
              const createCount =
                worker.behavior === "create-update" || worker.behavior === "create-update-delete"
                  ? Math.min(entitiesPerRequest, Math.max(0, worker.entityPoolSize - pool.length))
                  : entitiesPerRequest;
              if (createCount <= 0) throw new Error("No pool room available to create entities");
              const inputs = Array.from({ length: createCount }, () => createBaseloadEntityInput(worker));
              if (operation === "time-bomb-create") {
                const expiresIn = getTimeBombRemainingSeconds(detonationAtMs, Date.now());
                for (const input of inputs) input.expiresIn = expiresIn;
              }
              this.postStatus("running", {
                currentBlock,
                message:
                  operation === "time-bomb-create"
                    ? `Creating ${describeEntityCount(inputs.length)} time bomb batch (expires in ${inputs[0]?.expiresIn ?? 0}s)`
                    : `Creating ${describeEntityCount(inputs.length)}`,
                ...statusCounts(),
              });
              const result = await submitAndConfirm({ creates: inputs });
              const entityKeys = readBaseloadEntityKeysFromSdkResult(
                result.createdEntities,
                result.txHash,
                inputs.length,
                "createdEntities",
              );
              counters.createdCount += entityKeys.length;
              if (worker.behavior === "create-update" || worker.behavior === "create-update-delete") {
                const expiresAtMs = Date.now() + worker.ttlSeconds * 1000;
                pool.push(...entityKeys.map((entityKey) => ({ entityKey, expiresAtMs })));
              }
              this.postStatus("running", {
                currentBlock,
                message: `Created ${describeEntityCount(entityKeys.length)}`,
                ...statusCounts(),
                entityKey: lastEntityKey(entityKeys),
                txHash: result.txHash,
              });
              break;
            }
            case "create-and-own": {
              const inputs = Array.from({ length: entitiesPerRequest }, () => createBaseloadEntityInput(worker));
              this.postStatus("running", {
                currentBlock,
                message: `Creating ${describeEntityCount(inputs.length)} before ownership change`,
                ...statusCounts(),
              });
              const created = await submitAndConfirm({ creates: inputs });
              const createdEntityKeys = readBaseloadEntityKeysFromSdkResult(
                created.createdEntities,
                created.txHash,
                inputs.length,
                "createdEntities",
              );
              counters.createdCount += createdEntityKeys.length;
              const ownershipChanges = createdEntityKeys.map((entityKey) => ({
                entityKey,
                newOwner: randomOwnerAddress(),
              }));
              this.postStatus("running", {
                currentBlock,
                message: `Changing ownership for ${describeEntityCount(ownershipChanges.length)}`,
                ...statusCounts(),
                entityKey: lastEntityKey(createdEntityKeys),
                txHash: created.txHash,
              });
              const owned = await submitAndConfirm(
                // SDK validation currently ignores ownership-only batches unless another
                // mutation key is present; an empty extensions array keeps the tx ownership-only.
                { ownershipChanges, extensions: [] },
              );
              const changedEntityKeys = readBaseloadEntityKeysFromSdkResult(
                owned.ownershipChanges,
                owned.txHash,
                ownershipChanges.length,
                "ownershipChanges",
              );
              counters.ownershipChangedCount += changedEntityKeys.length;
              this.postStatus("running", {
                currentBlock,
                message: `Ownership changed for ${describeEntityCount(changedEntityKeys.length)}`,
                ...statusCounts(),
                entityKey: lastEntityKey(changedEntityKeys),
                txHash: owned.txHash,
              });
              break;
            }
            case "update": {
              const entries = pickSoonestExpiringPoolEntries(
                pool,
                Math.min(entitiesPerRequest, pool.length),
              );
              if (entries.length === 0) throw new Error("No pool entity available to update");
              this.postStatus("running", {
                currentBlock,
                message: `Updating ${describeEntityCount(entries.length)}`,
                ...statusCounts(),
              });
              let result: BaseloadMutationResult;
              try {
                result = await submitAndConfirm({
                  updates: entries.map((entry) => createBaseloadUpdateInput(worker, entry.entityKey)),
                });
              } catch (error) {
                if (error instanceof BaseloadTransactionRevertedError) {
                  const revertedEntries = new Set(entries);
                  pool = pool.filter((candidate) => !revertedEntries.has(candidate));
                }
                throw error;
              }
              const updatedEntityKeys = readBaseloadEntityKeysFromSdkResult(
                result.updatedEntities,
                result.txHash,
                entries.length,
                "updatedEntities",
              );
              counters.updatedCount += updatedEntityKeys.length;
              const expiresAtMs = Date.now() + worker.ttlSeconds * 1000;
              for (const entry of entries) entry.expiresAtMs = expiresAtMs;
              this.postStatus("running", {
                currentBlock,
                message: `Updated ${describeEntityCount(updatedEntityKeys.length)}, TTL refreshed`,
                ...statusCounts(),
                entityKey: lastEntityKey(updatedEntityKeys),
                txHash: result.txHash,
              });
              break;
            }
            case "delete": {
              const entries = pickSoonestExpiringPoolEntries(
                pool,
                Math.min(entitiesPerRequest, pool.length),
              );
              if (entries.length === 0) throw new Error("No pool entity available to delete");
              this.postStatus("running", {
                currentBlock,
                message: `Deleting ${describeEntityCount(entries.length)}`,
                ...statusCounts(),
              });
              let result: BaseloadMutationResult;
              try {
                result = await submitAndConfirm({
                  deletes: entries.map((entry) => ({ entityKey: entry.entityKey })),
                });
              } catch (error) {
                if (error instanceof BaseloadTransactionRevertedError) {
                  const revertedEntries = new Set(entries);
                  pool = pool.filter((candidate) => !revertedEntries.has(candidate));
                }
                throw error;
              }
              const deletedEntityKeys = readBaseloadEntityKeysFromSdkResult(
                result.deletedEntities,
                result.txHash,
                entries.length,
                "deletedEntities",
              );
              counters.deletedCount += deletedEntityKeys.length;
              const deletedEntries = new Set(entries);
              pool = pool.filter((candidate) => !deletedEntries.has(candidate));
              this.postStatus("running", {
                currentBlock,
                message: `Deleted ${describeEntityCount(deletedEntityKeys.length)}`,
                ...statusCounts(),
                entityKey: lastEntityKey(deletedEntityKeys),
                txHash: result.txHash,
              });
              break;
            }
          }
        } catch (error) {
          if (this.abortController.signal.aborted) break;
          if (isFeeCapBelowBaseFeeError(error)) {
            this.postStatus("outpriced", {
              currentBlock: lastKnownBlock,
              message: `Base fee above the ${worker.maxGasPriceGwei} gwei cap, waiting for gas to drop`,
              ...statusCounts(),
            });
            await sleep(5_000, this.abortController.signal).catch(() => undefined);
            continue;
          }
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

/**
 * The RPC endpoint a worker should use, in precedence order:
 *
 * 1. a rotating key ring (`RPC_KEY_POOL_FILE`) — one pool shared with the
 *    scanner, drawn per call so monthly quota drains evenly across the keys;
 * 2. a per-worker generated key from the Arkiv Hub generator;
 * 3. the shared `BASELOAD_RPC_NODE` exactly as before.
 */
async function resolveRpcEndpoint(
  pool: BaseloadRpcKeyPool | null,
  rpcUrl: string,
  workerId: string,
  ring: RpcKeyRing | null = null,
): Promise<BaseloadRpcEndpoint> {
  if (ring) {
    const key = ring.leaseFor(workerId);
    if (key) return { url: rpcUrl, headers: { "x-api-key": key }, key };
  }
  if (!pool) return bareRpcEndpoint(rpcUrl);
  return pool.endpointFor(rpcUrl, workerId);
}

function createArkivClient(
  worker: BaseloadWorkerConfig,
  runtimeConfig: BaseloadRuntimeConfig,
  chainId: number,
  endpoint: BaseloadRpcEndpoint,
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
      default: { http: [endpoint.url] },
    },
  });

  return createWalletClient({
    chain,
    transport: http(endpoint.url, { fetchOptions: { headers: endpoint.headers } }),
    account,
  });
}

function createRpcClient(
  endpoint: BaseloadRpcEndpoint,
  ring: RpcKeyRing | null = null,
): BaseloadRpcClient {
  return {
    getChainId: async () => {
      const result = await callRpc(endpoint, "eth_chainId", [], ring);
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
      const result = await callRpc(endpoint, "eth_blockNumber", [], ring);
      if (typeof result !== "string") {
        throw new Error("RPC eth_blockNumber returned a non-string result");
      }
      return Number(BigInt(result));
    },
    getLatestNonce: async (address) => {
      const result = await callRpc(endpoint, "eth_getTransactionCount", [address, "latest"], ring);
      if (typeof result !== "string") {
        throw new Error("RPC eth_getTransactionCount returned a non-string result");
      }
      const nonce = BigInt(result);
      if (nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`RPC eth_getTransactionCount returned out-of-range nonce ${nonce.toString()}`);
      }
      return Number(nonce);
    },
    getBaseFeeWei: async () => {
      const result = await callRpc(endpoint, "eth_getBlockByNumber", ["latest", false], ring);
      if (!isRecord(result)) {
        throw new Error("RPC eth_getBlockByNumber returned a non-object block");
      }
      const baseFee = result.baseFeePerGas;
      if (baseFee === undefined || baseFee === null) return null;
      if (typeof baseFee !== "string") {
        throw new Error("RPC eth_getBlockByNumber returned a non-string baseFeePerGas");
      }
      return BigInt(baseFee);
    },
    waitForTransactionReceipt: async (txHash, signal, onStall) => {
      // A receipt cannot exist before the next block, so the first poll of a
      // freshly sent transaction is always wasted. Wait out roughly one block
      // first, and jitter every wait: without it every worker polls on the same
      // tick and the fleet's traffic arrives as spikes that trip the per-IP
      // rate limit while the average budget sits half idle.
      const startedAtMs = Date.now();
      let lastStallCheckMs = startedAtMs;
      await sleep(jitteredDelay(RECEIPT_FIRST_POLL_DELAY_MS), signal);
      while (!signal.aborted) {
        const result = await callRpc(endpoint, "eth_getTransactionReceipt", [txHash], ring);
        if (result !== null) {
          if (!isRecord(result)) {
            throw new Error(`RPC eth_getTransactionReceipt returned a non-object receipt for ${txHash}`);
          }
          return result;
        }
        const now = Date.now();
        if (onStall && now - lastStallCheckMs >= RECEIPT_STALL_CHECK_MS) {
          lastStallCheckMs = now;
          if (!(await onStall(now - startedAtMs))) {
            throw new BaseloadReceiptTimeoutError(txHash, now - startedAtMs);
          }
        }
        await sleep(jitteredDelay(RECEIPT_POLL_INTERVAL_MS), signal);
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

export function readBaseloadEntityKeysFromSdkResult(
  sdkEntityKeys: unknown,
  txHash: string,
  expectedCount: number,
  fieldName: string,
): HexString[] {
  if (!Array.isArray(sdkEntityKeys)) {
    throw new Error(
      `Unable to trust ${fieldName} from transaction ${txHash}: SDK returned a non-array value`,
    );
  }
  if (sdkEntityKeys.length !== expectedCount) {
    throw new Error(
      `Unable to trust ${fieldName} from transaction ${txHash}: expected ${expectedCount} keys but SDK returned ${sdkEntityKeys.length}`,
    );
  }
  return sdkEntityKeys.map((entityKey, index) => {
    if (!isBytes32Hex(entityKey)) {
      throw new Error(
        `Unable to trust ${fieldName}[${index}] from transaction ${txHash}: SDK returned invalid entity key ${String(
          entityKey,
        )}`,
      );
    }
    return entityKey;
  });
}

export function isBaseloadTransactionReceiptSuccessful(receipt: BaseloadTransactionReceipt): boolean {
  const status = receipt.status;
  if (status === undefined || status === null) return true;

  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    if (normalized === "0x1" || normalized === "1") return true;
    if (normalized === "0x0" || normalized === "0") return false;
  }

  if (typeof status === "number") return status === 1;
  if (typeof status === "bigint") return status === 1n;
  if (typeof status === "boolean") return status;

  throw new Error(`Transaction receipt has unsupported status value ${safeStringify(status)}`);
}

async function waitForSuccessfulTransactionReceipt(
  rpc: BaseloadRpcClient,
  txHash: HexString,
  signal: AbortSignal,
  onStall?: (elapsedMs: number) => Promise<boolean>,
): Promise<BaseloadTransactionReceipt> {
  const receipt = await rpc.waitForTransactionReceipt(txHash, signal, onStall);
  if (!isBaseloadTransactionReceiptSuccessful(receipt)) {
    throw new BaseloadTransactionRevertedError(txHash, receipt);
  }
  return receipt;
}

/**
 * Submits a batch over the SDK's advanced path and returns as soon as the node
 * accepts it.
 *
 * The everyday `executeBatch` bundles build + send + wait + decode, and pays
 * for the whole bundle in RPC calls: a height lookup, a nonce, a gas estimate,
 * then viem polling for the receipt. Here every input is supplied up front, so
 * submitting a batch costs exactly one `eth_sendRawTransaction`; the caller owns
 * the waiting (see {@link waitForSuccessfulTransactionReceipt}) and decodes the
 * receipt locally (see {@link decodeBaseloadMutationReceipt}).
 */
export async function sendBaseloadMutation(
  client: WalletArkivClient,
  parameters: BaseloadMutationParameters,
  txParams: BaseloadTxParams,
  currentBlock: bigint | undefined,
): Promise<HexString> {
  const result = await sendMutation(client, toSdkMutationParameters(parameters) as EntityMutationOps, {
    ...(currentBlock !== undefined ? { currentBlock } : {}),
    txParams,
  });
  if (!isBytes32Hex(result?.txHash)) {
    throw new Error(`SDK sendMutation returned an invalid transaction hash: ${safeStringify(result)}`);
  }
  return result.txHash;
}

/**
 * Reads the entity keys a mined batch produced straight out of the receipt the
 * worker already waited for. Zero RPC calls — the alternative, asking the SDK
 * for the mutation result, would re-fetch the same receipt.
 */
export function decodeBaseloadMutationReceipt(
  txHash: HexString,
  receipt: BaseloadTransactionReceipt,
): BaseloadMutationResult {
  const decoded = decodeMutationResult({
    ...receipt,
    // The engine events are all this reads; the rest of the receipt is passed
    // through untouched.
    logs: Array.isArray(receipt.logs) ? receipt.logs : [],
  } as unknown as TransactionReceipt);
  return {
    txHash,
    createdEntities: readOptionalEntityKeyArray(decoded.createdEntities, "createdEntities", txHash),
    updatedEntities: readOptionalEntityKeyArray(decoded.patchedEntities, "patchedEntities", txHash),
    deletedEntities: readOptionalEntityKeyArray(decoded.deletedEntities, "deletedEntities", txHash),
    extendedEntities: readOptionalEntityKeyArray(decoded.extendedEntities, "extendedEntities", txHash),
    ownershipChanges: readOptionalEntityKeyArray(decoded.ownershipChanges, "ownershipChanges", txHash),
  };
}

/**
 * The chain head to resolve a batch's relative expiry against, without spending
 * a call on it.
 *
 * Heights come in free with every receipt, but a worker that sends rarely still
 * holds an old one, and resolving a lifetime against a stale head would cut the
 * entity's life short. Blocks arrive on a fixed cadence, so carry the last known
 * height forward by the time that has passed since it was read.
 */
export function estimateCurrentBlock(
  lastKnownBlock: number,
  lastKnownBlockAtMs: number,
  nowMs: number,
): bigint | undefined {
  if (lastKnownBlock <= 0 || lastKnownBlockAtMs <= 0) return undefined;
  const elapsedBlocks = Math.max(0, Math.floor((nowMs - lastKnownBlockAtMs) / (BLOCK_TIME_SECONDS * 1000)));
  return BigInt(lastKnownBlock + elapsedBlocks);
}

/**
 * Identifies batches whose gas cost should be the same: same operation mix, same
 * batch size. Worker payload and attribute sizes are fixed by its config, so a
 * shape's gas is stable and worth remembering.
 */
export function baseloadGasShapeKey(parameters: BaseloadMutationParameters): string {
  return [
    parameters.creates?.length ?? 0,
    parameters.updates?.length ?? 0,
    parameters.deletes?.length ?? 0,
    parameters.extensions?.length ?? 0,
    parameters.ownershipChanges?.length ?? 0,
  ].join(":");
}

/** Headroom over an observed burn, so a slightly heavier batch of the same shape still fits. */
const GAS_LIMIT_HEADROOM_PERCENT = 50n;
/** Never learn a limit below this: tiny observations would starve the next batch. */
const MIN_LEARNED_GAS_LIMIT = 200_000n;
/** Nor above this, so one odd receipt cannot push a worker past what a block can hold. */
const MAX_LEARNED_GAS_LIMIT = 30_000_000n;

/** Turns the gas a batch actually burnt into the limit to send the next one with. */
export function learnBaseloadGasLimit(gasUsed: bigint): bigint {
  const withHeadroom = (gasUsed * (100n + GAS_LIMIT_HEADROOM_PERCENT)) / 100n;
  if (withHeadroom < MIN_LEARNED_GAS_LIMIT) return MIN_LEARNED_GAS_LIMIT;
  if (withHeadroom > MAX_LEARNED_GAS_LIMIT) return MAX_LEARNED_GAS_LIMIT;
  return withHeadroom;
}

/** Reads a quantity field (`gasUsed`, `blockNumber`, …) off a raw JSON-RPC receipt. */
export function readReceiptQuantity(
  receipt: BaseloadTransactionReceipt,
  field: string,
): bigint | null {
  const value = receipt[field];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

const BLOCK_TIME_SECONDS = 2;

// The SDK requires a lifetime to be a positive multiple of the 2s block time;
// round odd TTLs (e.g. a time bomb's remaining seconds) up to the next block.
function toBlockAlignedExpiresIn(expiresIn: number): number {
  return Math.max(BLOCK_TIME_SECONDS, Math.ceil(expiresIn / BLOCK_TIME_SECONDS) * BLOCK_TIME_SECONDS);
}

function toExpires(expiresIn: number) {
  return ExpirationTime.fromSeconds(toBlockAlignedExpiresIn(expiresIn));
}

// Bare numbers default to i32 in SDK 0.8, which the baseload's 48-bit random
// values overflow — tag every number as u64 to keep the old value range.
function toAttributeInputs(
  attributes: Array<{ key: string; value: string | number }>,
): Record<string, string | ReturnType<typeof u64>> {
  return Object.fromEntries(
    attributes.map((attribute) => [
      attribute.key,
      typeof attribute.value === "number" ? u64(attribute.value) : attribute.value,
    ]),
  );
}

export function toSdkMutationParameters(parameters: BaseloadMutationParameters): unknown {
  const updates = parameters.updates ?? [];
  // The engine ignores expiry on UPDATE, but the pool bookkeeping treats an
  // update as a TTL refresh — so each update also extends in the same batch.
  //
  // The extension carries one extra block: the engine measures expiry in blocks
  // and reverts the whole batch with ExpiryNotExtended when the new expiry only
  // matches the current one, which is exactly what happens when an update lands
  // in the same block that last set the entity's expiry (same TTL, same block).
  const extensions = [
    ...updates.map((input) => ({
      entityKey: input.entityKey,
      expires: ExpirationTime.fromSeconds(
        toBlockAlignedExpiresIn(input.expiresIn) + BLOCK_TIME_SECONDS,
      ),
    })),
    ...(parameters.extensions ?? []).map((extension) => ({
      entityKey: extension.entityKey,
      expires: toExpires(extension.expiresIn),
    })),
  ];
  return {
    ...(parameters.creates
      ? {
          creates: parameters.creates.map((input) => ({
            payload: input.payload,
            contentType: input.contentType,
            attributes: toAttributeInputs(input.attributes),
            expires: toExpires(input.expiresIn),
          })),
        }
      : {}),
    ...(updates.length
      ? {
          // SDK 0.8 replaced whole-entity updates with patches; `set` overwrites
          // the named attributes and the payload replaces the entity's contents.
          patches: updates.map((input) => ({
            entityKey: input.entityKey,
            payload: input.payload,
            contentType: input.contentType,
            set: toAttributeInputs(input.attributes),
          })),
        }
      : {}),
    ...(parameters.deletes ? { deletes: parameters.deletes } : {}),
    ...(extensions.length ? { extensions } : {}),
    ...(parameters.ownershipChanges ? { ownershipChanges: parameters.ownershipChanges } : {}),
  };
}

function readOptionalEntityKeyArray(value: unknown, fieldName: string, txHash: HexString): HexString[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `SDK executeBatch returned invalid ${fieldName} for transaction ${txHash}: expected array`,
    );
  }
  return value.map((entityKey, index) => {
    if (!isBytes32Hex(entityKey)) {
      throw new Error(
        `SDK executeBatch returned invalid ${fieldName}[${index}] for transaction ${txHash}: ${String(
          entityKey,
        )}`,
      );
    }
    return entityKey;
  });
}

class BaseloadReceiptTimeoutError extends Error {
  constructor(txHash: HexString, elapsedMs: number) {
    super(
      `Transaction ${txHash} has no receipt after ${Math.round(elapsedMs / 1000)}s; giving up on it and re-reading the nonce`,
    );
    this.name = "BaseloadReceiptTimeoutError";
  }
}

class BaseloadTransactionRevertedError extends Error {
  constructor(txHash: HexString, receipt: BaseloadTransactionReceipt) {
    super(`Transaction ${txHash} was mined but reverted: ${safeStringify(receipt)}`);
    this.name = "BaseloadTransactionRevertedError";
  }
}

function isBytes32Hex(value: unknown): value is HexString {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function describeEntityCount(count: number): string {
  return `${count} ${count === 1 ? "entity" : "entities"}`;
}

function lastEntityKey(entityKeys: readonly HexString[]): HexString {
  const entityKey = entityKeys[entityKeys.length - 1];
  if (!entityKey) throw new Error("Expected at least one entity key");
  return entityKey;
}

async function callRpc(
  endpoint: BaseloadRpcEndpoint,
  method: string,
  params: unknown[],
  ring: RpcKeyRing | null = null,
): Promise<unknown> {
  // Worker statuses are served over HTTP, so never let a key reach an error message.
  const target = describeRpcTarget(endpoint.url);
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...endpoint.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (error) {
    throw new Error(
      `RPC ${method} request to ${target} failed before any response: ${describeError(error)}`,
      { cause: error },
    );
  }
  const text = await response.text();
  // Report before throwing: a QUOTA_EXCEEDED body is exactly the signal that
  // must retire this key, and it arrives on a non-ok response.
  if (ring && endpoint.key) {
    ring.noteResponse(endpoint.key, response.status, response.headers, text);
  }
  if (!response.ok) {
    throw new Error(
      `RPC ${method} at ${target} failed with HTTP ${response.status} ${response.statusText}: ${text}`,
    );
  }

  let body: { result?: unknown; error?: { message?: string; code?: number; data?: unknown } };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`RPC ${method} at ${target} returned non-JSON body: ${text}`);
  }
  if (body.error) {
    const code = typeof body.error.code === "number" ? ` (code ${body.error.code})` : "";
    const data = body.error.data === undefined ? "" : ` data=${JSON.stringify(body.error.data)}`;
    throw new Error(
      `RPC ${method} at ${target} failed: ${body.error.message ?? JSON.stringify(body.error)}${code}${data}`,
    );
  }
  return body.result;
}

/** Renders an RPC URL for logs, masking a key carried as the last path segment. */
export function describeRpcTarget(rpcUrl: string): string {
  return rpcUrl.replace(/ark_live_[A-Za-z0-9_-]+/g, (key) => maskKey(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
