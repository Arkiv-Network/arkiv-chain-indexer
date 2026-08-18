/**
 * Scanner sync status: how far the indexer is behind the chain head, whether it
 * is catching up or losing ground, and when it is expected to be caught up.
 *
 * The maths live here (pure functions, no database) so they can be unit-tested
 * without Postgres. {@link ScannerStorage.getForwardScanSamples} supplies the
 * raw samples and {@link handleGetSyncStatus} serves the result.
 */

/** One stored block, used to measure how fast the scanner walks forward. */
export interface ScanSample {
  blockNumber: bigint;
  /** Chain timestamp of the block (ISO 8601). */
  blockDate: string;
  /** When the scanner stored the block (ISO 8601, UTC). */
  scannedAtUtc: string;
}

export interface SyncStatusInput {
  now: Date;
  lastSuccessfulBlock?: bigint;
  lastSuccessfulBlockDate?: string;
  lastSuccessfulScannedAt?: string;
  latestObservedBlock?: bigint;
  latestObservedAt?: string;
  safeHeadBlock?: bigint;
  /** Recent stored blocks, ascending by block number (chain tip last). */
  samples: readonly ScanSample[];
  /** Lag at or below which the scanner counts as synced. Defaults to 5 blocks. */
  syncedLagBlocks?: number;
  /** No forward progress for this long counts as stalled. Defaults to 120s. */
  stallSeconds?: number;
}

export type SyncState =
  /** At (or within a couple of blocks of) the chain head. */
  | "synced"
  /** Behind, but closing the gap — `etaSeconds` says when it lands. */
  | "catching-up"
  /** Behind and losing ground; the gap is growing. */
  | "falling-behind"
  /** Behind but keeping pace: the gap is neither closing nor growing. */
  | "holding"
  /** Behind and not moving at all. */
  | "stalled"
  /** Not enough data yet (fresh database, no head observation). */
  | "unknown";

export interface SyncStatus {
  state: SyncState;
  /** One-line human summary, also usable from curl/monitoring. */
  summary: string;
  /** Last block the forward scanner stored. */
  lastSuccessfulBlock: string | null;
  /** Chain timestamp of that block. */
  lastSuccessfulBlockDate: string | null;
  /** Chain head as last observed by the scanner (may be stale — see below). */
  latestObservedBlock: string | null;
  latestObservedAtUtc: string | null;
  /** Age of that head observation, in seconds. */
  headObservationAgeSeconds: number | null;
  /** True when the head observation is too old to trust on its own. */
  headObservationStale: boolean;
  /** Head extrapolated to now from the last observation and the block time. */
  estimatedHeadBlock: string | null;
  /** Lag against the last observed head (never negative). */
  observedLagBlocks: string | null;
  /** Lag against the extrapolated head — the number to show the user. */
  lagBlocks: string | null;
  /** How far behind in wall-clock time: now minus the last stored block's timestamp. */
  lagSeconds: number | null;
  /** Measured chain block time over the sampled window. */
  chainBlockTimeSeconds: number | null;
  /** Blocks per second the chain produces. */
  chainBlocksPerSecond: number | null;
  /** Blocks per second the scanner stores. */
  scanBlocksPerSecond: number | null;
  /** Scanner speed relative to the chain: >1 means the gap closes. */
  speedupFactor: number | null;
  /** Net gap closure in blocks per second (negative means falling behind). */
  netCatchUpBlocksPerSecond: number | null;
  /** Seconds until the lag reaches zero at the current net rate, when catching up. */
  etaSeconds: number | null;
  /** Absolute UTC timestamp for {@link etaSeconds}. */
  etaUtc: string | null;
  /** Wall-clock seconds spanned by the samples used for the rate measurement. */
  measuredWindowSeconds: number | null;
  /** Blocks advanced over that window. */
  measuredBlocks: number | null;
}

const DEFAULT_SYNCED_LAG_BLOCKS = 5;
const DEFAULT_STALL_SECONDS = 120;
/** Rate differences below this are noise, not a trend. */
const RATE_EPSILON_BLOCKS_PER_SECOND = 1e-4;
/** Head observations older than this are extrapolated but flagged. */
const HEAD_OBSERVATION_STALE_SECONDS = 60;

