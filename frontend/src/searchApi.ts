import { isIndexedSearchQuery, type SearchResponse } from "../../src/omniSearchTypes";
export type { SearchResponse, SearchResult, SearchSuggestion } from "../../src/omniSearchTypes";

export function normalizeSearchQuery(query: string): string {
  return query.split(/\.\.\.|\u2026/, 1)[0]!.trim();
}

export function searchHref(query: string): string {
  return `/search?${new URLSearchParams({ q: normalizeSearchQuery(query) })}`;
}

export function canSuggest(query: string): boolean {
  return isIndexedSearchQuery(normalizeSearchQuery(query));
}

export async function fetchSearch(query: string, suggest: boolean, signal: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: normalizeSearchQuery(query), limit: suggest ? "8" : "30" });
  const response = await fetch(`/api/search${suggest ? "/suggest" : ""}?${params}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Search failed (HTTP ${response.status})`);
  }
  return response.json() as Promise<SearchResponse>;
}
