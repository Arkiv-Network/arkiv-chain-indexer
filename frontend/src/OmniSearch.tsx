import { useEffect, useId, useRef, useState } from "react";
import { canSuggest, fetchSearch, searchHref, type SearchSuggestion } from "./searchApi";

export function OmniSearch({ onNavigate, initialQuery = "", autofocus = false }: {
  onNavigate: (href: string) => void;
  initialQuery?: string;
  autofocus?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const listId = useId();

  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);
  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    setSuggestions([]);
    setActive(-1);
    setError("");
    setLoading(false);
    if (!focused || dismissed || !canSuggest(query)) return () => abort.abort();
    const timer = window.setTimeout(() => {
      setLoading(true);
      fetchSearch(query.trim(), true, abort.signal).then((body) => {
        if (!abort.signal.aborted && generation.current === current) {
          setSuggestions(body.suggestions);
          if (body.partial) setError("Some suggestions timed out. Keep typing to narrow the search.");
        }
      }).catch((reason: unknown) => {
        if (!abort.signal.aborted && generation.current === current) setError(reason instanceof Error ? reason.message : "Suggestions unavailable");
      }).finally(() => {
        if (!abort.signal.aborted && generation.current === current) setLoading(false);
      });
    }, 220);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [query, focused, dismissed]);

  const choose = (suggestion: SearchSuggestion) => {
    setSuggestions([]);
    setActive(-1);
    if (suggestion.href) {
      setDismissed(true);
      input.current?.blur();
      onNavigate(suggestion.href);
    } else if (suggestion.query.endsWith("=")) {
      setQuery(suggestion.query);
      input.current?.focus();
    } else {
      setQuery(suggestion.query);
      setDismissed(true);
      onNavigate(searchHref(suggestion.query));
    }
  };
  const open = focused && !dismissed && (suggestions.length > 0 || loading || !!error);

  return (
    <form className="omni-search" role="search" onSubmit={(event) => {
      event.preventDefault();
      if (active >= 0 && suggestions[active]) { choose(suggestions[active]); return; }
      if (query.trim()) {
        setDismissed(true);
        input.current?.blur();
        onNavigate(searchHref(query.trim()));
      }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    }}>
      <div className="omni-search-field">
        <input ref={input} type="search" role="combobox" aria-label="Search the indexer"
          aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off" spellCheck={false} maxLength={256} autoFocus={autofocus}
          placeholder="Block, address, hash, key=value…" value={query}
          onFocus={() => { setFocused(true); setDismissed(false); }}
          onChange={(event) => { setQuery(event.target.value); setDismissed(false); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") { event.preventDefault(); setDismissed(true); setActive(-1); }
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
              event.preventDefault();
              setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
            }
          }} />
        <button type="submit" disabled={!query.trim()}>Search</button>
      </div>
      {open ? <div className="omni-search-dropdown">
        <ul id={listId} role="listbox" aria-label="Search suggestions">
          {suggestions.map((suggestion, i) => <li key={`${suggestion.query}-${suggestion.href}`} id={`${listId}-${i}`}
            role="option" aria-selected={active === i} className={active === i ? "active" : ""}
            onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(i)}
            onClick={() => choose(suggestion)}>
            <span className="mono">{suggestion.label}</span><small>{suggestion.detail}</small>
          </li>)}
        </ul>
        {loading ? <p role="status">Finding suggestions…</p> : null}
        {error ? <p role="status">{error}</p> : null}
      </div> : null}
    </form>
  );
}
