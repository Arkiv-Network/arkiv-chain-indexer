import { describe, expect, test } from "bun:test";
import {
  readStoredString,
  readStoredStringRecord,
  removeStoredSection,
  removeStoredValue,
  type StorageLike,
  writeStoredString,
  writeStoredStringRecord,
} from "./src/localStorage";
import { readFiltersFromSearch } from "./src/permalinks";

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface Filters {
  blockGt: string;
  blockLt: string;
  limit: string;
}

const FILTER_KEYS = ["blockGt", "blockLt", "limit"] as const;
const FALLBACK: Filters = {
  blockGt: "",
  blockLt: "",
  limit: "1000",
};

describe("frontend localStorage helpers", () => {
  test("reads and validates stored strings", () => {
    const storage = new MemoryStorage();
    writeStoredString("timeZone", "UTC", storage);

    expect(readStoredString("timeZone", "America/New_York", (value) => value === "UTC", storage)).toBe("UTC");
    expect(readStoredString("timeZone", "America/New_York", (value) => value !== "UTC", storage)).toBe(
      "America/New_York",
    );
  });

  test("reads only known string fields from stored records", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "gas-price-tracker:blocks.filters",
      JSON.stringify({
        blockGt: "10",
        blockLt: 20,
        limit: "500",
        ignored: "value",
      }),
    );

    expect(readStoredStringRecord("blocks.filters", FALLBACK, FILTER_KEYS, storage)).toEqual({
      blockGt: "10",
      blockLt: "",
      limit: "500",
    });
  });

  test("falls back when stored records are malformed", () => {
    const storage = new MemoryStorage();
    storage.setItem("gas-price-tracker:blocks.filters", "{");

    expect(readStoredStringRecord("blocks.filters", FALLBACK, FILTER_KEYS, storage)).toEqual(FALLBACK);
  });

  test("writes only selected record keys", () => {
    const storage = new MemoryStorage();
    writeStoredStringRecord(
      "blocks.filters",
      {
        blockGt: "10",
        blockLt: "20",
        limit: "250",
        extra: "not persisted",
      },
      FILTER_KEYS,
      storage,
    );

    expect(JSON.parse(storage.getItem("gas-price-tracker:blocks.filters") ?? "{}")).toEqual({
      blockGt: "10",
      blockLt: "20",
      limit: "250",
    });
  });

  test("removes stored values", () => {
    const storage = new MemoryStorage();
    writeStoredString("tableEdit", "123", storage);
    removeStoredValue("tableEdit", storage);

    expect(readStoredString("tableEdit", "fallback", undefined, storage)).toBe("fallback");
  });

  test("removes only values from the requested stored section", () => {
    const storage = new MemoryStorage();
    writeStoredStringRecord("charts.filters", { blockGt: "10", blockLt: "20", limit: "500" }, FILTER_KEYS, storage);
    writeStoredString("charts.sidebarCollapsed", "true", storage);
    writeStoredString("blocks.tableDensity", "compact", storage);
    writeStoredString("timeZone", "UTC", storage);

    removeStoredSection("charts.", storage);

    expect(readStoredStringRecord("charts.filters", FALLBACK, FILTER_KEYS, storage)).toEqual(FALLBACK);
    expect(readStoredString("charts.sidebarCollapsed", "false", undefined, storage)).toBe("false");
    expect(readStoredString("blocks.tableDensity", "comfortable", undefined, storage)).toBe("compact");
    expect(readStoredString("timeZone", "America/New_York", undefined, storage)).toBe("UTC");
  });

  test("query string filters override stored defaults", () => {
    const storage = new MemoryStorage();
    writeStoredStringRecord("blocks.filters", { blockGt: "10", blockLt: "20", limit: "500" }, FILTER_KEYS, storage);

    const stored = readStoredStringRecord("blocks.filters", FALLBACK, FILTER_KEYS, storage);
    const filters = readFiltersFromSearch("?blockGt=99", FILTER_KEYS, stored);

    expect(filters).toEqual({
      blockGt: "99",
      blockLt: "20",
      limit: "500",
    });
  });
});
