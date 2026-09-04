// The result list of the Data page: one card per entity, with the metadata the
// node returned, an estimated lifetime, and attribute chips that feed back into
// the query. Payloads are not fetched here; the entity page shows history.

import { Clipboard, Filter, ListPlus, Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-cell";
import { cn } from "@/lib/utils";
import { BlockNumberLink } from "./blockLinks";
import {
  attributeFilterExpression,
  describeQueryError,
  estimateBlockTimestampMs,
  formatRelativeMs,
  lifetimeProgress,
  locateQueryPosition,
  NUMERIC_ATTRIBUTE_TYPES,
  type EntityAttribute,
  type EntityRecord,
} from "./dataQuery";
import type { BlockTiming } from "./dataRpc";
import { fmtDate, fmtInteger } from "./format";
import { entityDetailHref, shouldHandleClientNavigation, writeEntityPermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";

export interface EntityResultsProps {
  /** The query the results belong to, as sent to the node. */
  executedQuery: string | null;
  entities: EntityRecord[];
  /** Entities loaded so far, before the expiration filter. */
  loadedCount: number;
  cursor: string | null;
  blockNumber: number | null;
  timing: BlockTiming | null;
  /** Milliseconds the last page took. */
  durationMs: number | null;
  running: "first" | "more" | null;
  error: unknown | null;
  expirationFilter: "all" | "soon";
  timeZone: string;
  onLoadMore: () => void;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  onLocationChange: () => void;
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
  error,
  expirationFilter,
  timeZone,
  onLoadMore,
  onQueryOnly,
  onAddToQuery,
  onLocationChange,
}: EntityResultsProps) {
  const nowMs = Date.now();

  if (running === "first") {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground" role="status">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        <span className="text-xs">Querying…</span>
      </div>
    );
  }

  if (error !== null && loadedCount === 0) {
    return <QueryError error={error} query={executedQuery} />;
  }

  if (executedQuery === null) {
    return <p className="py-8 text-xs text-muted-foreground">Run a query to list the entities it matches.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">
          {loadedCount === 0
            ? "No entities matched"
            : expirationFilter === "soon"
              ? `${fmtInteger(entities.length)} of ${fmtInteger(loadedCount)} loaded ${loadedCount === 1 ? "entity expires" : "entities expire"} within 24h`
              : `${fmtInteger(loadedCount)} ${loadedCount === 1 ? "entity" : "entities"}${cursor ? " loaded, more available" : ""}`}
        </span>
        {blockNumber !== null ? (
          <span className="text-xs text-muted-foreground">
            at block <BlockNumberLink blockNumber={blockNumber} onLocationChange={onLocationChange} />
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

      {entities.length > 0 ? (
        <div className="flex flex-col gap-3">
          {entities.map((entity) => (
            <EntityCard
              key={entity.key}
              entity={entity}
              timing={timing}
              nowMs={nowMs}
              timeZone={timeZone}
              onQueryOnly={onQueryOnly}
              onAddToQuery={onAddToQuery}
              onLocationChange={onLocationChange}
            />
          ))}
        </div>
      ) : null}

      {cursor && loadedCount > 0 ? (
        <div className="flex justify-center py-2">
          <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={running !== null}>
            {running === "more" ? "Loading…" : "Load next page"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function QueryError({ error, query }: { error: unknown; query: string | null }) {
  const described = describeQueryError(error);
  const location = described.position !== null && query ? locateQueryPosition(query, described.position) : null;
  return (
    <div className="flex flex-col gap-2 border border-destructive/30 bg-destructive/5 p-3" role="alert">
      <p className="text-xs text-destructive">
        <strong className="font-semibold">{described.title}.</strong> {described.detail}
      </p>
      {location ? (
        <pre className="overflow-x-auto rounded-none bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-destructive">
          {location.lineText}
          {"\n"}
          {" ".repeat(location.column)}^{query && query.includes("\n") ? ` line ${location.line + 1}, column ${location.column + 1}` : ` column ${location.column + 1}`}
        </pre>
      ) : null}
    </div>
  );
}

function EntityCard({
  entity,
  timing,
  nowMs,
  timeZone,
  onQueryOnly,
  onAddToQuery,
  onLocationChange,
}: {
  entity: EntityRecord;
  timing: BlockTiming | null;
  nowMs: number;
  timeZone: string;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  onLocationChange: () => void;
}) {
  const flags = entity.creationFlags;
  const flagNames = flags
    ? [flags.readonly ? "readonly" : null, flags.permissionlessExtension ? "permissionlessExtension" : null].filter(
        (name): name is string => name !== null,
      )
    : [];
  const creatorDiffers = entity.creator !== null && entity.owner !== null && entity.creator.toLowerCase() !== entity.owner.toLowerCase();

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <EntityKeyLink entityKey={entity.key} onLocationChange={onLocationChange} />
        <span className="flex shrink-0 items-center gap-1">
          <CopyButton value={entity.key} label="entity key" />
          <FilterMenu
            expression={`$key = key(${entity.key})`}
            label="this key"
            copyValue={entity.key}
            onQueryOnly={onQueryOnly}
            onAddToQuery={onAddToQuery}
          />
        </span>
      </header>

      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <MetaRow label="Owner">
            {entity.owner ? (
              <span className="flex min-w-0 items-center gap-1">
                <AddressCell address={entity.owner} />
                <FilterMenu
                  expression={`$owner = addr(${entity.owner})`}
                  label="this owner"
                  copyValue={entity.owner}
                  onQueryOnly={onQueryOnly}
                  onAddToQuery={onAddToQuery}
                />
              </span>
            ) : (
              "—"
            )}
          </MetaRow>
          {creatorDiffers || (entity.creator && !entity.owner) ? (
            <MetaRow label="Creator">
              <span className="flex min-w-0 items-center gap-1">
                <AddressCell address={entity.creator} />
                <FilterMenu
                  expression={`$creator = addr(${entity.creator})`}
                  label="this creator"
                  copyValue={entity.creator ?? ""}
                  onQueryOnly={onQueryOnly}
                  onAddToQuery={onAddToQuery}
                />
              </span>
            </MetaRow>
          ) : null}
          <MetaRow label="Content type">{entity.contentType ?? "—"}</MetaRow>
          {flagNames.length > 0 ? (
            <MetaRow label="Flags">
              <div className="flex flex-wrap gap-1.5">
                {flagNames.map((name) => (
                  <Badge
                    key={name}
                    variant="outline"
                    className="font-mono text-[10px]"
                    title={
                      name === "readonly"
                        ? "The attributes and payload can never change; only the expiry can be extended, ownership transferred, or the entity deleted."
                        : "Anyone, not just the owner, may extend this entity's expiry."
                    }
                  >
                    {name}
                  </Badge>
                ))}
              </div>
            </MetaRow>
          ) : null}
          <MetaRow label="Created">
            <BlockStamp block={entity.createdAt} timing={timing} nowMs={nowMs} timeZone={timeZone} onLocationChange={onLocationChange} />
          </MetaRow>
          {entity.updatedAt !== null && entity.updatedAt !== entity.createdAt ? (
            <MetaRow label="Updated">
              <BlockStamp block={entity.updatedAt} timing={timing} nowMs={nowMs} timeZone={timeZone} onLocationChange={onLocationChange} />
            </MetaRow>
          ) : null}
          <MetaRow label="Expires">
            <BlockStamp block={entity.expiresAt} timing={timing} nowMs={nowMs} timeZone={timeZone} onLocationChange={onLocationChange} />
          </MetaRow>
        </div>

        {entity.createdAt !== null && entity.expiresAt !== null && timing ? (
          <LifetimeBar createdAt={entity.createdAt} expiresAt={entity.expiresAt} timing={timing} nowMs={nowMs} />
        ) : null}
      </div>

      {entity.attributes.length > 0 ? (
        <div className="border-t border-border px-4 py-3">
          <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Attributes</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {entity.attributes.map((attribute) => (
              <AttributeChip key={attribute.name} attribute={attribute} onQueryOnly={onQueryOnly} onAddToQuery={onAddToQuery} />
            ))}
          </div>
        </div>
      ) : (
        <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">No attributes</div>
      )}
    </Card>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
      <div className="min-w-0 text-xs text-foreground">{children}</div>
    </div>
  );
}

function EntityKeyLink({ entityKey, onLocationChange }: { entityKey: string; onLocationChange: () => void }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writeEntityPermalink(entityKey)) onLocationChange();
  };
  return (
    <a
      className="min-w-0 flex-1 truncate font-mono text-sm text-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 transition-colors hover:text-accent-foreground hover:decoration-accent-foreground"
      href={entityDetailHref(entityKey)}
      onClick={onClick}
      title="Open the indexed history of this entity"
    >
      {entityKey}
    </a>
  );
}

function BlockStamp({
  block,
  timing,
  nowMs,
  timeZone,
  onLocationChange,
}: {
  block: number | null;
  timing: BlockTiming | null;
  nowMs: number;
  timeZone: string;
  onLocationChange: () => void;
}) {
  if (block === null) return <span className="text-muted-foreground">—</span>;
  const estimate = timing ? estimateBlockTimestampMs(block, timing) : null;
  return (
    <span className="flex flex-col gap-0.5">
      <BlockNumberLink blockNumber={block} onLocationChange={onLocationChange} />
      {estimate !== null ? (
        <span className="text-[11px] text-muted-foreground" title="Estimated from the node's block timing">
          {fmtDate(new Date(estimate).toISOString(), timeZone)} · {formatRelativeMs(estimate, nowMs)}
        </span>
      ) : null}
    </span>
  );
}

const LIFETIME_TEXT_TONE: Record<"green" | "amber" | "red" | "muted", string> = {
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
  muted: "text-muted-foreground",
};

const LIFETIME_BAR_TONE: Record<"green" | "amber" | "red" | "muted", string> = {
  green: "bg-emerald-500 dark:bg-emerald-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  red: "bg-red-500 dark:bg-red-400",
  muted: "bg-muted-foreground/40",
};

function LifetimeBar({
  createdAt,
  expiresAt,
  timing,
  nowMs,
}: {
  createdAt: number;
  expiresAt: number;
  timing: BlockTiming;
  nowMs: number;
}) {
  const progress = lifetimeProgress(createdAt, expiresAt, timing.currentBlock);
  const expiresMs = estimateBlockTimestampMs(expiresAt, timing);
  const tone = progress.expired ? "muted" : progress.leftPct < 20 ? "red" : progress.leftPct < 50 ? "amber" : "green";
  return (
    <div title={`${Math.round(progress.leftPct)}% of the lifetime remains`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Lifetime</span>
        <span className={cn("text-[10px] font-medium", LIFETIME_TEXT_TONE[tone])}>
          {progress.expired ? "expired" : `${Math.round(progress.leftPct)}% left · expires ${formatRelativeMs(expiresMs, nowMs)}`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", LIFETIME_BAR_TONE[tone])} style={{ width: `${progress.consumedPct}%` }} />
      </div>
    </div>
  );
}

function TypeTagChip({ tag }: { tag: string }) {
  return (
    <span className="inline-flex shrink-0 items-center border border-border bg-background px-1 py-px font-mono text-[9px] leading-none text-muted-foreground">
      {tag}
    </span>
  );
}

function AttributeChip({
  attribute,
  onQueryOnly,
  onAddToQuery,
}: {
  attribute: EntityAttribute;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
}) {
  const numeric = NUMERIC_ATTRIBUTE_TYPES.has(attribute.type);
  const shown = attribute.value.length > 40 ? `${attribute.value.slice(0, 40)}…` : attribute.value;
  const displayValue = numeric || attribute.type === "bool" ? shown : `"${shown}"`;
  return (
    <FilterMenu
      expression={attributeFilterExpression(attribute)}
      label={attribute.name}
      copyValue={attribute.value}
      onQueryOnly={onQueryOnly}
      onAddToQuery={onAddToQuery}
      trigger={
        <span
          className="inline-flex max-w-full items-center gap-1 border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] transition-colors hover:bg-accent hover:text-accent-foreground"
          title={`${attribute.name} = ${attribute.value}`}
        >
          <TypeTagChip tag={attribute.type} />
          <span className="shrink-0 text-muted-foreground">{attribute.name}</span>
          <span className="mx-0.5 shrink-0">=</span>
          <span className={cn("truncate", numeric ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}>
            {displayValue}
          </span>
        </span>
      }
    />
  );
}

/**
 * A small menu offering to query by one value, add it to the current query, or
 * copy it. Triggered by a chip or the funnel button next to an address.
 */
function FilterMenu({
  expression,
  label,
  copyValue,
  onQueryOnly,
  onAddToQuery,
  trigger,
}: {
  expression: string;
  label: string;
  copyValue: string;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context); nothing to do.
    }
  };

  return (
    <span className="relative inline-flex" ref={rootRef}>
      <button
        type="button"
        className={
          trigger
            ? "cursor-pointer"
            : "inline-flex size-5 shrink-0 items-center justify-center border border-border text-muted-foreground opacity-70 transition-colors hover:border-accent hover:text-accent hover:opacity-100"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        title={trigger ? `Filter by ${expression}` : `Query by ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger ?? <Filter className="size-3" />}
      </button>
      {open ? (
        <span className="absolute top-full left-0 z-20 mt-1 min-w-48 border border-border bg-popover p-1 shadow-md" role="menu">
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onQueryOnly(expression);
            }}
          >
            <Search className="size-3 text-muted-foreground" />
            Query by {label} only
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            onClick={() => {
              setOpen(false);
              onAddToQuery(expression);
            }}
          >
            <ListPlus className="size-3 text-muted-foreground" />
            Add to current query
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            onClick={copy}
          >
            <Clipboard className="size-3 text-muted-foreground" />
            {copied ? "Copied" : "Copy value"}
          </button>
          <span className="mt-1 block truncate border-t border-border px-2.5 pt-1.5 font-mono text-[10px] text-muted-foreground">
            {expression}
          </span>
        </span>
      ) : null}
    </span>
  );
}
