import {
  MAX_BASELOAD_ENTITIES_PER_REQUEST,
  type BaseloadWorkerConfig,
} from "./baseloadConfig";

export const BASELOAD_PROJECT_ATTRIBUTE = {
  key: "project",
  value: "arkiv-chain-indexer-baseload",
} as const;

export type BaseloadTaskLimitState =
  | { type: "before-start"; currentBlock: number }
  | { type: "after-end"; currentBlock: number }
  | { type: "duration-ended" }
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

export function pickSoonestExpiringPoolEntry(
  pool: readonly BaseloadPoolEntry[],
): BaseloadPoolEntry | null {
  return pickSoonestExpiringPoolEntries(pool, 1)[0] ?? null;
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
