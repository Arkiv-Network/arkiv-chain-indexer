// The full view of one entity in the entity explorer: the fields Arkiv keeps
// for every entity on the left, the entity's own typed columns and blobs on
// the right. Every queryable value opens a small menu that turns it into a filter.

import { Check, Database, History, Link } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import type { Hex } from "viem";
import { copyText } from "@/components/copy-cell";
import { Badge } from "@/components/ui/badge";
import { shouldHandleClientNavigation } from "@/permalinks";
import { escapedStrValue } from "@/attributes";
import { StrValue } from "@/components/str-value";
import { findBytesHint } from "../lib/bytes";
import type { BlockTiming } from "../lib/client";
import { getAttributes, getSchemaName, isFilterable, schemaFilter, type ExplorerEntity } from "../lib/entity";
import { AttributeTable, blobAnchor } from "./AttributeTable";
import { truncateMiddle } from "./AttributeValue";
import { BytesViewer } from "./BytesViewer";
import { attributePopup, FilterPopup, popupAt, strCopy, type FilterPopupState, type PointerLike } from "./FilterPopup";
import { BlockStamp, LifetimeBlock } from "./LifetimeBlock";
import { fieldLabelClass, linkButtonClass } from "./styles";

export function EntityDocument({
  entity,
  timing,
  timeZone,
  linkHref,
  historyHref,
  onQueryOnly,
  onAddToQuery,
  onOpenEntity,
}: {
  entity: ExplorerEntity;
  timing: BlockTiming | null;
  timeZone: string;
  /** A permalink that opens this entity on the entity explorer. */
  linkHref: string;
  /** The entity's indexed history page (`/entity/<key>`); no link without it. */
  historyHref?: string;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  onOpenEntity?: (key: string) => void;
}) {
  const [popup, setPopup] = useState<FilterPopupState | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const entityKey = entity.$key;
  const schemaName = getSchemaName(entity);
  const attributes = getAttributes(entity);
  const blobs = attributes.filter((attribute) => attribute.value.type === "bytes");
  const indexedCount = attributes.filter(isFilterable).length;
  const patched = entity.$updatedAt > entity.$createdAt;
  const transferred = entity.$owner.toLowerCase() !== entity.$creator.toLowerCase();

  useEffect(() => {
    if (!linkCopied) return;
    const timeout = window.setTimeout(() => setLinkCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [linkCopied]);

  const openPopup = (event: PointerLike, state: Omit<FilterPopupState, "x" | "y">) => setPopup(popupAt(event, state));

  /** The entity page is another view of the app: navigate in place, as the app's own links do. */
  const openHistory = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    window.history.pushState({}, "", event.currentTarget.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="overflow-hidden bg-card ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 md:flex-row md:items-center md:gap-3">
          {schemaName !== undefined ? (
            <button
              type="button"
              className="inline-flex w-fit max-w-full shrink-0 items-center gap-1 border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:border-accent hover:text-accent"
              title={`Schema tag: ${escapedStrValue(schemaFilter(schemaName))}`}
              onClick={(event) => openPopup(event, { expression: schemaFilter(schemaName), label: "this schema", ...strCopy(schemaName) })}
            >
              <Database className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">
                <StrValue text={schemaName} />
              </span>
            </button>
          ) : (
            <span
              className="inline-flex w-fit shrink-0 items-center border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground"
              title="Written without a named schema, so it carries no arkiv.schema tag"
            >
              untagged
            </span>
          )}
          <button
            type="button"
            className="min-w-0 cursor-pointer overflow-hidden text-left font-mono text-sm leading-6 text-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 transition-colors hover:text-accent-foreground hover:decoration-accent-foreground"
            title={`Filter by $key = key(${entityKey})`}
            aria-label={entityKey}
            onClick={(event) => openPopup(event, { expression: `$key = key(${entityKey})`, label: "this key", copyValue: entityKey })}
          >
            <span className="block truncate xl:hidden">{truncateMiddle(entityKey, 18, 16)}</span>
            <span className="hidden break-all xl:block">{entityKey}</span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {historyHref ? (
            <a
              className="flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-accent hover:text-accent"
              href={historyHref}
              title="The entity's indexed history: every version, its operations and the rent they paid"
              onClick={openHistory}
            >
              <History className="size-3" />
              History
            </a>
          ) : null}
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-accent hover:text-accent"
            title={linkHref}
            onClick={async () => {
              if (await copyText(linkHref)) setLinkCopied(true);
            }}
          >
            {linkCopied ? <Check className="size-3" /> : <Link className="size-3" />}
            {linkCopied ? "Copied" : "Copy link"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-col md:flex-row">
        {/* Left: the fields Arkiv keeps for every entity. */}
        <div className="flex shrink-0 flex-col gap-2.5 border-b border-border p-4 md:w-80 md:border-r md:border-b-0 xl:w-96">
          <div>
            <span className={fieldLabelClass}>Owner</span>
            <button
              type="button"
              className={linkButtonClass}
              title={`Filter by $owner = addr(${entity.$owner})`}
              onClick={(event) => openPopup(event, { expression: `$owner = addr(${entity.$owner})`, label: "this owner", copyValue: entity.$owner })}
            >
              {entity.$owner}
            </button>
          </div>
          <div>
            <span className={fieldLabelClass}>
              Creator
              {transferred ? <span className="ml-1.5 tracking-normal normal-case">· ownership transferred</span> : null}
            </span>
            <button
              type="button"
              className={linkButtonClass}
              title={`Filter by $creator = addr(${entity.$creator})`}
              onClick={(event) =>
                openPopup(event, { expression: `$creator = addr(${entity.$creator})`, label: "this creator", copyValue: entity.$creator })
              }
            >
              {entity.$creator}
            </button>
          </div>
          {entity.$creationFlags.readonly || entity.$creationFlags.permissionlessExtension ? (
            <div>
              <span className={fieldLabelClass}>Creation flags</span>
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {entity.$creationFlags.readonly ? (
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px]"
                    title="The attributes can never change. The entity can still be extended, handed over or deleted."
                  >
                    readonly
                  </Badge>
                ) : null}
                {entity.$creationFlags.permissionlessExtension ? (
                  <Badge variant="outline" className="font-mono text-[10px]" title="Anyone, not just the owner, may extend this entity's expiry.">
                    permissionlessExtension
                  </Badge>
                ) : null}
              </div>
            </div>
          ) : null}
          <LifetimeBlock createdAt={entity.$createdAt} expiresAt={entity.$expiresAt} timing={timing} timeZone={timeZone} />
          {patched ? (
            <div>
              <span className={fieldLabelClass}>Last patched</span>
              <BlockStamp block={entity.$updatedAt} timing={timing} timeZone={timeZone} />
            </div>
          ) : null}
        </div>

        {/* Right: the entity's own columns, then its blobs. */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
          <div>
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className={fieldLabelClass}>Attributes</span>
              {attributes.length > 0 ? (
                <span className="text-[10px] text-muted-foreground">
                  {attributes.length} {attributes.length === 1 ? "column" : "columns"} · {indexedCount} indexed
                  {blobs.length > 0 ? ` · ${blobs.length} ${blobs.length === 1 ? "blob" : "blobs"}` : ""}
                </span>
              ) : null}
            </div>
            {attributes.length > 0 ? (
              <AttributeTable
                entityKey={entityKey}
                attributes={attributes}
                timeZone={timeZone}
                onSelect={(event, attribute) => setPopup(attributePopup(event, attribute))}
                onOpenEntity={onOpenEntity}
              />
            ) : (
              <p className="border border-dashed border-border p-3 text-xs text-muted-foreground">
                This entity has no attributes{schemaName ? " besides its schema tag" : ""}.
              </p>
            )}
          </div>

          {blobs.map((blob) => (
            <BytesViewer
              key={blob.name}
              id={blobAnchor(entityKey, blob.name)}
              name={blob.name}
              value={blob.value.value as Hex}
              hint={findBytesHint(attributes, blob.name)}
            />
          ))}
        </div>
      </div>

      {popup ? <FilterPopup state={popup} onQueryOnly={onQueryOnly} onAddToQuery={onAddToQuery} onClose={() => setPopup(null)} /> : null}
    </div>
  );
}
