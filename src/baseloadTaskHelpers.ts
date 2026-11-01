import {
  MAX_BASELOAD_ENTITIES_PER_REQUEST,
  type BaseloadWorkerConfig,
} from "./baseloadConfig";
import { isBaseloadScheduleActive } from "./baseloadSchedule";

export const BASELOAD_PROJECT_ATTRIBUTE = {
  key: "project",
  value: "arkiv-chain-indexer-baseload",
} as const;

export type BaseloadTaskLimitState =
  | { type: "before-start"; currentBlock: number }
  | { type: "after-end"; currentBlock: number }
  | { type: "duration-ended" }
  | { type: "outside-schedule"; currentBlock: number }
  | { type: "active"; currentBlock: number };

export interface BaseloadCreateInput {
  payload: Uint8Array;
  contentType: "application/octet-stream";
  attributes: Array<{ key: string; value: string | number }>;
  expiresIn: number;
}

export interface BaseloadUpdateInput extends BaseloadCreateInput {
  entityKey: `0x${string}`;
}

export interface BaseloadPoolEntry {
  entityKey: `0x${string}`;
  expiresAtMs: number;
}

export type BaseloadOperationKind =
  | "create"
  | "update"
  | "delete"
  | "create-and-own"
  | "time-bomb-create";

export type RandomBytes = (size: number) => Uint8Array;

// Entities whose estimated on-chain expiry is closer than this margin are
// treated as lost: a refresh transaction would likely land after expiry.
export const POOL_EXPIRY_SAFETY_MARGIN_MS = 2_000;

// Below this remaining TTL a time bomb create can no longer land before the
// detonation moment, so the worker completes instead.
export const MIN_TIME_BOMB_TTL_SECONDS = 2;

export function getMinuteAttemptLimit(opsPerMinute: number): number {
  if (!Number.isFinite(opsPerMinute) || opsPerMinute <= 0) return 0;
  return Math.floor(opsPerMinute);
}

export function getEntitiesPerRequestLimit(entitiesPerRequest: number): number {
  if (!Number.isFinite(entitiesPerRequest) || entitiesPerRequest < 1) return 1;
  return Math.min(Math.floor(entitiesPerRequest), MAX_BASELOAD_ENTITIES_PER_REQUEST);
}

export function chooseBaseloadOperation(
  worker: Pick<BaseloadWorkerConfig, "behavior" | "entityPoolSize">,
  currentPoolSize: number,
  operationIndex: number,
): BaseloadOperationKind {
  switch (worker.behavior) {
    case "create":
      return "create";
    case "create-ownership":
      return "create-and-own";
    case "time-bomb":
      return "time-bomb-create";
    case "create-update":
      return currentPoolSize < worker.entityPoolSize ? "create" : "update";
    case "create-update-delete": {
      if (currentPoolSize === 0) return "create";
      if (currentPoolSize < worker.entityPoolSize) {
        return operationIndex % 2 === 0 ? "create" : "update";
      }
      return operationIndex % 2 === 0 ? "update" : "delete";
    }
  }
}

export function pruneExpiredPoolEntries(
  pool: readonly BaseloadPoolEntry[],
  nowMs: number,
  marginMs = POOL_EXPIRY_SAFETY_MARGIN_MS,
): BaseloadPoolEntry[] {
  return pool.filter((entry) => entry.expiresAtMs - marginMs > nowMs);
}

export function pickSoonestExpiringPoolEntries(
  pool: readonly BaseloadPoolEntry[],
  count: number,
): BaseloadPoolEntry[] {
  if (count <= 0) return [];
  return [...pool].sort((a, b) => a.expiresAtMs - b.expiresAtMs).slice(0, count);
}

export function getTimeBombDetonationMs(
  worker: Pick<BaseloadWorkerConfig, "timeBombOffsetSeconds">,
  runStartedAtMs: number,
): number {
  return runStartedAtMs + worker.timeBombOffsetSeconds * 1000;
}

export function getTimeBombRemainingSeconds(detonationAtMs: number, nowMs: number): number {
  return Math.ceil((detonationAtMs - nowMs) / 1000);
}

