import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ArkivOperationSummaryEntry } from "@/api";

type Tone = "emerald" | "sky" | "amber" | "violet" | "red" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  emerald: "text-emerald-600 border-emerald-600/30 dark:text-emerald-400 dark:border-emerald-400/30",
  sky: "text-sky-600 border-sky-600/30 dark:text-sky-400 dark:border-sky-400/30",
  amber: "text-amber-600 border-amber-600/30 dark:text-amber-400 dark:border-amber-400/30",
  violet: "text-violet-600 border-violet-600/30 dark:text-violet-400 dark:border-violet-400/30",
  red: "text-red-600 border-red-600/30 dark:text-red-400 dark:border-red-400/30",
  muted: "text-muted-foreground border-border",
};

// Same hue mapping as the Data Explorer's entity event feed, so an "extend"
// Arkiv op and an "ExpiryExtended" entity event read as the same color.
const OP_TONE: Record<string, Tone> = {
  create: "emerald",
  update: "sky",
  extend: "amber",
  transfer: "violet",
  delete: "red",
  expire: "muted",
  reference: "sky",
};

const badgeClass =
  "inline-flex items-center rounded-none border px-1.5 py-0.5 text-[10px] font-medium tracking-wide whitespace-nowrap uppercase";

/** Small pill for a single Arkiv operation type (create/update/extend/...). */
export function OpBadge({ operation, children }: { operation: string; children?: ReactNode }) {
  const tone = OP_TONE[operation] ?? "muted";
  return <span className={cn(badgeClass, TONE_CLASS[tone])}>{children ?? operation}</span>;
}

/** Renders a transaction's `operationsSummary` as a row of `OpBadge`s, or a dash. */
export function OpBadgeList({
  operations,
}: {
  operations: readonly ArkivOperationSummaryEntry[] | null | undefined;
}) {
  if (!operations?.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {operations.map((entry) => (
        <OpBadge key={entry.operationType} operation={entry.operation}>
          {entry.count > 1 ? `${entry.operation} ×${entry.count}` : entry.operation}
        </OpBadge>
      ))}
    </span>
  );
}

export type StatusTone = "ok" | "fail" | "unknown";

const STATUS_CLASS: Record<StatusTone, string> = {
  ok: TONE_CLASS.emerald,
  fail: TONE_CLASS.red,
  unknown: TONE_CLASS.muted,
};

/** Small pill for a success/failure/unknown verdict (tx status, verification, ...). */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={cn(badgeClass, STATUS_CLASS[tone])}>{children}</span>;
}
