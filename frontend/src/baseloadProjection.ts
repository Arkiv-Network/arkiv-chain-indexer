import type { BaseloadWorkerBehavior, BaseloadWorkerConfig } from "./api";
import {
  isWithinWindow,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  parseDailyWindow,
  parseHourlyWindow,
  type BaseloadTimeWindow,
} from "./baseloadSchedule";

export interface BaseloadHourProjection {
  /** Hour of the day, UTC. */
  hour: number;
  /** Transactions the fleet is expected to send during this hour. */
  txCount: number;
  /** Payload bytes those transactions carry (calldata overhead excluded). */
  payloadBytes: number;
  /** Workers active for at least one minute of the hour. */
  activeWorkers: number;
}

export interface BaseloadTrafficProjection {
  hours: BaseloadHourProjection[];
  dayTxCount: number;
  dayPayloadBytes: number;
  peakTxCount: number;
  peakPayloadBytes: number;
}

/**
 * How one scheduled operation turns into chain traffic. `txPerOp` is the
 * transactions one operation sends; `payloadShare` is the share of those that
 * carry a fresh payload (deletes and ownership changes carry none).
 */
const BEHAVIOR_TRAFFIC: Record<BaseloadWorkerBehavior, { txPerOp: number; payloadShare: number }> = {
  "create": { txPerOp: 1, payloadShare: 1 },
  "create-update": { txPerOp: 1, payloadShare: 1 },
  "time-bomb": { txPerOp: 1, payloadShare: 1 },
  // One create batch, then one ownership-change batch for the same entities.
  "create-ownership": { txPerOp: 2, payloadShare: 0.5 },
  // Steady state alternates update and delete once the pool is full.
  "create-update-delete": { txPerOp: 1, payloadShare: 0.5 },
};

type ProjectionWorker = Pick<
  BaseloadWorkerConfig,
  | "behavior"
  | "opsPerMinute"
  | "entitiesPerRequest"
  | "singleCreatePayloadSize"
  | "dailyWindow"
  | "hourlyWindow"
>;

/**
 * Expected traffic per UTC hour from the configured schedules. Block and
 * duration limits are ignored: this is the steady-state shape of a day, not a
 * forecast of the next 24 hours. A worker whose window string fails to parse
 * counts as always on, matching how the backend treats a missing window.
 */
export function projectBaseloadTraffic(workers: readonly ProjectionWorker[]): BaseloadTrafficProjection {
  const hours: BaseloadHourProjection[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    txCount: 0,
    payloadBytes: 0,
    activeWorkers: 0,
  }));

  for (const worker of workers) {
    const traffic = BEHAVIOR_TRAFFIC[worker.behavior] ?? BEHAVIOR_TRAFFIC.create;
    const daily = safeParse(worker.dailyWindow, parseDailyWindow);
    const hourly = safeParse(worker.hourlyWindow, parseHourlyWindow);
    const txPerMinute = worker.opsPerMinute * traffic.txPerOp;
    const bytesPerMinute =
      worker.opsPerMinute * traffic.payloadShare * worker.entitiesPerRequest * worker.singleCreatePayloadSize;

    for (const entry of hours) {
      const activeMinutes = countActiveMinutes(entry.hour, daily, hourly);
      if (activeMinutes === 0) continue;
      entry.activeWorkers += 1;
      entry.txCount += txPerMinute * activeMinutes;
      entry.payloadBytes += bytesPerMinute * activeMinutes;
    }
  }

  return {
    hours,
    dayTxCount: hours.reduce((sum, entry) => sum + entry.txCount, 0),
    dayPayloadBytes: hours.reduce((sum, entry) => sum + entry.payloadBytes, 0),
    peakTxCount: Math.max(0, ...hours.map((entry) => entry.txCount)),
    peakPayloadBytes: Math.max(0, ...hours.map((entry) => entry.payloadBytes)),
  };
}

export interface BaseloadMinuteProjection {
  /** Minute within the hour. */
  minute: number;
  /** Transactions expected during this one minute of the given hour. */
  txCount: number;
  payloadBytes: number;
  activeWorkers: number;
}

/** The same model resolved to single minutes of one UTC hour. */
export function projectBaseloadMinutes(
  workers: readonly ProjectionWorker[],
  hour: number,
): BaseloadMinuteProjection[] {
  const minutes: BaseloadMinuteProjection[] = Array.from({ length: MINUTES_PER_HOUR }, (_, minute) => ({
    minute,
    txCount: 0,
    payloadBytes: 0,
    activeWorkers: 0,
  }));
  for (const worker of workers) {
    const traffic = BEHAVIOR_TRAFFIC[worker.behavior] ?? BEHAVIOR_TRAFFIC.create;
    const daily = safeParse(worker.dailyWindow, parseDailyWindow);
    const hourly = safeParse(worker.hourlyWindow, parseHourlyWindow);
    const txPerMinute = worker.opsPerMinute * traffic.txPerOp;
    const bytesPerMinute =
      worker.opsPerMinute * traffic.payloadShare * worker.entitiesPerRequest * worker.singleCreatePayloadSize;
    for (const entry of minutes) {
      if (daily && !isWithinWindow(daily, hour * MINUTES_PER_HOUR + entry.minute, MINUTES_PER_DAY)) continue;
      if (hourly && !isWithinWindow(hourly, entry.minute, MINUTES_PER_HOUR)) continue;
      entry.activeWorkers += 1;
      entry.txCount += txPerMinute;
      entry.payloadBytes += bytesPerMinute;
    }
  }
  return minutes;
}

export function countActiveMinutes(
  hour: number,
  daily: BaseloadTimeWindow | null,
  hourly: BaseloadTimeWindow | null,
): number {
  let active = 0;
  for (let minute = 0; minute < MINUTES_PER_HOUR; minute += 1) {
    if (daily && !isWithinWindow(daily, hour * MINUTES_PER_HOUR + minute, MINUTES_PER_DAY)) continue;
    if (hourly && !isWithinWindow(hourly, minute, MINUTES_PER_HOUR)) continue;
    active += 1;
  }
  return active;
}

function safeParse(
  value: string | null | undefined,
  parse: (value: string) => BaseloadTimeWindow,
): BaseloadTimeWindow | null {
  if (!value) return null;
  try {
    return parse(value);
  } catch {
    return null;
  }
}

export function formatCountShort(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
