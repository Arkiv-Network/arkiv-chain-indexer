import { describe, expect, test } from "bun:test";
import {
  countActiveMinutes,
  formatCountShort,
  projectBaseloadMinutes,
  projectBaseloadTraffic,
} from "./src/baseloadProjection";
import { parseDailyWindow, parseHourlyWindow } from "./src/baseloadSchedule";

const base = {
  behavior: "create" as const,
  opsPerMinute: 60,
  entitiesPerRequest: 1,
  singleCreatePayloadSize: 1000,
  dailyWindow: null,
  hourlyWindow: null,
};

describe("baseload traffic projection", () => {
  test("an always-on create worker fills every hour", () => {
    const projection = projectBaseloadTraffic([base]);
    expect(projection.hours).toHaveLength(24);
    expect(projection.hours[0]).toEqual({ hour: 0, txCount: 3600, payloadBytes: 3_600_000, activeWorkers: 1 });
    expect(projection.dayTxCount).toBe(3600 * 24);
    expect(projection.peakPayloadBytes).toBe(3_600_000);
  });

  test("windows cut the active minutes, including wrapped ones", () => {
    expect(countActiveMinutes(10, null, parseHourlyWindow("24-58"))).toBe(34);
    expect(countActiveMinutes(10, null, parseHourlyWindow("50-70"))).toBe(20);
    expect(countActiveMinutes(4, parseDailyWindow("04:30-18:30"), null)).toBe(30);
    expect(countActiveMinutes(18, parseDailyWindow("04:30-18:30"), null)).toBe(30);
    expect(countActiveMinutes(20, parseDailyWindow("04:30-18:30"), null)).toBe(0);
    expect(countActiveMinutes(23, parseDailyWindow("22:00-04:00"), parseHourlyWindow("50-10"))).toBe(20);
  });

  test("both windows combine and behaviors scale traffic", () => {
    const projection = projectBaseloadTraffic([
      { ...base, dailyWindow: "04:30-18:30", hourlyWindow: "24-58" },
      { ...base, behavior: "create-ownership", opsPerMinute: 1 },
      { ...base, behavior: "create-update-delete", opsPerMinute: 2, entitiesPerRequest: 4 },
    ]);
    const noon = projection.hours[12]!;
    // 60 ops x 34 min + 2 tx x 60 min + 2 tx x 60 min
    expect(noon.txCount).toBe(2040 + 120 + 120);
    // 2040 x 1000 + (1 op x 0.5) x 60 x 1000 + (2 x 0.5 x 4) x 60 x 1000
    expect(noon.payloadBytes).toBe(2_040_000 + 30_000 + 240_000);
    expect(noon.activeWorkers).toBe(3);
    expect(projection.hours[20]!.activeWorkers).toBe(2);
  });

  test("minute profile follows the hourly windows and the daily window", () => {
    const minutes = projectBaseloadMinutes(
      [
        { ...base, hourlyWindow: "10-20" },
        { ...base, opsPerMinute: 1, hourlyWindow: "15-75", dailyWindow: "12:00-13:00" },
      ],
      12,
    );
    expect(minutes).toHaveLength(60);
    expect(minutes[5]).toEqual({ minute: 5, txCount: 1, payloadBytes: 1000, activeWorkers: 1 });
    expect(minutes[12]).toEqual({ minute: 12, txCount: 60, payloadBytes: 60_000, activeWorkers: 1 });
    expect(minutes[17]!.txCount).toBe(61);
    expect(minutes[30]!.activeWorkers).toBe(1);
    expect(projectBaseloadMinutes([{ ...base, dailyWindow: "12:00-13:00" }], 3)[30]!.activeWorkers).toBe(0);
  });

  test("unparseable windows count as always on", () => {
    const projection = projectBaseloadTraffic([{ ...base, hourlyWindow: "garbage" }]);
    expect(projection.hours[3]!.txCount).toBe(3600);
  });

  test("short formatters", () => {
    expect(formatCountShort(950)).toBe("950");
    expect(formatCountShort(2040)).toBe("2.0k");
    expect(formatCountShort(75_600)).toBe("76k");
  });
});
