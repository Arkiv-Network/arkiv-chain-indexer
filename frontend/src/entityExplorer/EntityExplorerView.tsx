// The entity explorer: query entity state from the network's RPC through the
// Arkiv SDK. Entities carry user-defined typed columns, so results show each
// entity's own schema rather than a fixed payload and attribute list.
//
// This file composes the page: the run lives in useEntitySearch (URL and
// fetching), saved queries in useQueryHistory, and the editor's text here.

import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { buildPermalinkHref, entityDetailHref } from "@/permalinks";
import { EntityResults } from "./components/EntityResults";
import { QueryHistoryDialog } from "./components/QueryHistoryDialog";
import { QueryPanel } from "./components/QueryPanel";
import { EntityExplorerProviders } from "./EntityExplorerProviders";
import { useEntitySearch } from "./hooks/useEntitySearch";
import { useQueryHistory } from "./hooks/useQueryHistory";
import { inferSchema } from "./lib/entity";
import { appendQueryExpression, explorerLinkFilters, normalizeQueryInput } from "./lib/query";

interface EntityExplorerViewProps {
  timeZone: string;
  /** The deployment stores transaction data, so entities have an indexed history page to link to. */
  transactionDataEnabled?: boolean;
}

export function EntityExplorerView(props: EntityExplorerViewProps) {
  return (
    <EntityExplorerProviders>
      <EntityExplorerPage {...props} />
    </EntityExplorerProviders>
  );
}

function EntityExplorerPage({ timeZone, transactionDataEnabled = false }: EntityExplorerViewProps) {
  const search = useEntitySearch();
  const { executedQuery, pageSize, expiration } = search;

  // The editor's text; it becomes the URL's `q` when run.
  const [query, setQuery] = useState(executedQuery);
  const queryRef = useRef(query);
  queryRef.current = query;
  const history = useQueryHistory(query);
  const { remember } = history;
  const [historyOpen, setHistoryOpen] = useState(false);
  // Queries left behind by following entity references, newest last. A manual run clears it.
  const [previousQueries, setPreviousQueries] = useState<string[]>([]);

  // A shared link, or back/forward, changes the run under us: show its query in the editor.
  useEffect(() => {
    if (!executedQuery) return;
    remember(queryRef.current);
    remember(executedQuery);
    setQuery(executedQuery);
  }, [executedQuery, remember]);

  const run = (text: string, keepTrail = false) => {
    const normalized = normalizeQueryInput(text);
    if (!normalized) return;
    if (!keepTrail) setPreviousQueries([]);
    remember(queryRef.current);
    remember(normalized);
    setQuery(normalized);
    search.run(normalized);
  };

  const clear = () => {
    remember(query);
    setQuery("");
    setPreviousQueries([]);
    search.clear();
  };

  /** Following an entity reference keeps a trail, so the reader can step back to where they were. */
  const openEntity = (entityKey: string) => {
    if (executedQuery) setPreviousQueries((trail) => [...trail, executedQuery]);
    run(entityKey, true);
  };

  const back = () => {
    const previous = previousQueries.at(-1);
    if (previous === undefined) return;
    setPreviousQueries((trail) => trail.slice(0, -1));
    run(previous, true);
  };

  const attributeHints = useMemo(() => inferSchema(search.entities, null).columns, [search.entities]);
  const entityHref = (entityKey: string) =>
    buildPermalinkHref("entity-explorer", explorerLinkFilters(`$key = key(${entityKey})`, pageSize, "all"));
  const permalink = executedQuery ? buildPermalinkHref("entity-explorer", explorerLinkFilters(executedQuery, pageSize, expiration)) : null;

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 md:px-6">
      <PageHeader title="Entities" />

      <QueryPanel
        query={query}
        onQueryChange={setQuery}
        onRun={(text) => run(text)}
        onCancel={search.cancel}
        onClear={clear}
        running={search.running !== null}
        canClear={executedQuery !== ""}
        pageSize={pageSize}
        onPageSizeChange={search.setPageSize}
        expiration={expiration}
        onExpirationChange={search.setExpiration}
        attributeHints={attributeHints}
        historyCount={history.entries.length}
        onOpenHistory={() => {
          history.flushDraft();
          setHistoryOpen(true);
        }}
        permalink={permalink}
      />

      {historyOpen ? (
        <QueryHistoryDialog
          entries={history.entries}
          timeZone={timeZone}
          onClose={() => setHistoryOpen(false)}
          onEdit={history.edit}
          onDelete={history.remove}
          onLoad={(text) => {
            remember(query);
            search.cancel();
            setQuery(text);
            setHistoryOpen(false);
          }}
        />
      ) : null}

      <EntityResults
        executedQuery={executedQuery || null}
        entities={search.visibleEntities}
        loadedCount={search.entities.length}
        cursor={search.cursor}
        blockNumber={search.blockNumber}
        timing={search.timing}
        durationMs={search.durationMs}
        running={search.running}
        cancelled={search.cancelled}
        error={search.error}
        expirationFilter={expiration}
        timeZone={timeZone}
        entityHref={entityHref}
        {...(transactionDataEnabled ? { historyHref: entityDetailHref } : {})}
        previousQuery={previousQueries.at(-1) ?? null}
        onBack={back}
        onLoadMore={search.loadMore}
        // A value picked from a result goes into the editor for the reader to run, refine or combine.
        onQueryOnly={setQuery}
        onAddToQuery={(expression) => setQuery((current) => appendQueryExpression(current, expression))}
        onOpenEntity={openEntity}
      />
    </section>
  );
}
