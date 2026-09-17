/** Search contract and input validation shared with the explorer; no runtime dependencies. */
export const SEARCH_MAX_QUERY_LENGTH = 256;
export const SEARCH_QUERY_HELP = "Enter a block number, address, block or transaction hash, or entity key. Identifier prefixes need at least six hex digits.";

export function isIndexedSearchQuery(query: string): boolean {
  if (query.length > SEARCH_MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(query)) return false;
  const text = query.trim();
  if (/^\d+$/.test(text) && BigInt(text) <= 9223372036854775807n) return true;
  return /^(?:0x)?[0-9a-f]{6,64}$/i.test(text);
}

export type SearchKind = "block" | "transaction" | "address" | "entity";
export interface SearchResult {
  kind: SearchKind;
  label: string;
  detail: string;
  href: string;
  scope: "indexed";
}
export interface SearchSuggestion {
  label: string;
  query: string;
  detail: string;
  href: string;
}
export interface SearchResponse {
  query: string;
  results: SearchResult[];
  suggestions: SearchSuggestion[];
  /** A result/candidate budget was reached; refine the query instead of deep paging. */
  truncated: boolean;
  /** A query deadline was reached. Never present this as an exhaustive no-match. */
  partial: boolean;
  notes: string[];
  /** Legacy fields retained for older clients; metadata search is disabled. */
  coverage: {
    attributeIndex: false;
    attributeHead: null;
    recentOperations: 0;
    recentTransactions: 0;
    recentLogs: 0;
  };
}