export function randomOwnerAddress(randomBytes: RandomBytes = secureRandomBytes): `0x${string}` {
  return `0x${bytesToHex(randomBytes(20))}` as `0x${string}`;
}

export function getMillisecondsUntilNextMinute(windowStartedAtMs: number, nowMs: number): number {
  return Math.max(0, windowStartedAtMs + 60_000 - nowMs);
}

/**
 * True when a worker's limits actually depend on the chain height. Workers with
 * no block window (the common load-test case) do not need `eth_blockNumber` at
 * all, and skipping it removes one RPC call from every single operation — call
 * budget is the scarce resource, so this is throughput, not just tidiness.
 */
export function needsCurrentBlock(
  worker: Pick<BaseloadWorkerConfig, "startBlock" | "endBlock">,
): boolean {
  return worker.startBlock > 0 || worker.endBlock !== null;
}

export function getBaseloadLimitState(
  worker: BaseloadWorkerConfig,
  currentBlock: number,
  runStartedAtMs: number,
  nowMs: number,
): BaseloadTaskLimitState {
  if (currentBlock < worker.startBlock) {
    return { type: "before-start", currentBlock };
  }
  if (worker.endBlock !== null && currentBlock > worker.endBlock) {
    return { type: "after-end", currentBlock };
  }
  if (worker.durationSeconds !== null && nowMs - runStartedAtMs >= worker.durationSeconds * 1000) {
    return { type: "duration-ended" };
  }
  // The schedule pauses rather than ends the run, so it comes after the
  // terminal checks: a worker outside its window still finishes on time.
  if (!isBaseloadScheduleActive(worker, nowMs)) {
    return { type: "outside-schedule", currentBlock };
  }
  return { type: "active", currentBlock };
}

export function createBaseloadEntityInput(
  worker: BaseloadWorkerConfig,
  randomBytes: RandomBytes = secureRandomBytes,
): BaseloadCreateInput {
  return {
    payload: randomBytes(worker.singleCreatePayloadSize),
    contentType: "application/octet-stream",
    attributes: createBaseloadAttributes(worker, randomBytes),
    expiresIn: worker.ttlSeconds,
  };
}

export function createBaseloadUpdateInput(
  worker: BaseloadWorkerConfig,
  entityKey: `0x${string}`,
  randomBytes: RandomBytes = secureRandomBytes,
): BaseloadUpdateInput {
  return {
    entityKey,
    ...createBaseloadEntityInput(worker, randomBytes),
  };
}

export function createBaseloadAttributes(
  worker: BaseloadWorkerConfig,
  randomBytes: RandomBytes = secureRandomBytes,
): Array<{ key: string; value: string | number }> {
  const randomId = bytesToHex(randomBytes(8));
  const attributes: Array<{ key: string; value: string | number }> = [
    BASELOAD_PROJECT_ATTRIBUTE,
  ];

  for (let index = 0; index < worker.singleCreateStringArgumentCount; index += 1) {
    attributes.push({
      key: `random_string_${index}_${randomId}`,
      value: bytesToHex(randomBytes(16)),
    });
  }

  for (let index = 0; index < worker.singleCreateNumberArgumentCount; index += 1) {
    attributes.push({
      key: `random_number_${index}_${randomId}`,
      value: bytesToSafeInteger(randomBytes(6)),
    });
  }

  // The Arkiv registry rejects entities whose attributes are not sorted by
  // key (AttributesNotSorted revert), so always submit them in byte order.
  return attributes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function parseGweiToWei(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Gas price must be a non-negative finite number");
  }

  const text = value.toFixed(9);
  const [wholeRaw = "", fractionRaw = ""] = text.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const fraction = fractionRaw.padEnd(9, "0").slice(0, 9);
  if (!/^\d+$/.test(whole) || !/^\d{9}$/.test(fraction)) {
    throw new Error("Gas price must be a decimal number");
  }
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction);
}

export function secureRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToSafeInteger(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
  }
  return value;
}

/**
 * True when a send was refused because the worker's fee cap sits below the
 * current block base fee. That is the cap doing its job, not a fault: the
 * worker should wait for gas to come down rather than report an error.
 */
