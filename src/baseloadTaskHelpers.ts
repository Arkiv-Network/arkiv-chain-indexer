import { type BaseloadWorkerConfig } from "./baseloadConfig";

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

export type RandomBytes = (size: number) => Uint8Array;

export function getMinuteAttemptLimit(createsPerMinute: number): number {
  if (!Number.isFinite(createsPerMinute) || createsPerMinute <= 0) return 0;
  return Math.floor(createsPerMinute);
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

  return attributes;
}

export function parseGweiToWei(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Gas price must be a non-negative finite number");
  }

  const text = value.toFixed(9);
  const [wholeRaw, fractionRaw = ""] = text.split(".");
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
