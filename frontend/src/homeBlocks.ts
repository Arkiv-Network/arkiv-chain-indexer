import type { BlocksResponse, StoredBlock } from "./api";
import type { PageSettings } from "./pageSettings";

export const HOME_LATEST_BLOCK_LIMIT = 10;

const MINUTE_MS = 60_000;

export interface HomeMinAvgMaxPoint {
  ts: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

export function homeHistogramMinuteRange(
  currentMinuteMs: number,
  settings: Pick<PageSettings, "histogramWindowMinutes">,
): { minMs: number; maxMs: number } {
  const windowMinutes = Math.max(1, settings.histogramWindowMinutes);
  return {
    minMs: currentMinuteMs - (windowMinutes - 1) * MINUTE_MS,
    maxMs: currentMinuteMs,
  };
}

export function homeRecentWindowStartMs(
  nowMs: number,
  settings: Pick<PageSettings, "histogramWindowMinutes">,
): number {
  const windowMinutes = Math.max(1, settings.histogramWindowMinutes);
  return nowMs - windowMinutes * MINUTE_MS;
}

export function recentHomeBlocksParams(
  settings: PageSettings,
  nowMs = Date.now(),
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("dateGt", new Date(homeRecentWindowStartMs(nowMs, settings)).toISOString());
  params.set("order", "desc");
  return params;
}

export function buildHomeMinAvgMaxSeries(
  blocks: StoredBlock[],
  currentMinuteMs: number,
  settings: Pick<PageSettings, "histogramWindowMinutes">,
  extractValue: (block: StoredBlock) => number | null,
): HomeMinAvgMaxPoint[] {
  const { minMs } = homeHistogramMinuteRange(currentMinuteMs, settings);
  const windowMinutes = Math.max(1, settings.histogramWindowMinutes);

  interface MinuteAgg {
    total: number;
    count: number;
    min: number;
    max: number;
  }

  const sums = new Map<number, MinuteAgg>();
  for (let i = 0; i < windowMinutes; i++) {
    sums.set(minMs + i * MINUTE_MS, {
      total: 0,
      count: 0,
      min: Infinity,
      max: -Infinity,
    });
  }

  for (const block of blocks) {
    const ts = Date.parse(block.blockDate);
    if (!Number.isFinite(ts)) continue;
    const minute = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    const bucket = sums.get(minute);
    if (!bucket) continue;
    const value = extractValue(block);
    if (value === null || !Number.isFinite(value)) continue;
    bucket.total += value;
    bucket.count += 1;
    if (value < bucket.min) bucket.min = value;
    if (value > bucket.max) bucket.max = value;
  }

  return Array.from(sums.entries())
    .map(([minuteMs, { total, count, min, max }]) => ({
      ts: minuteMs,
      avg: count > 0 ? total / count : null,
      min: count > 0 ? min : null,
      max: count > 0 ? max : null,
    }))
    .sort((a, b) => a.ts - b.ts);
}

export function normalizeHomeBlocksResponse(
  response: BlocksResponse,
  settings: PageSettings,
): BlocksResponse {
  const blocks = pruneHomeBlocks(response.blocks, settings);
  return {
    ...response,
    count: blocks.length,
    truncated: response.truncated,
    blocks,
  };
}

export function pruneHomeBlocks(
  blocks: StoredBlock[],
  settings: PageSettings,
  nowMs = Date.now(),
): StoredBlock[] {
  const windowStartMs = homeRecentWindowStartMs(nowMs, settings);
  const seen = new Set<number>();
  const pruned: StoredBlock[] = [];

  for (const block of blocks.slice().sort((a, b) => b.blockNumber - a.blockNumber)) {
    if (seen.has(block.blockNumber)) continue;
    seen.add(block.blockNumber);

    const ts = Date.parse(block.blockDate);
    if (Number.isFinite(ts) && ts > windowStartMs) pruned.push(block);
  }

  return pruned;
}
