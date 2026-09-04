import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { type BaseloadWorkerBehavior } from "../../baseloadConfig";

/** Short plain-text label for behavior chips and badges. */
export const BEHAVIOR_SHORT_LABELS: Record<BaseloadWorkerBehavior, string> = {
  "create": "create",
  "create-update": "create + update",
  "create-ownership": "ownership",
  "time-bomb": "time bomb",
  "create-update-delete": "full churn",
};

/**
 * Left-border + badge tint per worker behavior. Mirrors the tone system
 * HealthView.tsx uses for sync status: Tailwind palette utilities (with a
 * dark: pair), not raw hex or a `--w-accent` custom property.
 */
export const BEHAVIOR_TONE: Record<BaseloadWorkerBehavior, { border: string; badge: string }> = {
  "create": {
    border: "border-l-emerald-500",
    badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  "create-update": {
    border: "border-l-primary",
    badge: "bg-primary/10 text-primary",
  },
  "create-ownership": {
    border: "border-l-violet-500",
    badge: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  "time-bomb": {
    border: "border-l-destructive",
    badge: "bg-destructive/10 text-destructive",
  },
  "create-update-delete": {
    border: "border-l-amber-500",
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
};

/** Same tone vocabulary as SyncTone (see syncStatus.ts / HealthView.tsx). */
export type StatusTone = "ok" | "info" | "warn" | "danger" | "muted";

export const STATUS_TONE_BADGE: Record<StatusTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "bg-primary/10 text-primary",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "bg-destructive/10 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

const TASK_STATUS_TONE: Record<string, StatusTone> = {
  running: "ok",
  ready: "ok",
  updated: "ok",
  waiting: "warn",
  error: "danger",
  completed: "info",
};

export function taskStatusTone(status: string): StatusTone {
  return TASK_STATUS_TONE[status] ?? "muted";
}

/** Native <select> styled to match components/ui/input.tsx. No Select
 * primitive exists in this project's ui kit yet. */
export const nativeSelectClassName =
  "h-8 w-full min-w-0 rounded-none border border-input bg-transparent px-2.5 py-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-input/50 dark:bg-input/30 dark:disabled:bg-input/80";

export function Field({
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
      <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

export const ERROR_SUMMARY_MAX_LENGTH = 160;
export const CELL_ERROR_SUMMARY_MAX_LENGTH = 80;

// Worker errors carry full describeError output (stack, cause chain, RPC
// bodies). Render only the first line by default so a failing fleet doesn't
// turn the panel into a wall of stack traces; the full text stays one click
// away.
export function ErrorDetail({
  message,
  className,
  maxLength = ERROR_SUMMARY_MAX_LENGTH,
}: {
  message: string;
  className?: string;
  maxLength?: number;
}) {
  const firstLine = message.split("\n", 1)[0] ?? message;
  const summary = firstLine.length > maxLength ? `${firstLine.slice(0, maxLength)}…` : firstLine;
  const resolvedClassName = className ?? "text-xs text-destructive";
  if (summary === message) {
    return <span className={resolvedClassName}>{message}</span>;
  }
  return (
    <details className="inline-block max-w-full">
      <summary className={cn("cursor-pointer", resolvedClassName)}>{summary}</summary>
      <pre className="mt-1 max-h-64 overflow-y-auto rounded-none bg-destructive/5 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-destructive break-words">
        {message}
      </pre>
    </details>
  );
}
