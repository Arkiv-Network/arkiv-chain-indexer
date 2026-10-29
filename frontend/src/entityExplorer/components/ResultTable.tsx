// The entity explorer's results as one row per entity: key, schema, owner, a
// one-line preview of the attributes and expiry. Entities rarely share
// columns, so rows never line up into an attribute grid; a row expands to the
// full entity instead.

import { ChevronRight } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { escapedStrValue } from "@/attributes";
import { StrValue } from "@/components/str-value";
import { findBytesHint } from "../lib/bytes";
import type { BlockTiming } from "../lib/client";
import { getAttributes, getSchemaName, schemaFilter, type EntityAttribute, type ExplorerEntity } from "../lib/entity";
import { estimateBlockTimestampMs, formatRelativeMs, isPermanentExpiry } from "../lib/query";
import { AttributeValue, truncateMiddle } from "./AttributeValue";
import { EntityDocument } from "./EntityDocument";
import { FilterPopup, popupAt, strCopy, type FilterPopupState } from "./FilterPopup";
import { valueButtonClass } from "./styles";

const headerCellClass =
  "border-b border-border bg-muted px-3 py-2 text-left align-bottom text-[10px] font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase";
const cellClass = "max-w-64 border-b border-border px-3 py-1.5 align-top";
const SUMMARY_ATTRIBUTES = 4;

/** One line standing in for an entity's attributes, so each row previews its own columns. */
function AttributeSummary({ attributes }: { attributes: readonly EntityAttribute[] }) {
  if (attributes.length === 0) return <span className="text-muted-foreground/60">no attributes</span>;
  const shown = attributes.slice(0, SUMMARY_ATTRIBUTES);
  return (
    <span className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
      {shown.map((attribute) => (
        <span key={attribute.name} className="flex max-w-56 min-w-0 items-center gap-1">
          <span className="shrink-0 text-muted-foreground">{attribute.name}</span>
          <AttributeValue
            compact
            value={attribute.value}
            hint={attribute.value.type === "bytes" ? findBytesHint(attributes, attribute.name) : undefined}
          />
        </span>
      ))}
      {attributes.length > shown.length ? <span className="shrink-0 text-muted-foreground">+{attributes.length - shown.length} more</span> : null}
    </span>
  );
}

/** A single result starts expanded, since there is nothing else to scan. */
export function ResultTable({
  entities,
  timing,
  timeZone,
  entityHref,
  historyHref,
  onQueryOnly,
  onAddToQuery,
  onOpenEntity,
}: {
  entities: readonly ExplorerEntity[];
  timing: BlockTiming | null;
  timeZone: string;
  entityHref: (entityKey: string) => string;
  historyHref?: (entityKey: string) => string;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  onOpenEntity: (entityKey: string) => void;
}) {
  // Keys the reader has toggled away from their default open state.
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [popup, setPopup] = useState<FilterPopupState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState<number>();
  const nowMs = Date.now();

  // An expanded row holds the full entity; pinning it to the visible width
  // keeps it readable however wide the table scrolls.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => entities.map((entity) => ({ entity, attributes: getAttributes(entity) })), [entities]);
  const openByDefault = entities.length === 1;

  const toggle = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="overflow-hidden bg-card ring-1 ring-foreground/10">
      <div ref={scrollRef} className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className={cn(headerCellClass, "sticky left-0 z-10")}>
                <span className="pl-5">$key</span>
              </th>
              <th className={headerCellClass}>Schema</th>
              <th className={headerCellClass}>$owner</th>
              <th className={cn(headerCellClass, "w-full")}>Attributes</th>
              <th className={headerCellClass}>Expires</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entity, attributes }) => {
              const key = entity.$key;
              const isOpen = toggled.has(key) !== openByDefault;
              const schemaName = getSchemaName(entity);
              return (
                <Fragment key={key}>
                  <tr className={cn("group cursor-pointer transition-colors hover:bg-muted", isOpen && "bg-muted")} onClick={() => toggle(key)}>
                    <td
                      className={cn(
                        cellClass,
                        // Opaque, so cells scrolling under the pinned column don't show through.
                        "sticky left-0 z-[1] bg-card font-mono whitespace-nowrap group-hover:bg-muted",
                        isOpen && "bg-muted",
                      )}
                    >
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          className="-m-1 flex shrink-0 items-center p-1 text-muted-foreground hover:text-foreground"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Collapse entity" : "Expand entity"}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(key);
                          }}
                        >
                          <ChevronRight className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
                        </button>
                        <button
                          type="button"
                          className={valueButtonClass}
                          title={key}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPopup(popupAt(event, { expression: `$key = key(${key})`, label: "this key", copyValue: key }));
                          }}
                        >
                          {truncateMiddle(key, 8, 6)}
                        </button>
                      </span>
                    </td>
                    <td className={cn(cellClass, "font-mono whitespace-nowrap")}>
                      {schemaName ? (
                        <button
                          type="button"
                          className={valueButtonClass}
                          title={escapedStrValue(schemaFilter(schemaName))}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPopup(popupAt(event, { expression: schemaFilter(schemaName), label: "this schema", ...strCopy(schemaName) }));
                          }}
                        >
                          <StrValue text={schemaName} />
                        </button>
                      ) : (
                        <span className="text-muted-foreground">untagged</span>
                      )}
                    </td>
                    <td className={cn(cellClass, "font-mono whitespace-nowrap")}>
                      <button
                        type="button"
                        className={valueButtonClass}
                        title={entity.$owner}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPopup(
                            popupAt(event, { expression: `$owner = addr(${entity.$owner})`, label: "this owner", copyValue: entity.$owner }),
                          );
                        }}
                      >
                        {truncateMiddle(entity.$owner, 6, 4)}
                      </button>
                    </td>
                    <td className={cn(cellClass, "max-w-none font-mono")}>
                      <AttributeSummary attributes={attributes} />
                    </td>
                    <td className={cn(cellClass, "whitespace-nowrap text-muted-foreground")}>
                      {isPermanentExpiry(entity.$expiresAt)
                        ? "never"
                        : timing
                          ? formatRelativeMs(estimateBlockTimestampMs(entity.$expiresAt, timing), nowMs)
                          : `#${entity.$expiresAt}`}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={5} className="border-b border-border bg-muted/40 p-0">
                        <div className="sticky left-0 p-3" style={{ width: viewportWidth }}>
                          <EntityDocument
                            entity={entity}
                            timing={timing}
                            timeZone={timeZone}
                            linkHref={entityHref(key)}
                            {...(historyHref ? { historyHref: historyHref(key) } : {})}
                            onQueryOnly={onQueryOnly}
                            onAddToQuery={onAddToQuery}
                            onOpenEntity={onOpenEntity}
                          />
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {popup ? <FilterPopup state={popup} onQueryOnly={onQueryOnly} onAddToQuery={onAddToQuery} onClose={() => setPopup(null)} /> : null}
    </div>
  );
}
