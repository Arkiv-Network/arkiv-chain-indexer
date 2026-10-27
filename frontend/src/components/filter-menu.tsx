import { Clipboard, Filter, Search } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/components/copy-cell";
import { buildRouteHref, shouldHandleClientNavigation, writePermalink } from "@/permalinks";

/**
 * Where a query condition goes: a link that opens the entity explorer with it.
 * (The explorer's own results use its FilterPopup, which can also add to the
 * current query.)
 */
export interface ConditionActions {
  /** The SPA navigation callback for the entity explorer link. */
  onLocationChange?: () => void;
}

/** The entity explorer running `expression` (its `q` URL parameter). */
export function explorerQueryHref(expression: string): string {
  return buildRouteHref("entity-explorer", { q: expression });
}

/** Opens the entity explorer with a query, as an SPA navigation. */
export function openExplorerQuery(expression: string, onLocationChange?: () => void): void {
  if (writePermalink("entity-explorer", { q: expression })) onLocationChange?.();
}

/**
 * A small menu offering to query by one value in the entity explorer, or copy
 * the condition (and, when given, the bare value). Triggered by the funnel
 * button next to a key, address or indexed attribute.
 */
export function FilterMenu({
  expression,
  label,
  copyValue,
  actions,
}: {
  expression: string;
  label: string;
  /** The bare value, when copying it is useful beside the condition. */
  copyValue?: string;
  actions: ConditionActions;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"condition" | "value" | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    // The menu is portalled with fixed coordinates so a scrolling table cannot clip it.
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom > 180 || rect.top < 180;
      setPosition({
        position: "fixed",
        right: Math.max(8, window.innerWidth - rect.right),
        ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
      });
    };
    place();
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = async (what: "condition" | "value") => {
    if (await copyText(what === "condition" ? expression : copyValue ?? "")) setCopied(what);
  };

  const itemClass = "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent";
  const href = explorerQueryHref(expression);
  const onLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    setOpen(false);
    openExplorerQuery(expression, actions.onLocationChange);
  };

  return (
    <span className="relative inline-flex" ref={rootRef}>
      <button
        type="button"
        className="inline-flex size-5 shrink-0 items-center justify-center border border-border text-muted-foreground opacity-70 transition-colors hover:border-accent hover:text-accent hover:opacity-100"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Query by ${label}`}
        aria-label={`Query by ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <Filter className="size-3" />
      </button>
      {open && position ? createPortal(
        <span ref={menuRef} style={position} className="z-[1000] block min-w-52 border border-border bg-popover p-1 text-popover-foreground shadow-md" role="menu">
          <a role="menuitem" className={itemClass} href={href} onClick={onLink}>
            <Search className="size-3 text-muted-foreground" />
            Query by {label} in Entities
          </a>
          <button type="button" role="menuitem" className={itemClass} onClick={() => void copy("condition")}>
            <Clipboard className="size-3 text-muted-foreground" />
            {copied === "condition" ? "Copied" : "Copy condition"}
          </button>
          {copyValue ? (
            <button type="button" role="menuitem" className={itemClass} onClick={() => void copy("value")}>
              <Clipboard className="size-3 text-muted-foreground" />
              {copied === "value" ? "Copied" : "Copy value"}
            </button>
          ) : null}
          <span className="mt-1 block max-w-80 truncate border-t border-border px-2.5 pt-1.5 font-mono text-[10px] text-muted-foreground">
            {expression}
          </span>
        </span>,
        document.body,
      ) : null}
    </span>
  );
}
