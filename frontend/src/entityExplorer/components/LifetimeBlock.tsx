// An entity's lifetime in the entity explorer: a bar from creation to expiry,
// and the blocks at each end with dates estimated from the node's block timing.

import { Hourglass, Infinity as InfinityIcon } from "lucide-react";
import { fmtDate } from "@/format";
import { cn } from "@/lib/utils";
import type { BlockTiming } from "../lib/client";
import { estimateBlockIso, estimateBlockTimestampMs, formatRelativeMs, isPermanentExpiry, lifetimeProgress } from "../lib/query";
import { fieldLabelClass } from "./styles";

export function BlockStamp({ block, timing, timeZone, align = "left" }: { block: bigint; timing: BlockTiming | null; timeZone: string; align?: "left" | "right" }) {
  const iso = timing ? estimateBlockIso(block, timing) : null;
  return (
    <div className={cn("flex flex-col", align === "right" && "items-end text-right")}>
      <span className="mt-0.5 font-mono text-xs text-foreground">{block.toString()}</span>
      {timing ? (
        <span className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground" title="Estimated from the node's block timing">
          {iso ? fmtDate(iso, timeZone) : "too far away to estimate"}
        </span>
      ) : null}
    </div>
  );
}

const TONE_TEXT = {
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
  muted: "text-muted-foreground",
} as const;

const TONE_BAR = {
  green: "bg-emerald-500 dark:bg-emerald-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  red: "bg-red-500 dark:bg-red-400",
  muted: "bg-muted-foreground/40",
} as const;

export function LifetimeBlock({
  createdAt,
  expiresAt,
  timing,
  timeZone,
}: {
  createdAt: bigint;
  expiresAt: bigint;
  timing: BlockTiming | null;
  timeZone: string;
}) {
  const permanent = isPermanentExpiry(expiresAt);
  const progress = timing ? lifetimeProgress(createdAt, expiresAt, timing.currentBlock) : null;
  const relative = permanent ? "permanent" : timing ? formatRelativeMs(estimateBlockTimestampMs(expiresAt, timing), Date.now()) : null;
  const tone: keyof typeof TONE_TEXT = permanent
    ? "green"
    : !progress || progress.expired
      ? "muted"
      : progress.leftPct < 20
        ? "red"
        : progress.leftPct < 50
          ? "amber"
          : "green";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={fieldLabelClass}>Lifetime</span>
        {relative && (permanent || progress) ? (
          <span className={cn("inline-flex items-center gap-1 text-[10px] font-medium", TONE_TEXT[tone])}>
            {permanent ? <InfinityIcon className="size-3" /> : <Hourglass className="size-3" />}
            {progress?.expired ? "expired" : relative}
          </span>
        ) : null}
      </div>
      <div className="relative mt-1.5" title={progress ? `${Math.round(progress.leftPct)}% of the lifetime remains` : undefined}>
        <div className="h-1.5 overflow-hidden bg-muted">
          {progress ? <div className={cn("h-full", TONE_BAR[tone])} style={{ width: `${progress.consumedPct}%` }} /> : null}
        </div>
        {progress ? (
          <div
            className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-foreground"
            style={{ left: `${progress.consumedPct}%` }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-baseline gap-2">
        <span className={fieldLabelClass}>Created</span>
        <span className="text-[10px] text-muted-foreground">
          {progress ? (progress.expired ? "0% left" : `${Math.round(progress.leftPct)}% left`) : ""}
        </span>
        <span className={cn("text-right text-[10px] font-medium tracking-wider uppercase", TONE_TEXT[tone])}>Expires</span>
      </div>
      <div className="mt-0.5 grid grid-cols-2 gap-2">
        <BlockStamp block={createdAt} timing={timing} timeZone={timeZone} />
        {permanent ? (
          <span className="mt-0.5 text-right font-mono text-xs text-foreground">Permanent</span>
        ) : (
          <BlockStamp block={expiresAt} timing={timing} timeZone={timeZone} align="right" />
        )}
      </div>
    </div>
  );
}
