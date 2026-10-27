// The entity explorer's results: what the query matched and at which block,
// schema chips that narrow the list to one schema, the result table, and the
// next page.

import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { fmtInteger } from "@/format";
import { cn } from "@/lib/utils";
import type { BlockTiming } from "../lib/client";
import { groupBySchema, type ExplorerEntity } from "../lib/entity";
import { QueryError } from "./QueryError";
import { ResultTable } from "./ResultTable";

const ALL_SCHEMAS = null;

export interface EntityResultsProps {
  /** The query the results belong to, as sent to the node. */
  executedQuery: string | null;
  /** The loaded entities after the expiration filter. */
  entities: ExplorerEntity[];
  /** Entities loaded so far, before the expiration filter. */
  loadedCount: number;
  cursor: string | null;
  blockNumber: bigint | null;
  timing: BlockTiming | null;
  /** Milliseconds the last page took. */
  durationMs: number | null;
  running: "first" | "more" | null;
  /** The first page was cancelled before it arrived. */
  cancelled: boolean;
  error: unknown | null;
  expirationFilter: "all" | "soon";
  timeZone: string;
  /** The permalink that opens one entity on the entity explorer. */
  entityHref: (entityKey: string) => string;
  /** The entity's indexed history page; omitted when this deployment has none (no transaction data). */
  historyHref?: (entityKey: string) => string;
  /** The query to go back to after following an entity reference. */
  previousQuery: string | null;
  onBack: () => void;
  onLoadMore: () => void;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  onOpenEntity: (entityKey: string) => void;
}

export function EntityResults({
  executedQuery,
  entities,
  loadedCount,
  cursor,
  blockNumber,
  timing,
  durationMs,
  running,
  cancelled,
  error,
  expirationFilter,
  timeZone,
  entityHref,
  historyHref,
  previousQuery,
  onBack,
  onLoadMore,
  onQueryOnly,
  onAddToQuery,
  onOpenEntity,
}: EntityResultsProps) {
  const [selectedSchema, setSelectedSchema] = useState<string | null>(ALL_SCHEMAS);
  const groups = useMemo(() => groupBySchema(entities), [entities]);
  // A new query may not have the group the reader had picked; fall back to all.
  const activeSchema = selectedSchema !== ALL_SCHEMAS && groups.has(selectedSchema) ? selectedSchema : ALL_SCHEMAS;
  const shown = activeSchema === ALL_SCHEMAS ? entities : (groups.get(activeSchema) ?? []);

  if (running === "first") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground" role="status">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        <span className="text-xs">Querying…</span>
      </div>
    );
  }

  if (error !== null && loadedCount === 0) {
    return (
      <div className="flex flex-col gap-3">
        {previousQuery !== null ? <BackButton previousQuery={previousQuery} onBack={onBack} /> : null}
        <QueryError error={error} query={executedQuery} />
      </div>
    );
  }

  if (executedQuery === null) {
    return <p className="py-8 text-xs text-muted-foreground">Run a query to list the entities it matches.</p>;
  }

  if (cancelled) {
    return <p className="py-8 text-xs text-muted-foreground">Query cancelled. Run it again to see its results.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-3">
          {previousQuery !== null ? <BackButton previousQuery={previousQuery} onBack={onBack} /> : null}
          <span className="text-xs font-medium text-foreground">
            {loadedCount === 0
              ? "No entities matched"
              : expirationFilter === "soon"
                ? `${fmtInteger(entities.length)} of ${fmtInteger(loadedCount)} loaded ${loadedCount === 1 ? "entity expires" : "entities expire"} within 24h`
                : `${fmtInteger(loadedCount)} ${loadedCount === 1 ? "entity" : "entities"}${cursor ? " loaded, more available" : ""}`}
          </span>
        </span>
        {blockNumber !== null ? (
          <span className="text-xs text-muted-foreground">
            at block <span className="font-mono">{fmtInteger(blockNumber.toString())}</span>
            {durationMs !== null ? ` · ${fmtInteger(durationMs)} ms` : null}
          </span>
        ) : null}
      </div>

      {error !== null ? <QueryError error={error} query={executedQuery} /> : null}

      {loadedCount > 0 && entities.length === 0 && expirationFilter === "soon" ? (
        <p className="text-xs text-muted-foreground">
          {timing
            ? "None of the loaded entities expires within the next 24 hours."
            : "Block timing is unavailable, so expirations cannot be estimated."}
        </p>
      ) : null}

      {groups.size > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Schemas</span>
          <SchemaChip label="All" count={entities.length} active={activeSchema === ALL_SCHEMAS} muted onClick={() => setSelectedSchema(ALL_SCHEMAS)} />
          {[...groups.entries()].map(([group, members]) => (
            <SchemaChip
              key={group}
              label={group || "untagged"}
              count={members.length}
              active={activeSchema === group}
              muted={!group}
              onClick={() => setSelectedSchema(group)}
            />
          ))}
        </div>
      ) : null}

      {shown.length > 0 ? (
        <ResultTable
          entities={shown}
          timing={timing}
          timeZone={timeZone}
          entityHref={entityHref}
          {...(historyHref ? { historyHref } : {})}
          onQueryOnly={onQueryOnly}
          onAddToQuery={onAddToQuery}
          onOpenEntity={onOpenEntity}
        />
      ) : null}

      {cursor && loadedCount > 0 ? (
        <div className="flex justify-center py-2">
          <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={running !== null}>
            {running === "more" ? <Loader2 className="animate-spin" /> : <ChevronRight />}
            {running === "more" ? "Loading…" : "Load next page"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BackButton({ previousQuery, onBack }: { previousQuery: string; onBack: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" title={`Back to: ${previousQuery}`} onClick={onBack}>
      <ArrowLeft />
      Back to previous query
    </Button>
  );
}

function SchemaChip({
  label,
  count,
  active,
  muted,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] transition-colors",
        active ? "border-foreground/40 bg-muted text-foreground" : "border-border bg-card text-muted-foreground hover:border-accent hover:text-accent",
        muted && "border-dashed",
      )}
    >
      <span className="font-mono">{label}</span>
      <span className="text-[10px] text-muted-foreground">{count}</span>
    </button>
  );
}
