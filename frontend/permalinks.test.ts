import { describe, expect, test } from "bun:test";
import { readViewFromSearch } from "./src/permalinks";

describe("frontend permalink helpers", () => {
  test("maps old block inspector links to the transactions view", () => {
    expect(readViewFromSearch("?view=block&block=42")).toBe("transactions");
  });

  test("reads the transactions view", () => {
    expect(readViewFromSearch("?view=transactions&block=42")).toBe("transactions");
  });

  test("reads the senders view", () => {
    expect(readViewFromSearch("?view=senders")).toBe("senders");
  });

  test("reads the health view", () => {
    expect(readViewFromSearch("?view=health")).toBe("health");
  });

  test("reads the baseload view", () => {
    expect(readViewFromSearch("?view=baseload")).toBe("baseload");
  });

  test("falls back to blocks for unknown views", () => {
    expect(readViewFromSearch("?view=unknown")).toBe("blocks");
  });
});
