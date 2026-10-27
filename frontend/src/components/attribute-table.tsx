import { Filter } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { CopyButton } from "@/components/copy-cell";
import { cn } from "@/lib/utils";
import {
  attributeCondition,
  attributeText,
  conditionUnavailableReason,
  type AttributeChange,
  type AttributeView,
} from "@/attributes";
import { addressDetailHref, entityDetailHref, shouldHandleClientNavigation, writeEntityPermalink } from "@/permalinks";
import { BytesValue, type BytesSource } from "./bytes-value";
import { IndexedBadge, TypeChip } from "./entity-badges";
import { FilterMenu, type ConditionActions } from "./filter-menu";

/** Strings longer than this are cut in the cell; the full text is in the tooltip and the copy button. */
const STR_DISPLAY_LIMIT = 240;

const CHANGE_STYLE: Record<AttributeChange["kind"], { label: string; className: string }> = {
  set: { label: "set", className: "text-emerald-700 border-emerald-600/40 dark:text-emerald-400 dark:border-emerald-400/40" },
  changed: { label: "changed", className: "text-sky-700 border-sky-600/40 dark:text-sky-400 dark:border-sky-400/40" },
  unchanged: { label: "same", className: "text-muted-foreground border-border" },
  unset: { label: "unset", className: "text-red-700 border-red-600/40 dark:text-red-400 dark:border-red-400/40" },
  "unset-missing": { label: "unset", className: "text-muted-foreground border-border" },
};

export interface AttributeTableProps {
  /** A state: every attribute as it is. */
  attributes?: readonly AttributeView[];
  /** A create or patch: what each triple did. Takes precedence over `attributes`. */
  changes?: readonly AttributeChange[];
  /** Filter / copy-condition actions for indexed attributes; omitted for none. */
  actions?: ConditionActions;
  /** Where bytes contents can be loaded from. */
  bytes?: BytesSource | null;
  /** Shown when there is nothing to list. */
  emptyText?: string;
  onLocationChange?: () => void;
  className?: string;
}

/**
 * The attribute table shared by the transaction page (an operation's triples),
 * the entity page (the current state and each version) and the Data tab's
 * cards: Name | type | indexed or stored | value, with filter actions only
 * where a query can match.
 */
