import { afterEach, expect, test } from "bun:test";
import { canSuggest, fetchSearch, searchHref } from "./src/searchApi";
import { readViewFromLocation } from "./src/permalinks";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("search links preserve special characters and resolve the search page", () => {
  const query = 'name="a&b=#x"';
  const url = new URL(searchHref(query), "http://localhost");
  expect(url.searchParams.get("q")).toBe(query);
  expect(readViewFromLocation(url)).toBe("search");
});
test("typeahead avoids empty, short and oversized prefixes", () => {
  for (const text of ["", " ", "a", "0x", "0xabc", "abcde", "x".repeat(257)]) expect(canSuggest(text)).toBe(false);
  for (const text of ["0xabcdef", "abcdef", "name", "name="]) expect(canSuggest(text)).toBe(true);
});
test("search requests carry an abort signal and encode input as a parameter", async () => {
  const abort = new AbortController();
  let called = false;
  globalThis.fetch = (async (target, init) => {
    const url = new URL(String(target), "http://localhost");
    expect(url.pathname).toBe("/api/search/suggest");
    expect(url.searchParams.get("q")).toBe("name=a&b");
    expect(init?.signal).toBe(abort.signal);
    called = true;
    return Response.json({ query: "name=a&b", suggestions: [] });
  }) as typeof fetch;
  await fetchSearch("name=a&b", true, abort.signal);
  expect(called).toBe(true);
});
