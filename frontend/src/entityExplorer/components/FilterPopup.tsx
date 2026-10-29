// The small menu a value opens in the entity explorer: query by it, add it to
// the current query, or copy it. Values that cannot be filtered on say why.

import { Check, Clipboard, CodeXml, ListPlus, Search } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { copyText } from "@/components/copy-cell";
import { StrValue } from "@/components/str-value";
import { escapedStrCopy } from "@/attributes";
import { attributeFilter, isFilterable, type EntityAttribute } from "../lib/entity";

const menuItemClass = "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted";
const POPUP_WIDTH = 240;

export interface FilterPopupState {
  /** Empty when the value cannot be queried, which hides the query items. */
  expression: string;
  label: string;
  copyValue: string;
  /** A str's escaped form (escapedStrCopy), offered beside the value when it has one. */
  copyEscapedValue?: string;
  /** Shown instead of the query items, to say why this value can't be filtered on. */
  note?: string;
  x: number;
  y: number;
}

export type PointerLike = Pick<ReactMouseEvent, "clientX" | "clientY">;

/** Places the popup at the pointer without letting it run off the right edge. */
export function popupAt(event: PointerLike, state: Omit<FilterPopupState, "x" | "y">): FilterPopupState {
  return { ...state, x: Math.max(8, Math.min(event.clientX, window.innerWidth - POPUP_WIDTH - 8)), y: event.clientY };
}

/** Enter or Space on a value acts like a click, with the menu under the value. */
export function popupFromKey(event: ReactKeyboardEvent<HTMLElement>): PointerLike | null {
  if (event.key !== "Enter" && event.key !== " ") return null;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom };
}

/** A menu offering to query by one value, add it to the current query, or copy it. */
export function FilterPopup({
  state,
  onQueryOnly,
  onAddToQuery,
  onClose,
}: {
  state: FilterPopupState;
  onQueryOnly: (expression: string) => void;
  onAddToQuery: (expression: string) => void;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<"value" | "escaped" | null>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(onClose, 700);
    return () => window.clearTimeout(timeout);
  }, [copied, onClose]);

  return (
    <div
      ref={popupRef}
      role="menu"
      className="fixed z-50 border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ left: state.x, top: state.y, width: POPUP_WIDTH }}
    >
      {state.expression ? (
        <>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              onQueryOnly(state.expression);
              onClose();
            }}
          >
            <Search className="size-3 shrink-0 text-muted-foreground" />
            Query by {state.label} only
          </button>
          <button
            type="button"
            role="menuitem"
            className={menuItemClass}
            onClick={() => {
              onAddToQuery(state.expression);
              onClose();
            }}
          >
            <ListPlus className="size-3 shrink-0 text-muted-foreground" />
            Add to current query
          </button>
        </>
      ) : null}
      {state.note ? <p className="px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">{state.note}</p> : null}
      <button
        type="button"
        role="menuitem"
        className={menuItemClass}
        onClick={async () => {
          if (await copyText(state.copyValue)) setCopied("value");
        }}
      >
        {copied === "value" ? <Check className="size-3 text-(--ok)" /> : <Clipboard className="size-3 text-muted-foreground" />}
        {copied === "value" ? "Copied" : "Copy value"}
      </button>
      {state.copyEscapedValue ? (
        <button
          type="button"
          role="menuitem"
          className={menuItemClass}
          onClick={async () => {
            if (await copyText(state.copyEscapedValue!)) setCopied("escaped");
          }}
        >
          {copied === "escaped" ? <Check className="size-3 text-(--ok)" /> : <CodeXml className="size-3 text-muted-foreground" />}
          {copied === "escaped" ? "Copied" : "Copy escaped value"}
        </button>
      ) : null}
      {state.expression ? (
        <span className="mt-1 block truncate border-t border-border px-2.5 pt-1.5 font-mono text-[10px] text-muted-foreground">
          <StrValue text={state.expression} />
        </span>
      ) : null}
    </div>
  );
}

/** The copy fields for a str value: itself, and its escaped form when it has one. */
export function strCopy(text: string): Pick<FilterPopupState, "copyValue" | "copyEscapedValue"> {
  const escaped = escapedStrCopy(text);
  return { copyValue: text, ...(escaped !== null ? { copyEscapedValue: escaped } : {}) };
}

/** The popup for one attribute: query items when it's indexed, an explanation when not. */
export function attributePopup(event: PointerLike, attribute: EntityAttribute): FilterPopupState {
  const { name, value } = attribute;
  const filterable = isFilterable(attribute);
  return popupAt(event, {
    expression: filterable ? attributeFilter(name, value) : "",
    label: name,
    ...(value.type === "str" ? strCopy(value.value) : { copyValue: String(value.value) }),
    note: filterable
      ? undefined
      : value.type === "bytes"
        ? `${name} is bytes, which is never indexed, so queries can't filter on it.`
        : `${name} is stored but not indexed, so queries can't filter on it.`,
  });
}
