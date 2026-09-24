import { describe, expect, test } from "bun:test";
import {
  chartRequestLimit,
  normalizeChartPointCount,
  parseChartPointCount,
} from "./src/chartPointCounts";

describe("frontend chart point counts", () => {
  test("parses supported point-count values", () => {
    expect(parseChartPointCount("1000")).toBe(1000);
    expect(parseChartPointCount("750")).toBe(750);
    expect(parseChartPointCount("500")).toBe(500);
    expect(parseChartPointCount("250")).toBe(250);
    expect(parseChartPointCount("100")).toBe(100);
  });

  test("falls back to the default for unsupported values", () => {
    expect(normalizeChartPointCount("999")).toBe("1000");
    expect(normalizeChartPointCount("0")).toBe("1000");
    expect(normalizeChartPointCount("abc")).toBe("1000");
    expect(normalizeChartPointCount("250.5")).toBe("1000");
  });

  test("caps explicit block-window requests to the selected point count", () => {
    expect(chartRequestLimit(500, 750)).toBe(500);
    expect(chartRequestLimit(500, 250)).toBe(250);
    expect(chartRequestLimit(100)).toBe(100);
  });
});
