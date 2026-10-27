// The entity explorer's query history: queries that ran, and drafts that sat
// in the editor long enough to be worth keeping, saved in this browser.

import { useCallback, useEffect, useRef, useState } from "react";
import { editQueryHistory, readQueryHistory, rememberQuery, writeQueryHistory, type QueryHistoryEntry } from "../lib/queryHistory";

/** A draft is saved once the editor has been still for this long. */
const DRAFT_DELAY_MS = 800;

export function useQueryHistory(draft: string) {
  const [entries, setEntries] = useState(readQueryHistory);
  const entriesRef = useRef(entries);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();

  const update = useCallback((change: (entries: QueryHistoryEntry[]) => QueryHistoryEntry[]) => {
    const next = change(entriesRef.current);
    if (next === entriesRef.current) return;
    entriesRef.current = next;
    setEntries(next);
    writeQueryHistory(next);
  }, []);

  const remember = useCallback((text: string) => update((current) => rememberQuery(current, text)), [update]);

  useEffect(() => {
    draftTimer.current = setTimeout(() => remember(draft), DRAFT_DELAY_MS);
    return () => clearTimeout(draftTimer.current);
  }, [draft, remember]);

  return {
    entries,
    remember,
    /** Saves the draft now rather than after the delay, e.g. before showing the history. */
    flushDraft: () => {
      clearTimeout(draftTimer.current);
      remember(draft);
    },
    edit: (id: string, text: string) => update((current) => editQueryHistory(current, id, text)),
    remove: (id: string) => update((current) => current.filter((entry) => entry.id !== id)),
  };
}
