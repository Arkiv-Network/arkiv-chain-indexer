import { useCallback, useEffect, useState } from "react";
import { fetchSyncStatus, type SyncStatus } from "./api";
import { fmtDate, fmtDurationSeconds, fmtInteger } from "./format";
import { describeSync, fmtRate } from "./syncStatus";

const POLL_MS = 10_000;

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

  return (
    <div className={`sync-banner sync-banner-${presentation.tone}`} role="status" aria-live="polite">
      <div className="sync-banner-main">
        <span className="sync-banner-badge">{presentation.label}</span>
        <div className="sync-banner-text">
          <strong>{presentation.headline}</strong>
          <span className="sync-banner-detail">{presentation.detail}</span>
        </div>
        <button
          type="button"
          className="sync-banner-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide details" : "Details"}
        </button>
      </div>
      {expanded ? <SyncDetails status={status} timeZone={timeZone} /> : null}
    </div>
  );
}

export function SyncDetails({ status, timeZone }: { status: SyncStatus; timeZone: string }) {
  return (
    <div className="sync-details">
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
    <div className="sync-detail" title={title}>
      <span className="sync-detail-label">{label}</span>
      <span className="sync-detail-value">{value}</span>
    </div>
  );
}
