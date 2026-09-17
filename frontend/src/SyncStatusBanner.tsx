import { useCallback, useEffect, useState } from "react";
import { fetchSyncStatus, type SyncStatus } from "./api";
import { fmtDate, fmtDurationSeconds, fmtInteger } from "./format";
import { describeSync, fmtRate, type SyncTone } from "./syncStatus";
import { cn } from "@/lib/utils";

const POLL_MS = 10_000;

const TONE_STYLES: Record<SyncTone, { border: string; bg: string; text: string; badge: string }> = {
  ok: {
    border: "border-emerald-500/60",
    bg: "bg-emerald-500/5",
    text: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  info: {
    border: "border-primary/60",
    bg: "bg-primary/5",
    text: "text-primary",
    badge: "bg-primary/10 text-primary",
  },
  warn: {
    border: "border-amber-500/60",
    bg: "bg-amber-500/5",
    text: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  danger: {
    border: "border-destructive/60",
    bg: "bg-destructive/5",
    text: "text-destructive",
    badge: "bg-destructive/15 text-destructive",
  },
  muted: {
    border: "border-border",
    bg: "bg-muted/40",
    text: "text-muted-foreground",
    badge: "bg-muted text-muted-foreground",
  },
};

interface SyncStatusBannerProps {
  timeZone: string;
  /**
   * Only warn once the scanner trails the chain by at least this many seconds,
   * so a chain with slow blocks does not flash the banner between blocks.
   */
  minLagSeconds?: number;
}

/**
 * Site-wide banner telling the reader that the data they are looking at trails
 * the chain, by how much, whether the gap is closing, and when it should close.
 * Silent while the scanner is at the head.
 */
export function SyncStatusBanner({ timeZone, minLagSeconds = 0 }: SyncStatusBannerProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(() => {
    fetchSyncStatus()
      .then((body) => setStatus(body.sync))
      // A failed poll should never take the page down; keep the last reading.
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!status) return null;
  const presentation = describeSync(status);
  if (!presentation.shouldWarn) return null;
  if ((status.lagSeconds ?? 0) < minLagSeconds) return null;

  const tone = TONE_STYLES[presentation.tone];

  return (
    <div
      className={cn("w-full border-b border-l-4 text-xs", tone.border, tone.bg)}
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-415 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 md:px-6">
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase", tone.badge)}>
          {presentation.label}
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className={cn("font-medium", tone.text)}>{presentation.headline}</strong>
          <span className="text-muted-foreground">{presentation.detail}</span>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>
      {expanded ? (
        <div className="mx-auto max-w-415 px-3 pb-2 md:px-6">
          <SyncDetails status={status} timeZone={timeZone} />
        </div>
      ) : null}
    </div>
  );
}

export function SyncDetails({ status, timeZone }: { status: SyncStatus; timeZone: string }) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 py-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <Detail label="Last stored block" value={fmtInteger(status.lastSuccessfulBlock)} />
      <Detail
        label="Last stored block time"
        value={fmtDate(status.lastSuccessfulBlockDate, timeZone)}
      />
      <Detail
        label="Chain head (estimated now)"
        value={fmtInteger(status.estimatedHeadBlock)}
        title="Last observed head extrapolated to now using the measured block time"
      />
      <Detail
        label="Chain head (last observed)"
        value={
          status.latestObservedBlock === null
            ? "—"
            : `${fmtInteger(status.latestObservedBlock)} (${fmtDurationSeconds(
                status.headObservationAgeSeconds,
              )} ago${status.headObservationStale ? ", stale" : ""})`
        }
      />
      <Detail label="Blocks behind" value={fmtInteger(status.lagBlocks)} />
      <Detail label="Time behind" value={fmtDurationSeconds(status.lagSeconds)} />
      <Detail
        label="Scan rate"
        value={
          status.scanBlocksPerSecond === null
            ? "—"
            : `${fmtRate(status.scanBlocksPerSecond)} blocks/s`
        }
      />
      <Detail
        label="Chain rate"
        value={
          status.chainBlocksPerSecond === null
            ? "—"
            : `${fmtRate(status.chainBlocksPerSecond)} blocks/s (${fmtRate(
                status.chainBlockTimeSeconds,
              )}s block time)`
        }
      />
      <Detail
        label="Gap trend"
        value={
          status.netCatchUpBlocksPerSecond === null
            ? "—"
            : `${fmtRate(Math.abs(status.netCatchUpBlocksPerSecond) * 60)} blocks/min ${
                status.netCatchUpBlocksPerSecond > 0 ? "shrinking" : "growing"
              }`
        }
        title="How fast the distance to the chain head changes"
      />
      <Detail
        label="Estimated sync"
        value={
          status.etaSeconds === null
            ? "—"
            : `${fmtDurationSeconds(status.etaSeconds)} (${fmtDate(status.etaUtc, timeZone)})`
        }
      />
      <Detail
        label="Measured over"
        value={
          status.measuredWindowSeconds === null || status.measuredBlocks === null
            ? "—"
            : `${fmtInteger(status.measuredBlocks)} blocks in ${fmtDurationSeconds(
                status.measuredWindowSeconds,
              )}`
        }
      />
    </div>
  );
}

function Detail({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-2 border-b border-dashed border-border/70 pb-1"
      title={title}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right break-words tabular-nums">{value}</span>
    </div>
  );
}
