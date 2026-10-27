import { isIndexedSearchQuery, type SearchKind, type SearchResponse, type SearchSuggestion } from "../../src/omniSearchTypes";
import { addressDetailHref, routePathForView, transactionDetailHref } from "./permalinks";
export type { SearchKind, SearchResponse, SearchResult, SearchSuggestion } from "../../src/omniSearchTypes";

const KIND_VIEWS = { block: "block", transaction: "transaction", address: "address", entity: "entity" } as const;

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

/** Keep only suggestions that open one of the given kinds of page. */
export function suggestionsInScope(suggestions: SearchSuggestion[], scope: readonly SearchKind[]): SearchSuggestion[] {
  const prefixes = scope.map((kind) => `${routePathForView(KIND_VIEWS[kind])}/`);
  return suggestions.filter((suggestion) => prefixes.some((prefix) => suggestion.href.startsWith(prefix)));
}

/**
 * A complete address or transaction hash opens its page directly when the
 * search is scoped to that kind; anything else goes through the search page.
 */
export function scopedExactHref(query: string, scope: readonly SearchKind[]): string | null {
  const hex = normalizeSearchQuery(query).replace(/^0x/i, "").toLowerCase();
  if (scope.includes("address") && /^[0-9a-f]{40}$/.test(hex)) return addressDetailHref(`0x${hex}`);
  if (scope.includes("transaction") && /^[0-9a-f]{64}$/.test(hex)) return transactionDetailHref(`0x${hex}`);
  return null;
}
