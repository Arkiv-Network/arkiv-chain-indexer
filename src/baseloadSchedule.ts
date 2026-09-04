/**
 * Worker activity windows. A worker may carry a daily window ("04:30-18:30")
 * and an hourly window ("24-58"); when both are set the worker is active only
 * while both hold. Times are UTC, ends are exclusive, and a window whose end is
 * not after its start wraps around midnight or the top of the hour. An hourly
 * end may also run past 60 ("50-70" = minute 50 to minute 10 of the next hour)
 * so a window crossing the hour reads naturally; it may not exceed one hour.
 *
 * This file is mirrored verbatim in frontend/src/baseloadSchedule.ts.
 */

export interface BaseloadTimeWindow {
  /** Minutes from the period start, inclusive. */
  start: number;
  /** Minutes from the period start, exclusive; may equal the period length. */
  end: number;
}

export interface BaseloadScheduleFields {
  /** Missing (older backends) reads the same as null: always on. */
  dailyWindow?: string | null;
  hourlyWindow?: string | null;
}

export const MINUTES_PER_DAY = 24 * 60;
export const MINUTES_PER_HOUR = 60;
/** An hourly window may end in the following hour, so the end runs to 120. */
export const MAX_HOURLY_WINDOW_END = 2 * MINUTES_PER_HOUR;

export function parseDailyWindow(value: string): BaseloadTimeWindow {
  const [rawStart, rawEnd] = splitWindow("Daily window", value);
  const start = parseClock("Daily window", rawStart);
  const end = parseClock("Daily window", rawEnd);
  return checkWindow("Daily window", start, end, MINUTES_PER_DAY);
}

export function parseHourlyWindow(value: string): BaseloadTimeWindow {
  const [rawStart, rawEnd] = splitWindow("Hourly window", value);
  const start = parseMinute("Hourly window", rawStart, MINUTES_PER_HOUR - 1);
  const end = parseMinute("Hourly window", rawEnd, MAX_HOURLY_WINDOW_END);
  if (end - start > MINUTES_PER_HOUR) {
    throw new Error("Hourly window may not be longer than an hour");
  }
  return checkWindow("Hourly window", start, end, MINUTES_PER_HOUR);
}

export function formatDailyWindow(window: BaseloadTimeWindow): string {
  return `${formatClock(window.start)}-${formatClock(window.end)}`;
}

export function formatHourlyWindow(window: BaseloadTimeWindow): string {
  return `${pad2(window.start)}-${pad2(window.end)}`;
}

/** Accepts null, "", or a window string; returns the canonical string or null. */
export function normalizeDailyWindow(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Daily window must be a string like 04:30-18:30");
  if (value.trim() === "") return null;
  return formatDailyWindow(parseDailyWindow(value));
}

export function normalizeHourlyWindow(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Hourly window must be a string like 24-58");
  if (value.trim() === "") return null;
  return formatHourlyWindow(parseHourlyWindow(value));
}

export function isWithinWindow(window: BaseloadTimeWindow, minute: number, period: number): boolean {
  const end = window.end % period;
  if (window.start < end) return minute >= window.start && minute < end;
  return minute >= window.start || minute < end;
}

export function hasBaseloadSchedule(worker: BaseloadScheduleFields): boolean {
  return Boolean(worker.dailyWindow) || Boolean(worker.hourlyWindow);
}

export function isBaseloadScheduleActive(worker: BaseloadScheduleFields, nowMs: number): boolean {
  const now = new Date(nowMs);
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (worker.dailyWindow) {
    if (!isWithinWindow(parseDailyWindow(worker.dailyWindow), minuteOfDay, MINUTES_PER_DAY)) return false;
  }
  if (worker.hourlyWindow) {
    if (!isWithinWindow(parseHourlyWindow(worker.hourlyWindow), now.getUTCMinutes(), MINUTES_PER_HOUR)) {
      return false;
    }
  }
  return true;
}

/** Plain-English reading of the schedule, or null when the worker is always on. */
export function describeBaseloadSchedule(worker: BaseloadScheduleFields): string | null {
  const parts: string[] = [];
  if (worker.dailyWindow) parts.push(`daily ${worker.dailyWindow} UTC`);
  if (worker.hourlyWindow) parts.push(`minutes ${worker.hourlyWindow} of every hour`);
  return parts.length ? parts.join(", ") : null;
}

function splitWindow(label: string, value: string): [string, string] {
  const parts = value.trim().split("-");
  const [start, end] = parts;
  if (parts.length !== 2 || start === undefined || end === undefined) {
    throw new Error(`${label} must look like start-end`);
  }
  return [start.trim(), end.trim()];
}

function parseClock(label: string, value: string): number {
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error(`${label} times must look like HH:MM`);
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) {
    throw new Error(`${label} times must be between 00:00 and 24:00`);
  }
  return hours * 60 + minutes;
}

function parseMinute(label: string, value: string, max: number): number {
  if (!/^\d{1,3}$/.test(value)) throw new Error(`${label} minutes must be whole numbers`);
  const minute = Number(value);
  if (minute > max) throw new Error(`${label} minutes must be between 0 and ${max}`);
  return minute;
}

function checkWindow(label: string, start: number, end: number, period: number): BaseloadTimeWindow {
  if (start >= period) throw new Error(`${label} start must be before the end of the period`);
  if (start === end) throw new Error(`${label} start and end must differ`);
  return { start, end };
}

function formatClock(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
