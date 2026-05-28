import type { BlocksResponse, StoredBlock } from "./api";
import type { PageSettings } from "./pageSettings";

export const HOME_LATEST_BLOCK_LIMIT = 10;

const MINUTE_MS = 60_000;

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