export function isFeeCapBelowBaseFeeError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (candidate.name === "FeeCapTooLowError") return true;
    if (typeof candidate.message === "string" && FEE_CAP_TOO_LOW_PATTERN.test(candidate.message)) return true;
    current = candidate.cause;
  }
  return false;
}

const FEE_CAP_TOO_LOW_PATTERN =
  /cannot be lower than the block base fee|max fee per gas less than block base fee|fee cap less than block base fee/i;

export interface BaseFeeSource {
  getBaseFeeWei: () => Promise<bigint | null>;
}

/**
 * One base-fee reading shared by every worker. The fleet only needs the
 * value about once per block, so concurrent readers share a single in-flight
 * call and a fresh value is served from memory. Failures are not cached.
 */
export class BaseFeeCache {
  private value: bigint | null = null;
  private fetchedAtMs = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<bigint | null> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  read(source: BaseFeeSource): Promise<bigint | null> {
    if (this.now() - this.fetchedAtMs < this.ttlMs) return Promise.resolve(this.value);
    if (this.inFlight) return this.inFlight;
    this.inFlight = source
      .getBaseFeeWei()
      .then((value) => {
        this.value = value;
        this.fetchedAtMs = this.now();
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

export function formatGweiShort(wei: bigint): string {
  return (Number(wei) / 1e9).toFixed(3).replace(/\.?0+$/, "");
}

export function isOutpriced(baseFeeWei: bigint | null, maxFeePerGas: bigint): boolean {
  return baseFeeWei !== null && baseFeeWei > maxFeePerGas;
}

export interface BaseloadFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * A pending transaction is only replaced by one that raises both its fee cap
 * and its tip by more than this (the txpool's price bump; reth and geth both
 * default to 10%).
 */
export const REPLACEMENT_PRICE_BUMP_PERCENT = 10n;

/**
 * The fee cap a nonce's first transaction is sent with: twice the base fee,
 * so the fee can double before the transaction stops being includable, but
 * never above the worker's cap. That leaves the cap as headroom for the fee
 * bumps of a stuck transaction. Without a base fee reading, the cap itself.
 */
export function initialMaxFeePerGas(
  capWei: bigint,
  baseFeeWei: bigint | null,
  priorityFeeWei: bigint,
): bigint {
  if (baseFeeWei === null) return capWei;
  // The tip has to fit under the fee cap, even on a chain with no base fee.
  const doubled = baseFeeWei * 2n > priorityFeeWei ? baseFeeWei * 2n : priorityFeeWei;
  return doubled < capWei ? doubled : capWei;
}

/**
 * The fees for a replacement of a stuck transaction: both fields up by an
 * eighth (12.5%, rounded up) and by at least 1 wei, so the replacement rule
 * holds even for a 2 wei tip. The fee cap never climbs past the worker's cap
 * and the tip never past the fee cap; null when that clamp leaves fees the
 * txpool would refuse as an underpriced replacement.
 */
export function bumpReplacementFees(previous: BaseloadFees, capWei: bigint): BaseloadFees | null {
  const bumpedMaxFee = bumpByAnEighth(previous.maxFeePerGas);
  const maxFeePerGas = bumpedMaxFee < capWei ? bumpedMaxFee : capWei;
  const bumpedTip = bumpByAnEighth(previous.maxPriorityFeePerGas);
  const maxPriorityFeePerGas = bumpedTip < maxFeePerGas ? bumpedTip : maxFeePerGas;
  if (
    !clearsReplacementPriceBump(previous.maxFeePerGas, maxFeePerGas) ||
    !clearsReplacementPriceBump(previous.maxPriorityFeePerGas, maxPriorityFeePerGas)
  ) {
    return null;
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Whether `next` outbids `previous` by the replacement price bump. Read
 * strictly (more than 10%, no rounding down), which satisfies both reth's and
 * geth's reading of the rule.
 */
export function clearsReplacementPriceBump(previous: bigint, next: bigint): boolean {
  return next * 100n > previous * (100n + REPLACEMENT_PRICE_BUMP_PERCENT);
}

function bumpByAnEighth(wei: bigint): bigint {
  const bumped = (wei * 9n + 7n) / 8n;
  return bumped > wei ? bumped : wei + 1n;
}
