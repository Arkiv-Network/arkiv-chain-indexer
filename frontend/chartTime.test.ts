import { describe, expect, test } from "bun:test";
import { chartTimeAxis, chartTimeLabels } from "./src/chartTime";
import { buildHomeMinAvgMaxSeries } from "./src/homeBlocks";
import { weiToGasPriceNumber } from "./src/format";
import type { StoredBlock } from "./src/api";

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

test("base fee minute bands retain Gwei values and missing minutes", () => {
  const minute = Date.parse("2026-09-10T23:00:00Z");
  const blocks = ["1000000000", "1000000002"].map((baseBlockFeeWei) => ({
    blockDate: new Date(minute).toISOString(), baseBlockFeeWei,
  } as StoredBlock));
  const series = buildHomeMinAvgMaxSeries(blocks, minute + 60_000,
    { histogramWindowMinutes: 2 }, (block) => weiToGasPriceNumber(block.baseBlockFeeWei, "gwei"));
  expect(series[0]?.min).toBe(1);
  expect(series[0]?.max).toBe(1.000000002);
  expect(series[0]?.avg).toBeCloseTo(1.000000001, 9);
  expect(series[1]?.avg).toBeNull();
});
