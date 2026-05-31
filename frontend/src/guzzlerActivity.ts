/**
 * Pure helpers for the single-guzzler activity view (the `/guzzler/:address`
 * endpoint). The backend returns one chart-ready point per *populated* minute
 * over the retention window (24h); gaps are simply missing minutes. These
 * functions slice that series to a chosen window, roll it up into headline
 * stats, and shape it for plotting — all kept free of React/Plotly so they can
 * be unit-tested in isolation.
 */
import type { GuzzlerHistoryPoint } from "./api";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WEI_PER_TOKEN = 1_000_000_000_000_000_000n; // 1e18
/** Fixed-point scale used when converting wei to a plain JS number of tokens. */
const TOKEN_PRECISION = 1_000_000n; // 1e6 — six decimals of the native token

/** Stable identifier for an activity-view time window (used in the permalink). */
export type GuzzlerActivityWindowKey = "1h" | "6h" | "24h";

/** A selectable time span for the chart's x-axis. `ms === null` fits the data. */
export interface GuzzlerActivityWindow {
  key: GuzzlerActivityWindowKey;
  label: string;
  /** Span in milliseconds, or null to auto-fit to whatever data exists. */
  ms: number | null;
}

/**
 * Window tabs, smallest first. Each pins the x-axis to the last N relative to
 * now, up to the 24h retention horizon.
 */
export const GUZZLER_ACTIVITY_WINDOWS: readonly GuzzlerActivityWindow[] = [
  { key: "1h", label: "1 hour", ms: HOUR_MS },
  { key: "6h", label: "6 hours", ms: 6 * HOUR_MS },
  { key: "24h", label: "24 hours", ms: 24 * HOUR_MS },
];

/** Which per-minute measure the chart plots. */
export type GuzzlerActivityMetricKey = "transactions" | "gas" | "fees";

export interface GuzzlerActivityMetric {
  key: GuzzlerActivityMetricKey;
  label: string;
  /** Y-axis title; `{token}` is replaced with the native token symbol. */
  axisTitle: string;
}

export const GUZZLER_ACTIVITY_METRICS: readonly GuzzlerActivityMetric[] = [
  { key: "transactions", label: "Transactions", axisTitle: "Transactions / min" },
  { key: "gas", label: "Gas used", axisTitle: "Gas used (millions) / min" },
  { key: "fees", label: "Fees", axisTitle: "Fees ({token}) / min" },
];

/** Headline figures for a (windowed) slice of a guzzler's history. */
export interface GuzzlerActivitySummary {
  /** Number of minutes with at least one transaction. */
  activeMinutes: number;
  totalTransactions: number;
  /** Decimal-string bigints to avoid precision loss on large gas/fee sums. */
  totalGasUsed: string;
  totalFeeWei: string;
  /** Highest transaction count seen in a single minute. */
  peakTransactions: number;
  /** Start time (ISO) of the minute that hit {@link peakTransactions}, if any. */
  peakMinuteStart: string | null;
  /** Earliest transaction timestamp (ISO) across the slice, if any. */
  firstSeen: string | null;
  /** Latest transaction timestamp (ISO) across the slice, if any. */
  lastSeen: string | null;
}

function toBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

/** Convert a wei amount to a plain number of native tokens (6-decimal scale). */
export function weiToTokenNumber(weiStr: string | null | undefined): number {
  const wei = toBigInt(weiStr);
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const scaled = (abs * TOKEN_PRECISION) / WEI_PER_TOKEN;
  const result = Number(scaled) / Number(TOKEN_PRECISION);
  return negative ? -result : result;
}

/**
 * Keep only the points whose minute bucket overlaps `[nowMs - windowMs, nowMs]`.
 * A null `windowMs` returns the points unchanged (the "All" window).
 */
