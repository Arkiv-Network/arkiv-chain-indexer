/** Wire types shared with the explorer. This module has no runtime dependencies. */
export type SearchKind = "block" | "transaction" | "address" | "entity" | "attribute" | "operation" | "log";
export interface SearchResult {
  kind: SearchKind;
  label: string;
  detail: string;
  href: string;
  scope: "indexed" | "recent";
}
export interface SearchSuggestion {
  label: string;
  query: string;
  detail: string;
  href: string | null;
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
  coverage: {
    attributeIndex: boolean;
    attributeHead: string | null;
    recentOperations: number;
    recentTransactions: number;
    recentLogs: number;
  };
}
