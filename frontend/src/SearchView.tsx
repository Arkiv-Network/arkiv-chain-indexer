import { useEffect, useState, type MouseEvent } from "react";
import { OmniSearch } from "./OmniSearch";
import { fetchSearch, searchHref, type SearchResponse } from "./searchApi";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { shouldHandleClientNavigation } from "./permalinks";

export function SearchView({ locationSearch, onNavigate, onLocationChange }: {
  locationSearch: string;
  onNavigate: (href: string) => void;
  onLocationChange: () => void;
}) {
  const query = new URLSearchParams(locationSearch).get("q") ?? "";
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setResult(null);
    setError("");
    setLoading(!!query.trim());
    if (query.trim()) fetchSearch(query, false, abort.signal).then((body) => {
      if (!abort.signal.aborted) setResult(body);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Search unavailable");
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, attempt]);
  const submit = (href: string) => {
    // Submitting the same query must retry after an error/timeout; the URL
    // alone cannot trigger the effect when its value is unchanged.
    if (href === searchHref(query)) setAttempt((current) => current + 1);
    else onNavigate(href);
  };
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    onNavigate(event.currentTarget.getAttribute("href")!);
  };
  const address = /^(?:0x)?[0-9a-f]{40}$/i.test(query.trim()) ? `0x${query.trim().replace(/^0x/i, "").toLowerCase()}` : null;
  return <section className="search-page">
    <PageBreadcrumbs items={[{ view: "home", label: "Home" }, { view: "search", label: "Search" }]} onLocationChange={onLocationChange} />
    <h2>Search the indexer</h2>
    <OmniSearch initialQuery={query} onNavigate={submit} autofocus={!query} />
    <p className="search-help">Find a block number, an address, a transaction hash or an entity key. Use <code>status=active</code> for an attribute, <code>name=Ali*</code> for a value prefix, or words to search recent metadata.</p>
    {loading ? <p role="status">Searching…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <>
      <p role="status">{result.results.length} matches{result.truncated ? " · More may match; narrow your search" : ""}{result.partial ? " · Some lookups timed out" : ""}</p>
      <ul className="search-results">
        {result.results.map((item) => <li key={`${item.kind}-${item.href}-${item.label}`}>
          <a href={item.href} onClick={click}>
            <span className="search-result-meta"><strong>{item.kind}</strong><span>{item.scope === "recent" ? "Recent metadata" : "Indexed lookup"}</span></span>
            <span className="mono search-result-label">{item.label}</span>
            <small>{item.detail}</small>
          </a>
        </li>)}
      </ul>
      {!result.results.length ? <p>No matches in the searched data. Try a longer identifier or a key=value query.</p> : null}
      {address ? <p><a href={`/address/${address}`} onClick={click}>Open address {address}</a></p> : null}
      <div className="search-coverage">
        {result.coverage.attributeHead ? <p>Attribute projection through block {result.coverage.attributeHead}. Attribute matches can include expired entities.</p> : null}
        {result.notes.map((note) => <p key={note}>{note}</p>)}
      </div>
    </> : null}
  </section>;
}
