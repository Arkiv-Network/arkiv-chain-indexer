import type { BlocksResponse, StoredBlock } from "./api";
import { DEFAULT_PAGE_SETTINGS, type PageSettings } from "./pageSettings";

export const HOME_LATEST_BLOCK_LIMIT = 20;
export const HOME_BLOCK_RETENTION_BUFFER = 60;

const MINUTE_MS = 60_000;

export function homeFetchBlockLimit(settings: PageSettings): number {
  const blockTimeMs =
    settings.blockTimeMs > 0 ? settings.blockTimeMs : DEFAULT_PAGE_SETTINGS.blockTimeMs;
  const windowMs = Math.max(0, settings.histogramWindowMinutes) * MINUTE_MS;
  return Math.max(HOME_LATEST_BLOCK_LIMIT, Math.ceil(windowMs / blockTimeMs));
}

export function homeRetainedBlockLimit(settings: PageSettings): number {
  return homeFetchBlockLimit(settings) + HOME_BLOCK_RETENTION_BUFFER;
}

export function recentHomeBlocksParams(settings: PageSettings): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", String(homeFetchBlockLimit(settings)));
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
    limit: Math.max(response.limit, homeRetainedBlockLimit(settings)),
    truncated: response.truncated || blocks.length >= response.limit,
    blocks,
  };
}

export function pruneHomeBlocks(blocks: StoredBlock[], settings: PageSettings): StoredBlock[] {
  const currentMinuteMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const firstMinuteMs =
    currentMinuteMs - Math.max(0, settings.histogramWindowMinutes - 1) * MINUTE_MS;
  const retainedLimit = homeRetainedBlockLimit(settings);
  const seen = new Set<number>();
  const pruned: StoredBlock[] = [];

  for (const block of blocks.slice().sort((a, b) => b.blockNumber - a.blockNumber)) {
    if (seen.has(block.blockNumber)) continue;
    seen.add(block.blockNumber);

    const ts = Date.parse(block.blockDate);
    const keepForFeed = pruned.length < HOME_LATEST_BLOCK_LIMIT;
    const keepForHistogram = Number.isFinite(ts) && ts >= firstMinuteMs;
    if (keepForFeed || keepForHistogram) pruned.push(block);
    if (pruned.length >= retainedLimit) break;
  }

  return pruned;
}
