import { describe, expect, test } from "bun:test";
import { isPermanentEntity, isPermanentLifetime } from "./src/entityLifetime";

describe("permanent entity lifetimes", () => {
  test("requires more than 100 years at the chain's block duration", () => {
    for (const secondsPerBlock of [0.5, 1, 2, 12]) {
      const centuryBlocks = (100 * 365 * 24 * 60 * 60) / secondsPerBlock;
      expect(isPermanentLifetime(centuryBlocks - 1, secondsPerBlock)).toBe(false);
      expect(isPermanentLifetime(centuryBlocks, secondsPerBlock)).toBe(false);
      expect(isPermanentLifetime(centuryBlocks + 1, secondsPerBlock)).toBe(true);
    }
  });

  test("does not classify unknown, invalid, or nonpositive lifetimes as permanent", () => {
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(isPermanentLifetime(invalid, 2)).toBe(false);
      expect(isPermanentLifetime(4_000_000_000, invalid)).toBe(false);
    }
    expect(isPermanentEntity(null, 4_000_000_000, 2)).toBe(false);
    expect(isPermanentEntity(0, null, 2)).toBe(false);
    expect(isPermanentEntity(0, 4_000_000_000, null)).toBe(false);
    expect(isPermanentEntity(200, 100, 2)).toBe(false);
  });
});