export function filterPointsByWindow(
  points: readonly GuzzlerHistoryPoint[],
  nowMs: number,
  windowMs: number | null,
): GuzzlerHistoryPoint[] {
  if (windowMs === null) {
    return [...points];
  }
  const cutoff = nowMs - windowMs;
  // A bucket for `minute` covers [minute*60000, minute*60000 + 60000); keep it
  // while any part of that span is still inside the window.
  return points.filter((point) => point.minute * MINUTE_MS + MINUTE_MS > cutoff);
}

/** The per-minute y-values for a metric, in the points' existing order. */
export function metricSeries(
  points: readonly GuzzlerHistoryPoint[],
  metric: GuzzlerActivityMetricKey,
): number[] {
  switch (metric) {
    case "transactions":
      return points.map((point) => point.transactionCount);
    case "gas":
      return points.map((point) => Number(toBigInt(point.totalGasUsed)));
    case "fees":
      return points.map((point) => weiToTokenNumber(point.totalFeeWei));
  }
}

/** Roll a slice of points up into the headline figures shown above the chart. */
export function summarizeGuzzlerHistory(
  points: readonly GuzzlerHistoryPoint[],
): GuzzlerActivitySummary {
  let totalTransactions = 0;
  let totalGas = 0n;
  let totalFee = 0n;
  let peakTransactions = 0;
  let peakMinuteStart: string | null = null;
  let firstSeenMs = Number.POSITIVE_INFINITY;
  let lastSeenMs = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    totalTransactions += point.transactionCount;
    totalGas += toBigInt(point.totalGasUsed);
    totalFee += toBigInt(point.totalFeeWei);
    if (point.transactionCount > peakTransactions) {
      peakTransactions = point.transactionCount;
      peakMinuteStart = point.startTime;
    }
    const first = Date.parse(point.firstSeen);
    if (Number.isFinite(first) && first < firstSeenMs) firstSeenMs = first;
    const last = Date.parse(point.lastSeen);
    if (Number.isFinite(last) && last > lastSeenMs) lastSeenMs = last;
  }

  return {
    activeMinutes: points.length,
    totalTransactions,
    totalGasUsed: totalGas.toString(),
    totalFeeWei: totalFee.toString(),
    peakTransactions,
    peakMinuteStart,
    firstSeen: Number.isFinite(firstSeenMs) ? new Date(firstSeenMs).toISOString() : null,
    lastSeen: Number.isFinite(lastSeenMs) ? new Date(lastSeenMs).toISOString() : null,
  };
}

/**
 * The x-axis range for a window: a fixed `[now - windowMs, now]` span, or
 * `undefined` for the "All" window so Plotly auto-fits to the data.
 */
export function activityPlotRange(
  nowMs: number,
  windowMs: number | null,
): [string, string] | undefined {
  if (windowMs === null) {
    return undefined;
  }
  return [new Date(nowMs - windowMs).toISOString(), new Date(nowMs).toISOString()];
}

/**
 * Map a leaderboard window span onto the activity view's coarser windows so a
 * drill-in keeps a comparable time selection: anything up to an hour collapses
 * to "1h", up to six hours to "6h", and the rest to the 24h horizon.
 */
export function activityWindowForMs(ms: number): GuzzlerActivityWindowKey {
  if (ms <= HOUR_MS) return "1h";
  if (ms <= 6 * HOUR_MS) return "6h";
  return "24h";
}

/** A valid activity window key (e.g. from the permalink), or null. */
export function normalizeActivityWindowKey(
  value: string | null | undefined,
): GuzzlerActivityWindowKey | null {
  return GUZZLER_ACTIVITY_WINDOWS.some((window) => window.key === value)
    ? (value as GuzzlerActivityWindowKey)
    : null;
}

/** Whether a string is a syntactically valid 0x-prefixed 20-byte address. */
export function isAddressLike(value: string | null | undefined): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/** Lowercase a valid address, or null if it isn't one. */
export function normalizeAddressInput(value: string | null | undefined): string | null {
  if (!isAddressLike(value)) {
    return null;
  }
  return value!.trim().toLowerCase();
}
