import { readStoredString, writeStoredString, type StorageLike } from "./localStorage";

export const QUERY_HISTORY_LIMIT = 50;
const STORAGE_KEY = "data.queryHistory";

export interface QueryHistoryEntry {
  id: string;
  query: string;
  savedAt: number;
}

export function readQueryHistory(storage?: StorageLike | null): QueryHistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readStoredString(STORAGE_KEY, "[]", undefined, storage));
    if (!Array.isArray(parsed)) return [];
    const queries = new Set<string>();
    const ids = new Set<string>();
    return parsed.filter((entry): entry is QueryHistoryEntry => {
      if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id ||
        typeof entry.query !== "string" || !entry.query.trim() ||
        typeof entry.savedAt !== "number" || !Number.isFinite(new Date(entry.savedAt).getTime()) || entry.savedAt < 0 ||
        queries.has(entry.query.trim()) || ids.has(entry.id)) return false;
      queries.add(entry.query.trim());
      ids.add(entry.id);
      return true;
    }).slice(0, QUERY_HISTORY_LIMIT).map(({ id, query, savedAt }) => ({ id, query, savedAt }));
  } catch {
    return [];
  }
}

export function writeQueryHistory(entries: QueryHistoryEntry[], storage?: StorageLike | null): void {
  writeStoredString(STORAGE_KEY, JSON.stringify(entries.slice(0, QUERY_HISTORY_LIMIT)), storage);
}

/** Remember paused drafts and attempted queries, including queries that fail. */
export function rememberQuery(
  entries: QueryHistoryEntry[], query: string, now = Date.now(),
): QueryHistoryEntry[] {
  if (!query.trim()) return entries;
  const existing = entries.find(entry => entry.query.trim() === query.trim());
  if (entries[0] === existing && existing?.query === query) return entries;
  return [
    { id: existing?.id ?? crypto.randomUUID(), query, savedAt: now },
    ...entries.filter(entry => entry.id !== existing?.id),
  ].slice(0, QUERY_HISTORY_LIMIT);
}

export function editQueryHistory(
  entries: QueryHistoryEntry[], id: string, query: string, now = Date.now(),
): QueryHistoryEntry[] {
  if (!query.trim() || !entries.some(entry => entry.id === id)) return entries;
  return [
    { id, query, savedAt: now },
    ...entries.filter(entry => entry.id !== id && entry.query.trim() !== query.trim()),
  ];
}
