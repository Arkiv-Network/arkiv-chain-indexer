import { describe, expect, test } from "bun:test";
import { readViewFromSearch } from "./src/permalinks";

describe("frontend permalink helpers", () => {
  test("reads the block inspector view", () => {
    expect(readViewFromSearch("?view=block&block=42")).toBe("block");
  });

  test("falls back to blocks for unknown views", () => {
    expect(readViewFromSearch("?view=unknown")).toBe("blocks");
  });
});
