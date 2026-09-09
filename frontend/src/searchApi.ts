import type { SearchResponse } from "../../src/omniSearchTypes";
export type { SearchResponse, SearchResult, SearchSuggestion } from "../../src/omniSearchTypes";

export function searchHref(query: string): string {
  return `/search?${new URLSearchParams({ q: query })}`;
}

export function canSuggest(query: string): boolean {
  const text = query.trim();
  if (text.length < 2 || text.length > 256) return false;
  if (/^(?:0x)?[0-9a-f]+$/i.test(text) || /^0x$/i.test(text)) {
    return text.replace(/^0x/i, "").length >= 6;
  }
  return true;
}

export async function fetchSearch(query: string, suggest: boolean, signal: AbortSignal): Promise<SearchResponse> {
  const params = new URLSearchParams({ q: query, limit: suggest ? "8" : "30" });
  const response = await fetch(`/api/search${suggest ? "/suggest" : ""}?${params}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Search failed (HTTP ${response.status})`);
  }
  return response.json() as Promise<SearchResponse>;
}
