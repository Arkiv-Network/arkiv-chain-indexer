import { useEffect, useState, type MouseEvent } from "react";
import { InfoTooltip } from "@/InfoTooltip";
import { cn } from "@/lib/utils";
import { schemaCondition } from "@/attributes";
import { describeRentCap, fetchNodeRentCap, NODE_STATUS_URL, type NodeRentCap } from "@/nodeRpc";
import { shouldHandleClientNavigation } from "@/permalinks";
import { explorerQueryHref, openExplorerQuery, type ConditionActions } from "./filter-menu";

const pill = "inline-flex items-center rounded-none border px-1.5 py-0.5 text-[10px] font-medium tracking-wide whitespace-nowrap";

/**
 * "Permanent ∞": the entity's expiry is 2^64 − 1. The tooltip says what that
 * costs — rent is charged at most one cap ahead, the cap read from the node's
 * `/signed/v1/status` when it is reachable — and who may extend.
 */
export function PermanentBadge({ className }: { className?: string }) {
  const [cap, setCap] = useState<NodeRentCap | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void fetchNodeRentCap().then((value) => {
      if (alive) setCap(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        className={cn(pill, "border-violet-600/40 bg-violet-600/10 text-violet-700 dark:border-violet-400/40 dark:bg-violet-400/10 dark:text-violet-300")}
        title="expiresAt = 18446744073709551615 (2^64 − 1): never expires"
      >
        Permanent ∞
      </span>
      <InfoTooltip label="About permanent entities" size={12}>
        <strong>Permanent entity</strong>
        <p>
          Its expiry is 2^64 − 1 (block 18446744073709551615), so the chain never expires it; there is no
          lifetime to run out.
        </p>
        <p>
          Rent is charged at most one cap ahead — {describeRentCap(cap ?? null)} — so making an entity permanent
          costs the same rent as a lifetime of that cap.
        </p>
        <p>
          Only the owner can extend beyond the cap. Anyone else may extend an entity created with permissionless
          extension only up to the current block plus the cap; the node rejects a longer extension, and any
          extension to permanent, from a non-owner (PermanenceOwnerOnly).
        </p>
        {cap === null ? (
          <p>
            {NODE_STATUS_URL
              ? "The node's status was not reachable, so its cap is not shown."
              : "No node status URL is configured here, so the cap is not shown."}
          </p>
        ) : null}
      </InfoTooltip>
    </span>
  );
}

/**
 * The entity's schema (its indexed str `arkiv.schema`), shown as a header
 * badge instead of an attribute row. Clicking queries every entity of it.
 */
export function SchemaBadge({ name, actions, className }: { name: string; actions?: ConditionActions; className?: string }) {
  const expression = schemaCondition(name);
  const classes = cn(
    pill,
    "border-sky-600/40 bg-sky-600/10 text-sky-700 normal-case transition-colors hover:bg-sky-600/20 dark:border-sky-400/40 dark:bg-sky-400/10 dark:text-sky-300",
    className,
  );
  const title = `Query ${expression}`;
  if (actions?.onQueryOnly) {
    return (
      <button type="button" className={classes} title={title} onClick={() => actions.onQueryOnly?.(expression)}>
        schema: {name}
      </button>
    );
  }
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    openExplorerQuery(expression, actions?.onLocationChange);
  };
  return (
    <a className={classes} href={explorerQueryHref(expression)} title={title} onClick={onClick}>
      schema: {name}
    </a>
  );
}

/** Filled "indexed" (queryable) or muted "stored" (returned, never matched); "?" when the source did not say. */
export function IndexedBadge({ indexed, className }: { indexed: boolean | null; className?: string }) {
  if (indexed === null) {
    return (
      <span className={cn(pill, "border-border text-muted-foreground", className)} title="The endpoint did not say whether this attribute is indexed">
        ?
      </span>
    );
  }
  return indexed ? (
    <span
      className={cn(pill, "border-emerald-700 bg-emerald-700 text-white dark:border-emerald-500 dark:bg-emerald-600", className)}
      title="Indexed: queries can match it"
    >
      indexed
    </span>
  ) : (
    <span className={cn(pill, "border-border bg-muted/40 text-muted-foreground", className)} title="Stored, not queryable: returned with the entity, never matched by a query">
      stored
    </span>
  );
}

/** The attribute's type tag as a small mono chip. */
export function TypeChip({ type, className, title }: { type: string; className?: string; title?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center border border-border bg-background px-1 py-px font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
      title={title}
    >
      {type}
    </span>
  );
}