export function computeSyncStatus(input: SyncStatusInput): SyncStatus {
  const syncedLagBlocks = BigInt(input.syncedLagBlocks ?? DEFAULT_SYNCED_LAG_BLOCKS);
  const stallSeconds = input.stallSeconds ?? DEFAULT_STALL_SECONDS;
  const nowMs = input.now.getTime();
  // Storage omits unknown progress fields, but tolerate explicit nulls too.
  const lastSuccessfulBlock = input.lastSuccessfulBlock ?? undefined;
  const lastSuccessfulBlockDate = input.lastSuccessfulBlockDate ?? undefined;
  const lastSuccessfulScannedAt = input.lastSuccessfulScannedAt ?? undefined;
  const latestObservedBlock = input.latestObservedBlock ?? undefined;
  const latestObservedAt = input.latestObservedAt ?? undefined;

  const rates = measureRates(input.samples ?? [], lastSuccessfulBlock, nowMs);
  const headObservationAgeSeconds = secondsSince(nowMs, latestObservedAt);
  const headObservationStale =
    headObservationAgeSeconds !== null && headObservationAgeSeconds > HEAD_OBSERVATION_STALE_SECONDS;

  // The scanner only refreshes the head once per scan loop, so during a long
  // catch-up the stored observation ages badly. Extrapolate it with the
  // measured block time so the reported lag reflects the chain as it is now.
  const estimatedHeadBlock =
    latestObservedBlock !== undefined &&
    headObservationAgeSeconds !== null &&
    rates.chainBlockTimeSeconds !== null &&
    rates.chainBlockTimeSeconds > 0
      ? latestObservedBlock +
        BigInt(Math.max(0, Math.floor(headObservationAgeSeconds / rates.chainBlockTimeSeconds)))
      : latestObservedBlock;

  const observedLagBlocks =
    latestObservedBlock !== undefined && lastSuccessfulBlock !== undefined
      ? clampToZero(latestObservedBlock - lastSuccessfulBlock)
      : null;
  const lagBlocks =
    estimatedHeadBlock !== undefined && lastSuccessfulBlock !== undefined
      ? clampToZero(estimatedHeadBlock - lastSuccessfulBlock)
      : null;

  const lagSeconds = secondsSince(nowMs, lastSuccessfulBlockDate);
  const scanAgeSeconds = secondsSince(nowMs, lastSuccessfulScannedAt);

  const netCatchUpBlocksPerSecond =
    rates.scanBlocksPerSecond !== null && rates.chainBlocksPerSecond !== null
      ? rates.scanBlocksPerSecond - rates.chainBlocksPerSecond
      : null;
  const speedupFactor =
    rates.scanBlocksPerSecond !== null &&
    rates.chainBlocksPerSecond !== null &&
    rates.chainBlocksPerSecond > 0
      ? rates.scanBlocksPerSecond / rates.chainBlocksPerSecond
      : null;

  const state = decideState({
    lagBlocks,
    syncedLagBlocks,
    scanAgeSeconds,
    stallSeconds,
    scanBlocksPerSecond: rates.scanBlocksPerSecond,
    netCatchUpBlocksPerSecond,
  });

  const etaSeconds =
    state === "catching-up" &&
    lagBlocks !== null &&
    netCatchUpBlocksPerSecond !== null &&
    netCatchUpBlocksPerSecond > 0
      ? Number(lagBlocks) / netCatchUpBlocksPerSecond
      : null;

  const status: SyncStatus = {
    state,
    summary: "",
    lastSuccessfulBlock: lastSuccessfulBlock?.toString() ?? null,
    lastSuccessfulBlockDate: lastSuccessfulBlockDate ?? null,
    latestObservedBlock: latestObservedBlock?.toString() ?? null,
    latestObservedAtUtc: latestObservedAt ?? null,
    headObservationAgeSeconds,
    headObservationStale,
    estimatedHeadBlock: estimatedHeadBlock?.toString() ?? null,
    observedLagBlocks: observedLagBlocks?.toString() ?? null,
    lagBlocks: lagBlocks?.toString() ?? null,
    lagSeconds,
    chainBlockTimeSeconds: rates.chainBlockTimeSeconds,
    chainBlocksPerSecond: rates.chainBlocksPerSecond,
    scanBlocksPerSecond: rates.scanBlocksPerSecond,
    speedupFactor,
    netCatchUpBlocksPerSecond,
    etaSeconds,
    etaUtc: etaSeconds === null ? null : new Date(nowMs + etaSeconds * 1000).toISOString(),
    measuredWindowSeconds: rates.measuredWindowSeconds,
    measuredBlocks: rates.measuredBlocks,
  };
  status.summary = summarize(status);
  return status;
}

interface MeasuredRates {
  scanBlocksPerSecond: number | null;
  chainBlocksPerSecond: number | null;
  chainBlockTimeSeconds: number | null;
  measuredWindowSeconds: number | null;
  measuredBlocks: number | null;
}

const EMPTY_RATES: MeasuredRates = {
  scanBlocksPerSecond: null,
  chainBlocksPerSecond: null,
  chainBlockTimeSeconds: null,
  measuredWindowSeconds: null,
  measuredBlocks: null,
};

/**
 * Measure the forward scan rate and the chain's block time from recently
 * stored blocks.
 *
 * Only the run of blocks at the tip whose store times increase with the block
 * number counts: the backfill scanner writes blocks in descending order, and
 * mixing those into the window would invent progress the forward scanner never
 * made. The window runs to `nowMs` when given, so an idle scanner's rate decays
 * instead of freezing at its last burst speed.
 */
