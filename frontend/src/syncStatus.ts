import type { SyncState, SyncStatus } from "./api";
import { fmtDurationSeconds, fmtInteger } from "./format";

/** Visual severity for the banner and the health page badge. */
export type SyncTone = "ok" | "info" | "warn" | "danger" | "muted";

export interface SyncPresentation {
  tone: SyncTone;
  /** Short state label, e.g. "Catching up". */
  label: string;
  /** Primary sentence: how far behind the scanner is. */
  headline: string;
  /** Secondary sentence: rate, trend, and ETA. */
  detail: string;
  /** True when the banner should be shown at all. */
  shouldWarn: boolean;
}

const LABELS: Record<SyncState, string> = {
  synced: "In sync",
  "catching-up": "Catching up",
  "falling-behind": "Falling behind",
  holding: "Behind",
  stalled: "Stalled",
  unknown: "Unknown",
};

const TONES: Record<SyncState, SyncTone> = {
  synced: "ok",
  "catching-up": "info",
  "falling-behind": "danger",
  holding: "warn",
  stalled: "danger",
  unknown: "muted",
};

/**
 * Turn the raw `/sync` payload into the sentences the UI shows. Kept out of the
 * components so the wording is unit-testable.
 */
export function describeSync(status: SyncStatus | null): SyncPresentation {
  if (!status) {
    return {
      tone: "muted",
      label: LABELS.unknown,
      headline: "Scanner status unavailable",
      detail: "The backend did not report scanner progress.",
      shouldWarn: false,
    };
  }

  const tone = TONES[status.state] ?? "muted";
  const label = LABELS[status.state] ?? LABELS.unknown;
  const behind = describeLag(status);

  switch (status.state) {
    case "synced":
      return {
        tone,
        label,
        headline: `Scanner is at the chain head${behind ? ` (${behind} behind)` : ""}`,
        detail: describeThroughput(status) ?? "Following new blocks as they are produced.",
        shouldWarn: false,
      };
    case "catching-up":
      return {
        tone,
        label,
        headline: `Scanner is ${behind} behind the chain head`,
        detail: joinSentences([
          describeCatchUpSpeed(status),
          status.etaSeconds !== null
            ? `Estimated to be in sync in ${fmtDurationSeconds(status.etaSeconds)}.`
            : null,
        ]),
        shouldWarn: true,
      };
    case "falling-behind":
      return {
        tone,
        label,
        headline: `Scanner is ${behind} behind and losing ground`,
        detail: joinSentences([
          status.netCatchUpBlocksPerSecond !== null
            ? `The gap is growing by ${fmtRate(Math.abs(status.netCatchUpBlocksPerSecond) * 60)} blocks/min.`
            : null,
          describeThroughput(status),
          "No sync estimate while the scanner is slower than the chain.",
        ]),
        shouldWarn: true,
      };
    case "holding":
      return {
        tone,
        label,
        headline: `Scanner is ${behind} behind and holding that gap`,
        detail: joinSentences([
          describeThroughput(status),
          "The gap is steady, so there is no sync estimate.",
        ]),
        shouldWarn: true,
      };
    case "stalled":
      return {
        tone,
        label,
        headline: `Scanner is ${behind} behind and has stopped`,
        detail: joinSentences([
          status.lastSuccessfulBlockDate !== null && status.lagSeconds !== null
            ? `No block has been stored for ${fmtDurationSeconds(status.lagSeconds)}.`
            : "No new blocks are being stored.",
          "Check the scanner container and its RPC endpoint.",
        ]),
        shouldWarn: true,
      };
    case "unknown":
    default:
      return {
        tone: "muted",
        label: LABELS.unknown,
        headline: "Scanner progress is not known yet",
        detail: "Not enough stored blocks or head observations to measure sync progress.",
        shouldWarn: false,
      };
  }
}

/** "5050 blocks (2h 48m of chain history)" — the human answer to "how far behind?". */
export function describeLag(status: SyncStatus): string {
  if (status.lagBlocks === null) return "an unknown amount";
  const blocks = `${fmtInteger(status.lagBlocks)} ${status.lagBlocks === "1" ? "block" : "blocks"}`;
  if (status.lagSeconds === null || status.lagSeconds < 1) return blocks;
  return `${blocks} (${fmtDurationSeconds(status.lagSeconds)} of chain history)`;
}

function describeCatchUpSpeed(status: SyncStatus): string | null {
  const throughput = describeThroughput(status);
  if (status.speedupFactor === null) return throughput;
  const speed = `Scanning at ${fmtRate(status.speedupFactor)}x the chain's block rate`;
  const gain =
    status.netCatchUpBlocksPerSecond !== null
      ? `, closing the gap by ${fmtRate(status.netCatchUpBlocksPerSecond * 60)} blocks/min`
      : "";
  return `${speed}${gain}.${throughput ? ` ${throughput}` : ""}`;
}

/** "10.0 blocks/s scanned vs 0.5 blocks/s produced (2.0s block time)." */
export function describeThroughput(status: SyncStatus): string | null {
  if (status.scanBlocksPerSecond === null) return null;
  const chain =
    status.chainBlocksPerSecond !== null
      ? ` vs ${fmtRate(status.chainBlocksPerSecond)} blocks/s produced`
      : "";
  const blockTime =
    status.chainBlockTimeSeconds !== null
      ? ` (${fmtRate(status.chainBlockTimeSeconds)}s block time)`
      : "";
  return `${fmtRate(status.scanBlocksPerSecond)} blocks/s scanned${chain}${blockTime}.`;
}

/** Rates are small numbers; two decimals below 10, one above, none above 100. */
export function fmtRate(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return value.toFixed(0);
  if (magnitude >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function joinSentences(parts: Array<string | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
