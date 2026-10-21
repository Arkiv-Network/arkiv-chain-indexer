// The entity explorer's query card: the editor, the run settings and actions,
// and example queries. The editor's text is the page's; running it is too.

import { ExternalLink } from "lucide-react";
import { lazy, Suspense, useState, type KeyboardEvent } from "react";
import { selectClass } from "@/components/filters-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { EXAMPLE_QUERIES, EXPIRATION_FILTERS, PAGE_SIZE_OPTIONS, type ExpirationFilter, type PageSize } from "../lib/query";
import type { AttributeHint } from "../lib/editorLanguage";
import { CopyLinkButton } from "./CopyLinkButton";
import { TypescriptSnippet } from "./TypescriptSnippet";

// CodeMirror is the bulk of the explorer; it loads in its own chunk.
const QueryEditor = lazy(() => import("./QueryEditor"));

const QUERY_PLACEHOLDER = "Paste an entity key, an owner address, or type a query such as arkiv.schema = str('arkiv-demo.posts')";
const DOCS_URL = "https://stage.docs.arkiv.network/reference/query-language/";

export function QueryPanel({
  query,
  onQueryChange,
  onRun,
  onCancel,
  onClear,
  running,
  canClear,
  pageSize,
  onPageSizeChange,
  expiration,
  onExpirationChange,
  attributeHints,
  historyCount,
  onOpenHistory,
  permalink,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onRun: (query: string) => void;
  onCancel: () => void;
  onClear: () => void;
  running: boolean;
  canClear: boolean;
  pageSize: PageSize;
  onPageSizeChange: (pageSize: PageSize) => void;
  expiration: ExpirationFilter;
  onExpirationChange: (expiration: ExpirationFilter) => void;
  /** Columns of the results on screen, offered as completions. */
  attributeHints: readonly AttributeHint[];
  historyCount: number;
  onOpenHistory: () => void;
  /** A link to the last run, once there is one. */
  permalink: string | null;
}) {
  const [snippetOpen, setSnippetOpen] = useState(false);
  const hasText = query.trim().length > 0;

  const onFallbackKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onRun(event.currentTarget.value);
    }
  };

  return (
    <Card className="gap-3 p-4">
      <div className={cn(snippetOpen && "grid items-start gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]")}>
        <Suspense
          fallback={
            <div className="overflow-hidden rounded-md border border-input bg-muted">
              <textarea
                className="w-full resize-y bg-transparent px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
                value={query}
                placeholder={QUERY_PLACEHOLDER}
                spellCheck={false}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={onFallbackKeyDown}
                rows={2}
              />
            </div>
          }
        >
          <QueryEditor value={query} onChange={onQueryChange} onExecute={onRun} placeholder={QUERY_PLACEHOLDER} attributeHints={attributeHints} />
        </Suspense>
        {snippetOpen ? <TypescriptSnippet query={query} /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
          Press
          <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">Ctrl</kbd>+
          <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">Enter</kbd>
          to run the query
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1">
            Query language
            <ExternalLink className="size-3" />
          </a>
        </span>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Page size
          <select
            value={pageSize}
            onChange={(event) => onPageSizeChange(event.target.value as PageSize)}
            disabled={running}
            className={selectClass}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Show
          <select value={expiration} onChange={(event) => onExpirationChange(event.target.value as ExpirationFilter)} className={selectClass}>
            {EXPIRATION_FILTERS.map((option) => (
              <option key={option} value={option}>
                {option === "all" ? "All entities" : "Expiring within 24h"}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="outline" size="sm" aria-pressed={snippetOpen} onClick={() => setSnippetOpen((open) => !open)}>
          TypeScript
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClear} disabled={!hasText && !canClear}>
          Clear
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onOpenHistory}>
          History{historyCount > 0 ? ` (${historyCount})` : ""}
        </Button>
        {permalink ? <CopyLinkButton href={permalink} /> : null}
        {running ? (
          <Button type="button" variant="destructive" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => onRun(query)} disabled={!hasText}>
            Run query
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Try an example</span>
        {EXAMPLE_QUERIES.map((example) => (
          <button key={example.label} type="button" className="query-example" title={example.query} onClick={() => onQueryChange(example.query)}>
            {example.label}
          </button>
        ))}
      </div>
    </Card>
  );
}