export function measureRates(
  samples: readonly ScanSample[],
  lastSuccessfulBlock: bigint | undefined,
  nowMs?: number,
): MeasuredRates {
  const forward = samples.filter(
    (sample) => lastSuccessfulBlock === undefined || sample.blockNumber <= lastSuccessfulBlock,
  );
  const tip = forward[forward.length - 1];
  if (!tip) return EMPTY_RATES;

  const tipScannedMs = parseMs(tip.scannedAtUtc);
  const tipBlockMs = parseMs(tip.blockDate);
  if (tipScannedMs === null || tipBlockMs === null) return EMPTY_RATES;

  let start = tip;
  let startScannedMs = tipScannedMs;
  let startBlockMs = tipBlockMs;
  for (let index = forward.length - 2; index >= 0; index -= 1) {
    const sample = forward[index]!;
    const scannedMs = parseMs(sample.scannedAtUtc);
    const blockMs = parseMs(sample.blockDate);
    // Stop at the first block stored no earlier than the one above it: that is
    // a backfilled block, not part of the forward run.
    if (scannedMs === null || blockMs === null || scannedMs > startScannedMs) break;
    start = sample;
    startScannedMs = scannedMs;
    startBlockMs = blockMs;
  }

  const measuredBlocks = Number(tip.blockNumber - start.blockNumber);
  // Measure up to now, not up to the last stored block: a scanner that has
  // stopped should show a decaying rate rather than the speed it once had.
  const windowEndMs = Math.max(tipScannedMs, nowMs ?? tipScannedMs);
  const measuredWindowSeconds = (windowEndMs - startScannedMs) / 1000;
  if (measuredBlocks <= 0 || measuredWindowSeconds <= 0) {
    return { ...EMPTY_RATES, measuredBlocks, measuredWindowSeconds };
  }

  const scanBlocksPerSecond = measuredBlocks / measuredWindowSeconds;
  const chainSpanSeconds = (tipBlockMs - startBlockMs) / 1000;
  const chainBlockTimeSeconds = chainSpanSeconds > 0 ? chainSpanSeconds / measuredBlocks : null;

  return {
    scanBlocksPerSecond,
    chainBlockTimeSeconds,
    chainBlocksPerSecond: chainBlockTimeSeconds === null ? null : 1 / chainBlockTimeSeconds,
    measuredWindowSeconds,
    measuredBlocks,
  };
}

function decideState(args: {
  lagBlocks: bigint | null;
  syncedLagBlocks: bigint;
  scanAgeSeconds: number | null;
  stallSeconds: number;
  scanBlocksPerSecond: number | null;
  netCatchUpBlocksPerSecond: number | null;
}): SyncState {
  if (args.lagBlocks === null) return "unknown";
  if (args.lagBlocks <= args.syncedLagBlocks) return "synced";
  if (args.scanAgeSeconds !== null && args.scanAgeSeconds > args.stallSeconds) return "stalled";
  if (args.scanBlocksPerSecond === null) return "unknown";
  if (args.netCatchUpBlocksPerSecond === null) return "unknown";
  if (args.netCatchUpBlocksPerSecond > RATE_EPSILON_BLOCKS_PER_SECOND) return "catching-up";
  if (args.netCatchUpBlocksPerSecond < -RATE_EPSILON_BLOCKS_PER_SECOND) return "falling-behind";
  return "holding";
}

function summarize(status: SyncStatus): string {
  const behind =
    status.lagBlocks === null
      ? "unknown lag"
      : `${status.lagBlocks} block${status.lagBlocks === "1" ? "" : "s"}` +
        (status.lagSeconds !== null ? ` (${formatDuration(status.lagSeconds)})` : "");

  switch (status.state) {
    case "synced":
      return `Scanner is at the chain head (${behind} behind)`;
    case "catching-up":
      return (
        `Scanner is ${behind} behind and catching up` +
        (status.speedupFactor !== null ? ` at ${status.speedupFactor.toFixed(2)}x chain speed` : "") +
        (status.etaSeconds !== null ? `; synced in ~${formatDuration(status.etaSeconds)}` : "")
      );
    case "falling-behind":
      return (
        `Scanner is ${behind} behind and falling further behind` +
        (status.netCatchUpBlocksPerSecond !== null
          ? ` by ${Math.abs(status.netCatchUpBlocksPerSecond * 60).toFixed(1)} blocks/min`
          : "")
      );
    case "holding":
      return `Scanner is ${behind} behind and holding that gap`;
    case "stalled":
      return `Scanner is ${behind} behind and has stopped making progress`;
    case "unknown":
      return "Scanner sync status is not known yet";
  }
}

/** Compact duration used in the API summary string ("2h 5m", "45s"). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function clampToZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function secondsSince(nowMs: number, iso: string | undefined): number | null {
  const parsed = parseMs(iso);
  if (parsed === null) return null;
  return Math.max(0, (nowMs - parsed) / 1000);
}