export function AttributeTable({ attributes, changes, actions, bytes, emptyText = "No attributes", onLocationChange, className }: AttributeTableProps) {
  const patch = changes !== undefined;
  const rows = patch ? changes : (attributes ?? []).map((attribute) => attribute);
  if (rows.length === 0) return <p className={cn("text-xs text-muted-foreground", className)}>{emptyText}</p>;
  const withActions = actions !== undefined;

  return (
    <div className={cn("relative w-full overflow-x-auto", className)}>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-[10px] tracking-wider text-muted-foreground uppercase">
            {patch ? <th className="py-1.5 pr-2 font-medium">Change</th> : null}
            <th className="py-1.5 pr-2 font-medium">Name</th>
            <th className="py-1.5 pr-2 font-medium">Type</th>
            <th className="py-1.5 pr-2 font-medium">Index</th>
            <th className="w-full py-1.5 pr-2 font-medium">Value</th>
            {withActions ? <th className="py-1.5 font-medium"><span className="sr-only">Query</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {patch
            ? changes.map((change, index) => (
                <ChangeRow
                  key={`${change.name}:${index}`}
                  change={change}
                  actions={actions}
                  bytes={bytes}
                  onLocationChange={onLocationChange}
                />
              ))
            : (attributes ?? []).map((attribute, index) => (
                <tr key={`${attribute.name}:${index}`} className="border-b border-dashed border-border align-top last:border-0">
                  <NameCell name={attribute.name} />
                  <td className="py-1.5 pr-2"><TypeChip type={attribute.type} /></td>
                  <td className="py-1.5 pr-2"><IndexedBadge indexed={attribute.indexed} /></td>
                  <td className="min-w-0 py-1.5 pr-2">
                    <AttributeValue attribute={attribute} bytes={bytes} onLocationChange={onLocationChange} />
                  </td>
                  {withActions ? <ActionCell attribute={attribute} actions={actions} /> : null}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

function NameCell({ name, struck = false }: { name: string; struck?: boolean }) {
  return (
    <td className={cn("max-w-56 py-1.5 pr-2 font-mono break-all text-foreground", struck && "text-muted-foreground line-through")}>
      {name}
    </td>
  );
}

function ActionCell({ attribute, actions }: { attribute: AttributeView | null; actions: ConditionActions }) {
  const condition = attribute ? attributeCondition(attribute) : null;
  return (
    <td className="py-1 align-top">
      {condition && attribute ? (
        <FilterMenu expression={condition} label={attribute.name} actions={actions} />
      ) : attribute ? (
        <span
          className="inline-flex size-5 items-center justify-center text-muted-foreground/40"
          title={conditionUnavailableReason(attribute) ?? undefined}
          aria-label={conditionUnavailableReason(attribute) ?? undefined}
        >
          <Filter className="size-3" />
        </span>
      ) : null}
    </td>
  );
}

function ChangeRow({
  change,
  actions,
  bytes,
  onLocationChange,
}: {
  change: AttributeChange;
  actions?: ConditionActions;
  bytes?: BytesSource | null;
  onLocationChange?: () => void;
}) {
  const style = CHANGE_STYLE[change.kind];
  const current = change.after ?? change.before;
  const before = change.before;
  const after = change.after;
  const unset = change.kind === "unset" || change.kind === "unset-missing";
  return (
    <tr className="border-b border-dashed border-border align-top last:border-0">
      <td className="py-1.5 pr-2">
        <span className={cn("inline-flex items-center border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase", style.className)}>
          {style.label}
        </span>
      </td>
      <NameCell name={change.name} struck={unset} />
      <td className="py-1.5 pr-2 whitespace-nowrap">
        {change.retyped && before && after ? (
          <span className="inline-flex items-center gap-1 bg-amber-500/15 px-0.5" title="Retyped: the patch changed the attribute's type">
            <TypeChip type={before.type} className="line-through" />
            <span className="text-amber-700 dark:text-amber-400">→</span>
            <TypeChip type={after.type} className="border-amber-600/60 text-amber-800 dark:text-amber-300" />
          </span>
        ) : current && current.type !== "tombstone" ? (
          <TypeChip type={current.type} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-1.5 pr-2 whitespace-nowrap">
        {change.indexChange && before && after ? (
          <span className="inline-flex items-center gap-1 bg-amber-500/15 px-0.5" title={`Now ${change.indexChange === "indexed" ? "indexed: queries match it" : "stored only: queries no longer match it"}`}>
            <IndexedBadge indexed={before.indexed} />
            <span className="text-amber-700 dark:text-amber-400">⇄</span>
            <IndexedBadge indexed={after.indexed} />
          </span>
        ) : current && current.type !== "tombstone" ? (
          <IndexedBadge indexed={current.indexed} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="min-w-0 py-1.5 pr-2">
        {unset ? (
          before ? (
            <span className="text-muted-foreground line-through decoration-red-500/60">
              <AttributeValue attribute={before} bytes={null} onLocationChange={onLocationChange} plain />
            </span>
          ) : (
            <span className="text-muted-foreground">
              {change.priorUnknown ? "unset (previous value not in the stored history)" : "was not set"}
            </span>
          )
        ) : change.kind === "changed" && before && after ? (
          <span className="flex flex-col gap-0.5">
            <span className="text-muted-foreground line-through">
              <AttributeValue attribute={before} bytes={null} onLocationChange={onLocationChange} plain />
            </span>
            <AttributeValue attribute={after} bytes={bytes} onLocationChange={onLocationChange} />
          </span>
        ) : after ? (
          <span className="flex flex-col gap-0.5">
            <AttributeValue attribute={after} bytes={bytes} onLocationChange={onLocationChange} />
            {after.error ? <span className="text-[11px] text-destructive">{after.error}</span> : null}
            {change.kind === "set" && change.priorUnknown ? (
              <span className="text-[10px] text-muted-foreground">previous value not in the stored history</span>
            ) : null}
          </span>
        ) : null}
      </td>
      {actions !== undefined ? <ActionCell attribute={unset ? null : after} actions={actions} /> : null}
    </tr>
  );
}

/** One value, rendered for its type. `plain` drops links and actions (for a struck-through old value). */
export function AttributeValue({
  attribute,
  bytes,
  onLocationChange,
  plain = false,
}: {
  attribute: AttributeView;
  bytes?: BytesSource | null;
  onLocationChange?: () => void;
  plain?: boolean;
}): ReactNode {
  if (attribute.error && attribute.type !== "bytes") {
    return <span className="text-destructive" title={attribute.error}>{attribute.type}</span>;
  }
  const text = attributeText(attribute);
  switch (attribute.type) {
    case "bytes":
      return plain ? (
        <span className="font-mono">{text}{attribute.keccak256 ? ` (${attribute.keccak256.slice(0, 10)}…)` : ""}</span>
      ) : (
        <BytesValue attribute={attribute} source={bytes} />
      );
    case "bool":
      return (
        <span
          className={cn(
            "inline-flex items-center border px-1 py-px font-mono text-[10px]",
            text === "true" ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-400" : "border-border text-muted-foreground",
          )}
        >
          {text}
        </span>
      );
    case "i32":
    case "u64":
    case "u256":
    case "dec":
      return (
        <span className="font-mono tabular-nums break-all text-foreground" title={typeof attribute.value === "string" && attribute.value !== text ? `wire value ${attribute.value}` : undefined}>
          {text}
        </span>
      );
    case "addr":
      return plain ? <span className="font-mono break-all">{text}</span> : <AddressValue address={text} />;
    case "key":
      return plain ? <span className="font-mono break-all">{text}</span> : <EntityKeyValue entityKey={text} onLocationChange={onLocationChange} />;
    case "bytes32":
      return (
        <span className="inline-flex max-w-full items-center gap-1">
          <span className="font-mono break-all">{text}</span>
          {plain ? null : <CopyButton value={text} label="value" />}
        </span>
      );
    case "str": {
      const cut = text.length > STR_DISPLAY_LIMIT ? `${text.slice(0, STR_DISPLAY_LIMIT)}…` : text;
      return (
        <span className="inline-flex max-w-full items-start gap-1">
          <span className="break-words whitespace-pre-wrap text-foreground" title={cut !== text ? text : undefined}>
            {cut === "" ? <span className="text-muted-foreground italic">empty string</span> : cut}
          </span>
          {plain || text.length <= 40 ? null : <CopyButton value={text} label="value" />}
        </span>
      );
    }
    case "tombstone":
      return <span className="text-muted-foreground">unset</span>;
    default:
      return <span className="font-mono break-all text-muted-foreground">{text || "—"}</span>;
  }
}

function AddressValue({ address }: { address: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <a className="font-mono break-all text-foreground transition-colors hover:text-accent hover:underline" href={addressDetailHref(address)} title="View address">
        {address}
      </a>
      <CopyButton value={address} label="address" />
    </span>
  );
}

function EntityKeyValue({ entityKey, onLocationChange }: { entityKey: string; onLocationChange?: () => void }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onLocationChange || !shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writeEntityPermalink(entityKey)) onLocationChange();
  };
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <a className="font-mono break-all text-foreground transition-colors hover:text-accent hover:underline" href={entityDetailHref(entityKey)} onClick={onClick} title="View entity">
        {entityKey}
      </a>
      <CopyButton value={entityKey} label="entity key" />
    </span>
  );
}
