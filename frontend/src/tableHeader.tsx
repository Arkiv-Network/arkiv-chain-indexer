import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Splits a "Label (unit)" header into the label and a smaller, muted unit on
 * its own line, so units don't compete with the column name.
 */
export function renderTableHeader(label: string): ReactNode {
  const match = label.match(/^(.*)\s+\(([^)]+)\)$/);
  if (!match) return label;

  const [, left, unit] = match;
  return (
    <span className="block leading-tight whitespace-normal">
      {left}
      <br />
      <span className="font-normal text-muted-foreground/80 normal-case">({unit})</span>
    </span>
  );
}

export type SortDirection = "asc" | "desc";

/** Up/down/unsorted glyph for a sortable column header. */
export function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) return <ArrowUpDown className="size-3 shrink-0 text-muted-foreground/50" />;
  return direction === "asc" ? (
    <ArrowUp className="size-3 shrink-0 text-foreground" />
  ) : (
    <ArrowDown className="size-3 shrink-0 text-foreground" />
  );
}
