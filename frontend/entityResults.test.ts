import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityResults } from "./src/EntityResults";
import { decodeEntity } from "./src/dataQuery";
import type { BlockTiming } from "./src/dataRpc";

const timing: BlockTiming = {
  currentBlock: 100,
  currentBlockTime: 1_700_000_000,
  blockDurationSeconds: 2,
};
const centuryBlocks = (100 * 365 * 24 * 60 * 60) / timing.blockDurationSeconds;

function renderEntity(raw: Record<string, unknown>, blockTiming: BlockTiming | null = timing): string {
  const entity = decodeEntity({ key: `0x${"ab".repeat(32)}`, ...raw });
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
  test("2^64 − 1 is Permanent ∞, with no lifetime bar or date", () => {
    const html = renderEntity({ createdAt: "0x0", expiresAt: "0xffffffffffffffff" });
    expect(html).toContain("Permanent ∞");
    expect(html).not.toContain("% left");
  });

  test("a finite expiry keeps its date and progress however far away it is", () => {
    for (const expiresAt of [200, centuryBlocks - 1, centuryBlocks, centuryBlocks + 1, centuryBlocks * 10]) {
      const html = renderEntity({ createdAt: "0x0", expiresAt: `0x${expiresAt.toString(16)}` });
      expect(html).not.toContain("Permanent");
      expect(html).toContain("% left");
    }
  });

  test("permanence does not depend on block timing", () => {
    expect(renderEntity({ expiresAt: "0xffffffffffffffff" }, null)).toContain("Permanent ∞");
    expect(renderEntity({ expiresAt: `0x${(centuryBlocks + 1).toString(16)}` }, null)).not.toContain("Permanent");
    expect(renderEntity({ expiresAt: null })).not.toContain("Permanent");
  });
});

describe("entity attributes", () => {
  const raw = {
    owner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    expiresAt: "0x3e8",
    attributeSchema: [
      { name: "arkiv.schema", type: "str", indexed: true },
      { name: "body", type: "bytes", indexed: false },
      { name: "note", type: "str", indexed: false },
      { name: "title", type: "str", indexed: true },
    ],
    attributes: [
      { name: "arkiv.schema", type: "str", value: "posts" },
      { name: "body", type: "bytes", value: null },
      { name: "note", type: "str", value: "stored" },
      { name: "title", type: "str", value: "hello" },
    ],
  };

  test("the schema is a header badge, not a row", () => {
    const html = renderEntity(raw);
    expect(html).toContain("schema: posts");
    expect(html).toContain("Query arkiv.schema = str(&#x27;posts&#x27;)");
    expect(html).toContain("Attributes (3)");
  });

  test("indexed and stored attributes are badged; only indexed ones can be queried", () => {
    const html = renderEntity(raw);
    expect(html).toContain('aria-label="Query by title"');
    expect(html).not.toContain('aria-label="Query by note"');
    expect(html).not.toContain('aria-label="Query by body"');
    expect(html).toContain(">stored<");
    expect(html).toContain(">indexed<");
  });

  test("there is no content type, and the owner renders EIP-55", () => {
    const html = renderEntity(raw);
    expect(html).not.toContain("Content type");
    expect(html).toContain("0x7E5F4552…");
  });

  test("bytes the index withheld show as withheld", () => {
    expect(renderEntity(raw)).toContain("bytes (size withheld)");
  });
});
