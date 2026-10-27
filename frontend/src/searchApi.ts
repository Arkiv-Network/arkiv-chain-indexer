import { isIndexedSearchQuery, type SearchKind, type SearchResponse, type SearchSuggestion } from "../../src/omniSearchTypes";
import { addressDetailHref, buildRouteHref, routePathForView, transactionDetailHref } from "./permalinks";
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
  return withEntitiesInExplorer(await response.json() as SearchResponse);
}

/** The entity explorer, looking up one entity by its key. */
export function entityExplorerHref(entityKey: string): string {
  return buildRouteHref("entity-explorer", { q: `$key = key(${entityKey.trim().toLowerCase()})` });
}

const ENTITY_PAGE_HREF = /^\/entity\/(0x[0-9a-fA-F]{64})$/;

/**
 * The backend links an entity key to its indexed history (`/entity/<key>`);
 * search sends it to the entity explorer instead, which reads the entity's
 * current state from the node.
 */
export function withEntitiesInExplorer(response: SearchResponse): SearchResponse {
  const rewrite = (href: string) => {
    const match = ENTITY_PAGE_HREF.exec(href);
    return match ? entityExplorerHref(match[1]!) : href;
  };
  return {
    ...response,
    results: response.results.map((result) => ({ ...result, href: rewrite(result.href) })),
    suggestions: response.suggestions.map((suggestion) => ({ ...suggestion, href: rewrite(suggestion.href) })),
  };
}

/** A complete 32-byte hex value: a block or transaction hash, or an entity key. */
export function fullHashQuery(query: string): string | null {
  const hex = normalizeSearchQuery(query).replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? `0x${hex}` : null;
}

/**
 * Where a submitted complete 32-byte value goes. A hash the index knows as a
 * block or transaction keeps the search page, which tells them apart; anything
 * else is taken as an entity key and opened in the entity explorer, which asks
 * the node and so finds entities the index never saw. Without an answer from
 * the index (`null`), the search page decides.
 */
export function fullHashHref(hash: string, indexed: SearchResponse | null): string {
  if (!indexed) return searchHref(hash);
  const isBlockOrTransaction = indexed.results.some((result) => result.kind === "block" || result.kind === "transaction");
  return isBlockOrTransaction ? searchHref(hash) : entityExplorerHref(hash);
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
