import { describe, expect, test } from "bun:test";
import { chartTimeAxis, chartTimeLabels } from "./src/chartTime";

describe("chart timestamps", () => {
  test("formats labels in the selected zone without changing coordinates", () => {
    const start = Date.parse("2026-09-10T23:00:00Z");
    const end = start + 3_600_000;
    const utc = chartTimeAxis(start, end, "UTC");
    const warsaw = chartTimeAxis(start, end, "Europe/Warsaw");
    expect(warsaw.tickvals).toEqual(utc.tickvals);
    expect(utc.ticktext[0]).toBe("23:00");
    expect(warsaw.ticktext[0]).toBe("01:00");
    expect(chartTimeLabels([start], "Europe/Warsaw")[0]).toContain("01:00:00");
  });

  test("preserves distinct instants across the repeated daylight-saving hour", () => {
    const start = Date.parse("2026-10-25T00:00:00Z");
    const labels = chartTimeLabels([start, start + 3_600_000], "Europe/Warsaw");
    expect(labels[0]).toContain("02:00:00");
    expect(labels[1]).toContain("02:00:00");
    expect(labels[0]).not.toBe(labels[1]);
  });
});
