// An entity's own columns in the entity explorer: name, type, whether it is
// indexed, and the value, which opens the filter menu.

import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { escapedStrValue } from "@/attributes";
import { findBytesHint } from "../lib/bytes";
import { attributeFilter, isFilterable, type EntityAttribute } from "../lib/entity";
import { AttributeValue, TypeTagChip } from "./AttributeValue";
import { popupFromKey, type PointerLike } from "./FilterPopup";

/** The id of a blob's viewer, so the table's "view" link can jump to it. */
export function blobAnchor(entityKey: string, name: string) {
  return `blob-${entityKey.slice(2, 10)}-${name}`;
}

export function AttributeTable({
  entityKey,
  attributes,
  timeZone,
  onSelect,
  onOpenEntity,
}: {
  entityKey: string;
  attributes: EntityAttribute[];
  timeZone: string;
  onSelect: (event: PointerLike, attribute: EntityAttribute) => void;
  onOpenEntity?: (key: string) => void;
}) {
  return (
    <div className="border border-border">
      {attributes.map((attribute) => {
        const { name, value } = attribute;
        const filterable = isFilterable(attribute);
        const isBytes = value.type === "bytes";
        return (
          <div
            key={name}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-xs last:border-b-0 sm:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)]"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate font-mono", filterable ? "text-(--q-attribute)" : "text-muted-foreground")} title={name}>
                {name}
              </span>
              <TypeTagChip tag={value.type} />
              {filterable ? (
                <span className="inline-flex shrink-0 items-center text-primary" title="Indexed: queries can filter on this column" aria-label="indexed">
                  <Search className="size-2.5" />
                </span>
              ) : null}
            </div>
            <div className="col-span-2 flex min-w-0 items-baseline gap-2 font-mono sm:col-span-1">
              {/* Not a <button>: a key value carries its own "open" button inside. */}
              <div
                role="button"
                tabIndex={0}
                className="min-w-0 cursor-pointer text-left outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
                title={filterable ? `Filter by ${escapedStrValue(attributeFilter(name, value))}` : `${name} is not indexed`}
                onClick={(event) => onSelect(event, attribute)}
                onKeyDown={(event) => {
                  const at = popupFromKey(event);
                  if (at) onSelect(at, attribute);
                }}
              >
                <AttributeValue
                  value={value}
                  hint={isBytes ? findBytesHint(attributes, name) : undefined}
                  timeZone={timeZone}
                  onOpenEntity={onOpenEntity}
                />
              </div>
              {isBytes ? (
                <a
                  href={`#${blobAnchor(entityKey, name)}`}
                  className="shrink-0 text-[10px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
                >
                  view
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
