import { describe, expect, test } from "bun:test";
import type { StoredBlock } from "./src/api";
import {
  homeHistogramMinuteRange,
  homeFetchBlockLimit,
  homeRetainedBlockLimit,
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

  test("derives the default fetch limit from the configured block time", () => {
    expect(homeFetchBlockLimit(DEFAULT_PAGE_SETTINGS)).toBe(1_800);
    expect(recentHomeBlocksParams(DEFAULT_PAGE_SETTINGS).get("limit")).toBe("1800");
  });

  test("derives custom fetch limits from the histogram window and block time", () => {
    const settings = {
      ...DEFAULT_PAGE_SETTINGS,
      blockTimeMs: 12_000,
      histogramWindowMinutes: 30,
    };

    expect(homeFetchBlockLimit(settings)).toBe(150);
  });

  test("keeps only sixty blocks beyond the fetched window", () => {
    const blocks = Array.from({ length: 1_900 }, (_, index) =>
      storedBlock(1_900 - index, Date.now() - index * 1_000),
    );

    const pruned = pruneHomeBlocks(blocks, DEFAULT_PAGE_SETTINGS);

    expect(homeRetainedBlockLimit(DEFAULT_PAGE_SETTINGS)).toBe(1_860);
    expect(pruned).toHaveLength(1_860);
    expect(pruned[0]?.blockNumber).toBe(1_900);
    expect(pruned.at(-1)?.blockNumber).toBe(41);
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
