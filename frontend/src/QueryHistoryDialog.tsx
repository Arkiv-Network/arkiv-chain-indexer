import { useEffect, useRef, useState } from "react";
import { fmtDate } from "./format";
import { copyText } from "./TransactionsView";
import { QUERY_HISTORY_LIMIT, type QueryHistoryEntry } from "./queryHistory";

export function QueryHistoryDialog({ entries, timeZone, onLoad, onEdit, onDelete, onClose }: {
  entries: QueryHistoryEntry[];
  timeZone: string;
  onLoad: (query: string) => void;
  onEdit: (id: string, query: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog ref={dialog} className="query-history-dialog" aria-labelledby="query-history-title" onCancel={onClose}>
      <header className="query-history-header">
        <h2 id="query-history-title">Query history</h2>
        <button type="button" className="secondary" onClick={onClose}>Close</button>
      </header>
      <p className="summary query-history-description">
        Your last {QUERY_HISTORY_LIMIT} queries and paused drafts, saved in this browser. Loading a query puts it in the editor without running it.
      </p>
      {entries.length === 0 ? <p className="summary">No saved queries yet.</p> : (
        <ol className="query-history-list">
          {entries.map(entry => (
            <HistoryItem key={entry.id} entry={entry} timeZone={timeZone} onLoad={onLoad} onEdit={onEdit} onDelete={onDelete} />
          ))}
        </ol>
      )}
    </dialog>
  );
}

function HistoryItem({ entry, timeZone, onLoad, onEdit, onDelete }: {
  entry: QueryHistoryEntry;
  timeZone: string;
  onLoad: (query: string) => void;
  onEdit: (id: string, query: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.query);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);
  return (
    <li className="query-history-item">
      <time dateTime={new Date(entry.savedAt).toISOString()}>{fmtDate(new Date(entry.savedAt).toISOString(), timeZone)}</time>
      {editing ? (
        <textarea aria-label="Edit saved query" className="query-history-editor" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} rows={3} autoFocus />
      ) : <pre>{entry.query}</pre>}
      <div className="query-history-actions">
        {editing ? <>
          <button type="button" className="secondary" disabled={!draft.trim()} onClick={() => { onEdit(entry.id, draft); setEditing(false); }}>Save</button>
          <button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button>
        </> : <>
          <button type="button" className="secondary" onClick={() => onLoad(entry.query)}>Load into editor</button>
          <button type="button" className="secondary" onClick={async () => setCopyStatus(await copyText(entry.query) ? "copied" : "failed")}>Copy</button>
          <button type="button" className="secondary" onClick={() => { setDraft(entry.query); setEditing(true); }}>Edit</button>
          <button type="button" className="secondary" onClick={() => onDelete(entry.id)}>Delete</button>
        </>}
        <span className="query-copy-feedback" role="status">{copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Could not copy" : ""}</span>
      </div>
    </li>
  );
}
