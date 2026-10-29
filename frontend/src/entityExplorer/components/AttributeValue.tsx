// One typed attribute value, rendered for its type, as the entity explorer shows it
// in result rows and entity details. Colours follow the query editor's palette
// so a value reads the same in a result as in the query that matched it.

import type { ArkivValue } from "@arkiv-network/sdk";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { hexToBytes } from "viem";
import { cn } from "@/lib/utils";
import { escapedStrValue } from "@/attributes";
import { StrValue } from "@/components/str-value";
import { classifyBytes, formatBytes, kindLabel, type BytesHint } from "../lib/bytes";
import { asUnixDate, NUMERIC_TYPES } from "../lib/entity";
import { fmtDate } from "@/format";

export function truncateMiddle(value: string, start = 12, end = 10): string {
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

export function TypeTagChip({ tag, className }: { tag: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center border border-border bg-background px-1 py-px font-mono text-[9px] leading-none text-muted-foreground",
        className,
      )}
    >
      {tag}
    </span>
  );
}

export function valueToneClass(type: ArkivValue["type"]): string {
  if (NUMERIC_TYPES.has(type)) return "text-(--q-number)";
  if (type === "str") return "text-(--q-string)";
  if (type === "bool") return "text-(--q-keyword)";
  return "text-foreground";
}

export function BytesSummary({ value, hint }: { value: `0x${string}`; hint?: BytesHint }) {
  const summary = useMemo(() => {
    const bytes = hexToBytes(value);
    return `${kindLabel(classifyBytes(bytes, hint))} · ${formatBytes(bytes.byteLength)}`;
  }, [value, hint]);
  return <span className="text-muted-foreground">{summary}</span>;
}

/**
 * Strings quoted, with control characters as visible escapes, numbers in full, references with a button to open the entity
 * they point at, blobs as a summary. `compact` keeps it on one line.
 */
export function AttributeValue({
  value,
  compact = false,
  hint,
  timeZone = "UTC",
  onOpenEntity,
}: {
  value: ArkivValue;
  compact?: boolean;
  hint?: BytesHint;
  timeZone?: string;
  onOpenEntity?: (key: string) => void;
}) {
  const tone = valueToneClass(value.type);

  switch (value.type) {
    case "bytes":
      return <BytesSummary value={value.value} hint={hint} />;
    case "str":
      return (
        <span
          className={cn(tone, compact ? "truncate" : "wrap-break-word whitespace-pre-wrap")}
          title={compact ? escapedStrValue(value.value) : undefined}
        >
          &quot;<StrValue text={value.value} />&quot;
        </span>
      );
    case "key":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn(tone, "truncate")} title={value.value}>
            {truncateMiddle(value.value, compact ? 8 : 14, compact ? 6 : 12)}
          </span>
          {onOpenEntity ? (
            <button
              type="button"
              className="flex shrink-0 items-center p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={`Open entity ${value.value}`}
              aria-label={`Open linked entity ${value.value}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenEntity(value.value);
              }}
            >
              <ArrowRight className="size-3" />
            </button>
          ) : null}
        </span>
      );
    case "addr":
    case "bytes32":
      return (
        <span className={cn(tone, compact ? "truncate" : "break-all")} title={value.value}>
          {compact ? truncateMiddle(value.value, 8, 6) : value.value}
        </span>
      );
    default: {
      const date = asUnixDate(value);
      return (
        <span className={cn("flex min-w-0 items-baseline gap-2", compact && "overflow-hidden")}>
          <span className={cn(tone, compact ? "truncate" : "break-all")}>{String(value.value)}</span>
          {date && !compact ? (
            <span
              className="shrink-0 text-[10px] text-muted-foreground"
              title="This number reads as Unix seconds. Columns carry no unit, so this is a guess."
            >
              ≈ {fmtDate(date.toISOString(), timeZone)}
            </span>
          ) : null}
        </span>
      );
    }
  }
}
