import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Collapsible card wrapping a filter form: toggle, active-filter count, optional meta/clear. */
export function FiltersPanel({
  title = "Filters",
  open,
  onOpenChange,
  activeCount,
  showCountAlways = false,
  meta,
  onClearAll,
  clearLabel = "Clear all",
  children,
  className,
}: {
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
  /** Show the count badge even when 0 (e.g. a column-visibility count). */
  showCountAlways?: boolean;
  meta?: ReactNode;
  onClearAll?: () => void;
  clearLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 border border-border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          {title}
          {activeCount > 0 || showCountAlways ? (
            <Badge className="h-4.5 min-w-4.5 justify-center px-1 text-[10px] tabular-nums">{activeCount}</Badge>
          ) : null}
        </button>
        <div className="flex items-center gap-3">
          {meta ? <span className="font-mono text-xs text-muted-foreground">{meta}</span> : null}
          {onClearAll ? (
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onClearAll}>
              {clearLabel}
            </Button>
          ) : null}
        </div>
      </div>
      {open ? <div className="border-t border-border px-3 py-3">{children}</div> : null}
    </div>
  );
}

/** Label above a filter input/select, matching the panel's field spacing. */
export function FilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
      {children}
    </label>
  );
}

/** Class for a native `<select>` sized and styled to match `Input`; no shadcn Select exists here. */
export const selectClass =
  "h-8 rounded-none border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

/** Grouped cluster of `FilterField`s (e.g. "Block" > / <), with a group legend. */
export function FilterGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("flex flex-col gap-1.5", className)}>
      <legend className="mb-1 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}
