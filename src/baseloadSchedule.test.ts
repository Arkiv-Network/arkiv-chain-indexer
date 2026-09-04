import { describe, expect, test } from "bun:test";
import {
  describeBaseloadSchedule,
  isBaseloadScheduleActive,
  normalizeDailyWindow,
  normalizeHourlyWindow,
  parseDailyWindow,
  parseHourlyWindow,
} from "./baseloadSchedule";
import { getBaseloadLimitState } from "./baseloadTaskHelpers";
import { normalizeBaseloadConfig } from "./baseloadConfig";

const utc = (iso: string) => Date.parse(iso);

describe("baseload schedule windows", () => {
  test("parses and canonicalizes daily windows", () => {
    expect(parseDailyWindow("4:30-18:30")).toEqual({ start: 270, end: 1110 });
    expect(normalizeDailyWindow("4:30 - 18:30")).toBe("04:30-18:30");
    expect(normalizeDailyWindow("22-6")).toBe("22:00-06:00");
    expect(normalizeDailyWindow("0:00-24:00")).toBe("00:00-24:00");
    expect(normalizeDailyWindow("")).toBeNull();
    expect(normalizeDailyWindow(null)).toBeNull();
    expect(normalizeDailyWindow(undefined)).toBeNull();
  });

  test("parses and canonicalizes hourly windows", () => {
    expect(parseHourlyWindow("24-58")).toEqual({ start: 24, end: 58 });
    expect(normalizeHourlyWindow("5-9")).toBe("05-09");
    expect(normalizeHourlyWindow("30-60")).toBe("30-60");
    expect(normalizeHourlyWindow("  ")).toBeNull();
  });

  test("rejects malformed windows", () => {
    expect(() => normalizeDailyWindow("04:30")).toThrow("start-end");
    expect(() => normalizeDailyWindow("25:00-26:00")).toThrow("between 00:00 and 24:00");
    expect(() => normalizeDailyWindow("10:00-10:00")).toThrow("must differ");
    expect(() => normalizeDailyWindow("24:00-06:00")).toThrow("start must be before");
    expect(() => normalizeHourlyWindow("10-70")).toThrow("between 0 and 60");
    expect(() => normalizeHourlyWindow("a-b")).toThrow("whole numbers");
    expect(() => normalizeHourlyWindow(12)).toThrow("must be a string");
  });

  test("daily window is end-exclusive and UTC", () => {
    const worker = { dailyWindow: "04:30-18:30", hourlyWindow: null };
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T04:29:59Z"))).toBe(false);
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T04:30:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T18:29:59Z"))).toBe(true);
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T18:30:00Z"))).toBe(false);
  });

  test("windows wrap around midnight and the top of the hour", () => {
    const night = { dailyWindow: "22:00-04:00", hourlyWindow: null };
    expect(isBaseloadScheduleActive(night, utc("2026-09-04T23:00:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(night, utc("2026-09-04T03:59:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(night, utc("2026-09-04T12:00:00Z"))).toBe(false);

    const wrap = { dailyWindow: null, hourlyWindow: "50-10" };
    expect(isBaseloadScheduleActive(wrap, utc("2026-09-04T12:55:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(wrap, utc("2026-09-04T12:05:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(wrap, utc("2026-09-04T12:30:00Z"))).toBe(false);

    const toEnd = { dailyWindow: null, hourlyWindow: "30-60" };
    expect(isBaseloadScheduleActive(toEnd, utc("2026-09-04T12:59:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(toEnd, utc("2026-09-04T12:00:00Z"))).toBe(false);
  });

  test("both windows must hold when both are set", () => {
    const worker = { dailyWindow: "04:30-18:30", hourlyWindow: "24-58" };
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T10:30:00Z"))).toBe(true);
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T10:10:00Z"))).toBe(false);
    expect(isBaseloadScheduleActive(worker, utc("2026-09-04T20:30:00Z"))).toBe(false);
    expect(isBaseloadScheduleActive({ dailyWindow: null, hourlyWindow: null }, 0)).toBe(true);
  });

  test("describes the schedule for humans", () => {
    expect(describeBaseloadSchedule({ dailyWindow: null, hourlyWindow: null })).toBeNull();
    expect(describeBaseloadSchedule({ dailyWindow: "04:30-18:30", hourlyWindow: "24-58" })).toBe(
      "daily 04:30-18:30 UTC, minutes 24-58 of every hour",
    );
  });

  test("limit state pauses outside the schedule but still ends the run", () => {
    const config = normalizeBaseloadConfig({
      workers: [{ walletNumber: 0, name: "Office hours", hourlyWindow: "24-58", durationSeconds: 60 }],
    });
    const worker = config.workers[0]!;
    expect(worker.name).toBe("Office hours");
    const start = utc("2026-09-04T10:00:00Z");
    expect(getBaseloadLimitState(worker, 5, start, start + 10_000)).toEqual({
      type: "outside-schedule",
      currentBlock: 5,
    });
    expect(getBaseloadLimitState(worker, 5, start, start + 30 * 60_000).type).toBe("duration-ended");
    const inside = utc("2026-09-04T10:30:00Z");
    expect(getBaseloadLimitState(worker, 5, inside, inside).type).toBe("active");
  });

  test("config normalization rejects bad names and windows", () => {
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, name: "x".repeat(65) }] }),
    ).toThrow("at most 64");
    expect(() =>
      normalizeBaseloadConfig({ workers: [{ walletNumber: 0, dailyWindow: "9-9" }] }),
    ).toThrow("Daily window start and end must differ");
  });
});
