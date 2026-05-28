import { describe, expect, test } from "bun:test";
import type { StoredBlock } from "./src/api";
import {
  homeHistogramMinuteRange,
  homeRecentWindowStartMs,
  pruneHomeBlocks,
  recentHomeBlocksParams,
} from "./src/homeBlocks";
import { DEFAULT_PAGE_SETTINGS } from "./src/pageSettings";

describe("frontend home block window", () => {
  test("sets the default histogram x-axis to fifty-nine minutes ago through the current minute", () => {
    const currentMinuteMs = Date.UTC(2026, 4, 28, 12, 34, 0);

    expect(homeHistogramMinuteRange(currentMinuteMs, DEFAULT_PAGE_SETTINGS)).toEqual({
      minMs: Date.UTC(2026, 4, 28, 11, 35, 0),
      maxMs: currentMinuteMs,
    });
  });

  test("sets custom histogram x-axis windows from the current minute", () => {
    const currentMinuteMs = Date.UTC(2026, 4, 28, 12, 34, 0);

    expect(
      homeHistogramMinuteRange(currentMinuteMs, {
        histogramWindowMinutes: 5,
      }),
    ).toEqual({
      minMs: Date.UTC(2026, 4, 28, 12, 30, 0),
      maxMs: currentMinuteMs,
    });
  });

  test("uses a date-greater filter for the default recent window", () => {
    const nowMs = Date.UTC(2026, 4, 28, 12, 34, 56, 789);
    const params = recentHomeBlocksParams(DEFAULT_PAGE_SETTINGS, nowMs);

    expect(homeRecentWindowStartMs(nowMs, DEFAULT_PAGE_SETTINGS)).toBe(
      Date.UTC(2026, 4, 28, 11, 34, 56, 789),
    );
    expect(params.get("dateGt")).toBe("2026-05-28T11:34:56.789Z");
    expect(params.get("order")).toBe("desc");
    expect(params.has("limit")).toBe(false);
  });

  test("derives custom date-greater filters from the histogram window", () => {
    const settings = {
      ...DEFAULT_PAGE_SETTINGS,
      blockTimeMs: 12_000,
      histogramWindowMinutes: 30,
    };
    const nowMs = Date.UTC(2026, 4, 28, 12, 34, 56, 789);

    expect(recentHomeBlocksParams(settings, nowMs).get("dateGt")).toBe(
      "2026-05-28T12:04:56.789Z",
    );
  });

  test("removes blocks outside the recent date-greater window", () => {
    const nowMs = Date.UTC(2026, 4, 28, 12, 0, 0);
    const blocks = [
      storedBlock(4, Date.UTC(2026, 4, 28, 11, 59, 0)),
      storedBlock(3, Date.UTC(2026, 4, 28, 11, 30, 0)),
      storedBlock(2, Date.UTC(2026, 4, 28, 11, 0, 0, 1)),
      storedBlock(1, Date.UTC(2026, 4, 28, 11, 0, 0)),
    ];

    const pruned = pruneHomeBlocks(blocks, DEFAULT_PAGE_SETTINGS, nowMs);

    expect(pruned.map((block) => block.blockNumber)).toEqual([4, 3, 2]);
  });
});

function storedBlock(blockNumber: number, blockDateMs: number): StoredBlock {
  return {
    blockNumber,
    blockDate: new Date(blockDateMs).toISOString(),
    transactionCount: 0,
    baseBlockFeeWei: "0",
    averagePriorityFeeWei: "0",
    averagePriorityFeeWeightedWei: "0",
    averageFeePriceWei: "0",
    averageTransactionFeeWei: "0",
    averageTransactionGasUsed: "0",
    totalGasUsed: "0",
    maxGasInBlock: "0",
  };
}
