import { describe, expect, test } from "bun:test";
import { adjacentBlockNumbers } from "./src/BlockView";

describe("block detail adjacent block navigation", () => {
  test("returns previous and next block numbers for a positive block", () => {
    expect(adjacentBlockNumbers("29668")).toEqual({
      previous: "29667",
      next: "29669",
    });
  });

  test("does not return a previous block before genesis", () => {
    expect(adjacentBlockNumbers("0")).toEqual({
      previous: null,
      next: "1",
    });
  });

  test("trims whitespace and preserves large integer precision", () => {
    expect(adjacentBlockNumbers("  9007199254740993  ")).toEqual({
      previous: "9007199254740992",
      next: "9007199254740994",
    });
  });

  test("disables navigation for blank or invalid block values", () => {
    expect(adjacentBlockNumbers("")).toEqual({ previous: null, next: null });
    expect(adjacentBlockNumbers("12.5")).toEqual({ previous: null, next: null });
    expect(adjacentBlockNumbers("-1")).toEqual({ previous: null, next: null });
  });
});
