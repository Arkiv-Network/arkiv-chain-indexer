// The result list of the Data page: one card per entity, with the metadata the
// node returned, an estimated lifetime, and attribute chips that feed back into
// the query. Payloads are not fetched here; the entity page shows history.

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
import { CopyButton } from "./TransactionView";

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
      <div className="query-results">
        <p className="summary query-status" role="status">
          Querying…
        </p>
      </div>
    );
  }

  if (error !== null && loadedCount === 0) {
    return (
      <div className="query-results">
        <QueryError error={error} query={executedQuery} />
      </div>
    );
  }

  if (executedQuery === null) {
    return (
      <div className="query-results">
        <p className="summary query-status">Run a query to list the entities it matches.</p>
      </div>
    );
  }

  return (
    <div className="query-results">
      <div className="query-status-line">
        <span className="query-status-count">
          {loadedCount === 0
            ? "No entities matched"
            : expirationFilter === "soon"
              ? `${fmtInteger(entities.length)} of ${fmtInteger(loadedCount)} loaded ${loadedCount === 1 ? "entity expires" : "entities expire"} within 24h`
              : `${fmtInteger(loadedCount)} ${loadedCount === 1 ? "entity" : "entities"}${cursor ? " loaded, more available" : ""}`}
        </span>
        {blockNumber !== null ? (
          <span className="query-status-meta">
            at block <BlockNumberLink blockNumber={blockNumber} onLocationChange={onLocationChange} />
            {durationMs !== null ? ` · ${fmtInteger(durationMs)} ms` : null}
          </span>
        ) : null}
      </div>

      {error !== null ? <QueryError error={error} query={executedQuery} /> : null}

      {loadedCount > 0 && entities.length === 0 && expirationFilter === "soon" ? (
        <p className="summary query-status">
          {timing
            ? "None of the loaded entities expires within the next 24 hours."
            : "Block timing is unavailable, so expirations cannot be estimated."}
        </p>
      ) : null}

      {entities.length > 0 ? (
        <div className="entity-list">
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
        <div className="query-more">
          <button type="button" className="secondary" onClick={onLoadMore} disabled={running !== null}>
            {running === "more" ? "Loading…" : "Load next page"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function QueryError({ error, query }: { error: unknown; query: string | null }) {
  const described = describeQueryError(error);
  const location = described.position !== null && query ? locateQueryPosition(query, described.position) : null;
  return (
    <div className="query-error" role="alert">
      <p className="summary error query-error-title">
        <strong>{described.title}.</strong> {described.detail}
      </p>
      {location ? (
        <pre className="query-error-context">
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
    <article className="entity-card">
      <header className="entity-card-head">
        <EntityKeyLink entityKey={entity.key} onLocationChange={onLocationChange} />
        <span className="entity-card-tools">
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

      <div className="entity-card-body">
        <dl className="entity-meta">
          <MetaRow label="Owner">
            {entity.owner ? (
              <span className="entity-inline">
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
              <span className="entity-inline">
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
              <span className="entity-flags">
                {flagNames.map((name) => (
                  <span
                    key={name}
                    className="entity-flag"
                    title={
                      name === "readonly"
                        ? "The attributes and payload can never change; only the expiry can be extended, ownership transferred, or the entity deleted."
                        : "Anyone, not just the owner, may extend this entity's expiry."
                    }
                  >
                    {name}
                  </span>
                ))}
              </span>
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
        </dl>

        {entity.createdAt !== null && entity.expiresAt !== null && timing ? (
          <LifetimeBar createdAt={entity.createdAt} expiresAt={entity.expiresAt} timing={timing} nowMs={nowMs} />
        ) : null}
      </div>

      {entity.attributes.length > 0 ? (
        <div className="entity-attributes">
          {entity.attributes.map((attribute) => (
            <AttributeChip
              key={attribute.name}
              attribute={attribute}
              onQueryOnly={onQueryOnly}
              onAddToQuery={onAddToQuery}
            />
          ))}
        </div>
      ) : (
        <div className="entity-attributes entity-attributes-empty">No attributes</div>
      )}
    </article>
  );
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tx-detail-row entity-meta-row">
      <dt className="tx-detail-label">{label}</dt>
      <dd className="tx-detail-value">{children}</dd>
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
    <a className="mono block-link entity-key-link" href={entityDetailHref(entityKey)} onClick={onClick} title="Open the indexed history of this entity">
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
  if (block === null) return <>—</>;
  const estimate = timing ? estimateBlockTimestampMs(block, timing) : null;
  return (
    <span className="entity-block-stamp">
      <BlockNumberLink blockNumber={block} onLocationChange={onLocationChange} />
      {estimate !== null ? (
        <span className="entity-block-estimate" title="Estimated from the node's block timing">
          {fmtDate(new Date(estimate).toISOString(), timeZone)} · {formatRelativeMs(estimate, nowMs)}
        </span>
      ) : null}
    </span>
  );
}

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
  const tone = progress.expired ? "expired" : progress.leftPct < 20 ? "red" : progress.leftPct < 50 ? "amber" : "green";
  return (
    <div className={`entity-lifetime ${tone}`} title={`${Math.round(progress.leftPct)}% of the lifetime remains`}>
      <div className="entity-lifetime-head">
        <span>Lifetime</span>
        <span className="entity-lifetime-left">
          {progress.expired ? "expired" : `${Math.round(progress.leftPct)}% left · expires ${formatRelativeMs(expiresMs, nowMs)}`}
        </span>
      </div>
      <div className="entity-lifetime-track">
        <div className="entity-lifetime-fill" style={{ width: `${progress.consumedPct}%` }} />
      </div>
    </div>
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
  return (
    <FilterMenu
      expression={attributeFilterExpression(attribute)}
      label={attribute.name}
      copyValue={attribute.value}
      onQueryOnly={onQueryOnly}
      onAddToQuery={onAddToQuery}
      trigger={
        <span className="attr-chip" title={`${attribute.name} = ${attribute.value}`}>
          <span className="attr-chip-type">{attribute.type}</span>
          <span className="attr-chip-name">{attribute.name}</span>
          <span className="attr-chip-eq">=</span>
          <span className={`attr-chip-value ${numeric ? "numeric" : "text"}`}>{numeric || attribute.type === "bool" ? shown : `"${shown}"`}</span>
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
    <span className={`filter-menu${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={trigger ? "filter-menu-chip" : "filter-menu-button"}
        aria-haspopup="menu"
        aria-expanded={open}
        title={trigger ? `Filter by ${expression}` : `Query by ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger ?? (
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />
          </svg>
        )}
      </button>
      {open ? (
        <span className="filter-menu-popup" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onQueryOnly(expression);
            }}
          >
            Query by {label} only
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAddToQuery(expression);
            }}
          >
            Add to current query
          </button>
          <button type="button" role="menuitem" onClick={copy}>
            {copied ? "Copied" : "Copy value"}
          </button>
          <span className="filter-menu-expression mono">{expression}</span>
        </span>
      ) : null}
    </span>
  );
}
