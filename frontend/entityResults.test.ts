import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityResults } from "./src/EntityResults";
import { decodeEntity, type EntityRecord } from "./src/dataQuery";
import type { BlockTiming } from "./src/dataRpc";

const timing: BlockTiming = {
  currentBlock: 100,
  currentBlockTime: 1_700_000_000,
  blockDurationSeconds: 2,
};
const centuryBlocks = (100 * 365 * 24 * 60 * 60) / timing.blockDurationSeconds;

function renderEntity(expiresAt: string | number | null, blockTiming: BlockTiming | null = timing, createdAt = 0): string {
  const entity: EntityRecord = decodeEntity({ key: `0x${"ab".repeat(32)}`, createdAt, expiresAt });
  return renderToStaticMarkup(createElement(EntityResults, {
    executedQuery: "*",
    entities: [entity],
    loadedCount: 1,
    cursor: null,
    blockNumber: 100,
    timing: blockTiming,
    durationMs: 1,
    running: null,
    error: null,
    expirationFilter: "all",
    timeZone: "UTC",
    onLoadMore: () => {},
    onQueryOnly: () => {},
    onAddToQuery: () => {},
    onLocationChange: () => {},
  }));
}

describe("entity expiry display", () => {
  test("renders uint64-max expiry without constructing an out-of-range date", () => {
    const html = renderEntity("0xffffffffffffffff");
    expect(html).toContain("Permanent");
    expect(html).not.toContain("% left");
  });

  test("uses total lifetime and hides the countdown above 100 years", () => {
    const html = renderEntity(centuryBlocks + 1);
    expect(html).toContain("Permanent");
    expect(html).not.toContain("% left");
  });

  test("keeps expiry dates and progress at exactly 100 years or less", () => {
    for (const expiresAt of [200, centuryBlocks - 1, centuryBlocks]) {
      const html = renderEntity(expiresAt);
      expect(html).not.toContain("Permanent");
      expect(html).toContain("% left");
    }
  });

  test("subtracts the creation block instead of treating expiry as a duration", () => {
    const html = renderEntity(centuryBlocks + 200, { ...timing, currentBlock: centuryBlocks + 100 }, centuryBlocks);
    expect(html).not.toContain("Permanent");
    expect(html).toContain("% left");
  });

  test("handles missing timing and expiry without inventing a lifetime", () => {
    expect(renderEntity(centuryBlocks + 1, null)).not.toContain("Permanent");
    expect(renderEntity(null)).not.toContain("Permanent");
    expect(renderEntity("0xffffffffffffffff", null)).toContain("Permanent");
  });
});
