import { describe, expect, test } from "bun:test";
import { expandGaps } from "./fillGaps";
import type { BlockGap } from "./storage";

function gap(start: bigint, end: bigint): BlockGap {
  return { gapStart: start, gapEnd: end, missingCount: end - start + 1n };
}

describe("expandGaps", () => {
  test("flattens multiple gap ranges into ascending block numbers", () => {
    const result = expandGaps([gap(3n, 4n), gap(7n, 9n)], 100);
    expect(result.blocks).toEqual([3n, 4n, 7n, 8n, 9n]);
    expect(result.truncated).toBe(false);
  });

  test("handles single-block gaps", () => {
    const result = expandGaps([gap(815852n, 815852n)], 100);
    expect(result.blocks).toEqual([815852n]);
    expect(result.truncated).toBe(false);
  });

  test("returns empty and not truncated for no gaps", () => {
    const result = expandGaps([], 100);
    expect(result.blocks).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("caps at maxBlocks and flags truncation when more remain", () => {
    const result = expandGaps([gap(1n, 10n)], 4);
    expect(result.blocks).toEqual([1n, 2n, 3n, 4n]);
    expect(result.truncated).toBe(true);
  });

  test("truncates across gap boundaries", () => {
    const result = expandGaps([gap(1n, 2n), gap(50n, 60n)], 3);
    expect(result.blocks).toEqual([1n, 2n, 50n]);
    expect(result.truncated).toBe(true);
  });

  test("is not truncated when total exactly equals the cap", () => {
    const result = expandGaps([gap(1n, 2n), gap(5n, 6n)], 4);
    expect(result.blocks).toEqual([1n, 2n, 5n, 6n]);
    expect(result.truncated).toBe(false);
  });
});
