import { afterEach, expect, test } from "bun:test";
import { canSuggest, fetchSearch, normalizeSearchQuery, searchHref } from "./src/searchApi";
import { readViewFromLocation } from "./src/permalinks";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("shortened identifiers search only the prefix before either ellipsis", async () => {
  for (const shortened of ["0x1234235...324234", " 0x1234235\u2026324234 ", "0x1234235...anything\u2026else"]) {
    expect(normalizeSearchQuery(shortened)).toBe("0x1234235");
    expect(canSuggest(shortened)).toBe(true);
    expect(new URL(searchHref(shortened), "http://localhost").searchParams.get("q")).toBe("0x1234235");
    for (const suggest of [true, false]) {
      globalThis.fetch = (async (target: RequestInfo | URL) => {
        const url = new URL(String(target), "http://localhost");
        expect(url.searchParams.get("q")).toBe("0x1234235");
        expect(url.pathname).toBe(suggest ? "/api/search/suggest" : "/api/search");
        return Response.json({ suggestions: [], results: [] });
      }) as unknown as typeof fetch;
      await fetchSearch(shortened, suggest, new AbortController().signal);
    }
  }
  expect(canSuggest("0x123...abcdef")).toBe(false);
  expect(canSuggest("...abcdef")).toBe(false);
  expect(normalizeSearchQuery("0xabcdef")).toBe("0xabcdef");
});

test("search links preserve special characters and resolve the search page", () => {
  const query = 'name="a&b=#x"';
  const url = new URL(searchHref(query), "http://localhost");
  expect(url.searchParams.get("q")).toBe(query);
  expect(readViewFromLocation(url)).toBe("search");
});
test("typeahead only offers indexed identifiers and block numbers", () => {
  for (const text of ["", " ", "a", "0x", "0xabc", "abcde", "x".repeat(257),
    "name", "name=", "name=Alice", "Alice Smith", "$payload=hello", "create", `0x${"a".repeat(65)}`]) {
    expect(canSuggest(text)).toBe(false);
  }
  for (const text of ["0", "1", "123", "0xabcdef", "abcdef", "0XABCDEF", " 238364 ", "9007199254740993"]) {
    expect(canSuggest(text)).toBe(true);
  }
});
test("search requests carry an abort signal and encode input as a parameter", async () => {
  const abort = new AbortController();
  let called = false;
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(target), "http://localhost");
    expect(url.pathname).toBe("/api/search/suggest");
    expect(url.searchParams.get("q")).toBe("name=a&b");
    expect(init?.signal).toBe(abort.signal);
    called = true;
    return Response.json({ query: "name=a&b", suggestions: [] });
  }) as unknown as typeof fetch;
  await fetchSearch("name=a&b", true, abort.signal);
  expect(called).toBe(true);
});
