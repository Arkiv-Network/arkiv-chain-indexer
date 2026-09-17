import { expect, test } from "bun:test";
import { editQueryHistory, QUERY_HISTORY_LIMIT, readQueryHistory, rememberQuery, writeQueryHistory, type QueryHistoryEntry } from "./src/queryHistory";
import { writeStoredString, type StorageLike } from "./src/localStorage";

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
}

test("history preserves complete multiline drafts across storage reloads", () => {
  const storage = memoryStorage();
  const query = "project = str('it''s ready')\n    AND count = u64(18446744073709551615)";
  const entries = rememberQuery([], query, 1000);
  writeQueryHistory(entries, storage);
  expect(readQueryHistory(storage)).toEqual(entries);
  expect(readQueryHistory(storage)[0]?.query).toBe(query);
});

test("reusing a query moves it to the front without duplicating it", () => {
  const first = rememberQuery([], "*", 1000);
  const second = rememberQuery(first, "score > i32(10)", 2000);
  const reused = rememberQuery(second, "*", 3000);
  expect(reused.map(entry => entry.query)).toEqual(["*", "score > i32(10)"]);
  expect(reused[0]?.id).toBe(first[0]?.id);
  expect(reused[0]?.savedAt).toBe(3000);
  expect(rememberQuery(reused, "*", 4000)).toBe(reused);
  expect(rememberQuery(reused, "   ")).toBe(reused);
});

test("history keeps the latest 50 distinct queries", () => {
  let entries: QueryHistoryEntry[] = [];
  for (let n = 0; n < 60; n++) entries = rememberQuery(entries, `score = i32(${n})`, n);
  expect(entries).toHaveLength(QUERY_HISTORY_LIMIT);
  expect(entries[0]?.query).toBe("score = i32(59)");
  expect(entries.at(-1)?.query).toBe("score = i32(10)");
});

test("editing and deleting saved queries survive reload and preserve other entries", () => {
  const storage = memoryStorage();
  const entries = rememberQuery(rememberQuery([], "*", 1000), "old = true", 2000);
  const edited = editQueryHistory(entries, entries[0]!.id, "new = false", 3000);
  expect(edited[0]?.id).toBe(entries[0]?.id);
  expect(editQueryHistory(edited, edited[0]!.id, " ")).toBe(edited);
  writeQueryHistory(edited.filter(entry => entry.query !== "*"), storage);
  expect(readQueryHistory(storage).map(entry => entry.query)).toEqual(["new = false"]);
  const merged = editQueryHistory(entries, entries[0]!.id, "*", 4000);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.id).toBe(entries[0]?.id);
});

test("invalid or unavailable storage does not break the editor", () => {
  const storage = memoryStorage();
  writeStoredString("data.queryHistory", "not JSON", storage);
  expect(readQueryHistory(storage)).toEqual([]);
  writeStoredString("data.queryHistory", JSON.stringify([
    { id: "ok", query: "*", savedAt: 1000 },
    { id: "duplicate", query: "*", savedAt: 1000 },
    { id: "bad-date", query: "x = true", savedAt: 1e20 },
    { id: "blank", query: "  ", savedAt: 1000 },
    null,
  ]), storage);
  expect(readQueryHistory(storage)).toEqual([{ id: "ok", query: "*", savedAt: 1000 }]);
  const unavailable: StorageLike = {
    getItem: () => { throw new Error("disabled"); },
    setItem: () => { throw new Error("full"); },
    removeItem: () => {},
  };
  expect(readQueryHistory(unavailable)).toEqual([]);
  expect(() => writeQueryHistory(rememberQuery([], "*"), unavailable)).not.toThrow();
});
