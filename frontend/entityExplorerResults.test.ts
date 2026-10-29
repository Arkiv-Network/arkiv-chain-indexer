import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SCHEMA_ATTRIBUTE, bytes, str, u64 } from "@arkiv-network/sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Hex } from "viem";
import type { ExplorerEntity } from "./src/entityExplorer/lib/entity";
import type { BlockTiming } from "./src/entityExplorer/lib/client";
import { EntityResults, type EntityResultsProps } from "./src/entityExplorer/components/EntityResults";

// Fixed rows rather than a node: `bun test` must not need an RPC endpoint.
const timing: BlockTiming = { currentBlock: 1_000n, currentBlockTime: 1_790_000_000, blockDuration: 2 };
const OWNER = "0x44a22acf16f0a1e958e0b28135d7e27067909b3f" as Hex;

function entity(index: number, schemaName: string | undefined, attributes: ExplorerEntity["$attributes"]): ExplorerEntity {
  const all = schemaName === undefined ? attributes : { ...attributes, [SCHEMA_ATTRIBUTE]: str(schemaName) };
  return {
    $key: `0x${index.toString(16).padStart(64, "0")}` as Hex,
    $owner: OWNER,
    $creator: OWNER,
    $createdAt: 900n + BigInt(index),
    $updatedAt: 900n + BigInt(index),
    $expiresAt: 5_000n,
    $creationFlags: { readonly: false, permissionlessExtension: false, raw: 0 },
    $attributes: all,
    $attributeSchema: Object.fromEntries(
      Object.entries(all).map(([name, value]) => [name, { type: value.type, indexed: value.type !== "bytes" }]),
    ),
  };
}

const POST = entity(1, "posts", { title: str("Hello"), views: u64(3), body: bytes("0x68656c6c6f") });
const DEVICE = entity(2, "devices", { device: str("warsaw-1"), lastSeen: u64(1_790_000_000) });
const UNTAGGED = entity(3, undefined, { purpose: str("permanent_test") });

function render(entities: ExplorerEntity[], overrides: Partial<EntityResultsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(EntityResults, {
        executedQuery: "$expiresAt >= u64(0)",
        entities,
        loadedCount: entities.length,
        cursor: null,
        blockNumber: timing.currentBlock,
        timing,
        durationMs: 1,
        running: null,
        cancelled: false,
        error: null,
        expirationFilter: "all",
        timeZone: "UTC",
        entityHref: (key) => `/entity-explorer?q=${key}`,
        previousQuery: null,
        onBack: () => {},
        onLoadMore: () => {},
        onQueryOnly: () => {},
        onAddToQuery: () => {},
        onOpenEntity: () => {},
        ...overrides,
      }),
    ),
  );
}

describe("EntityResults", () => {
  test("lists mixed schemas as rows with schema chips, never as attribute columns", () => {
    const html = render([POST, DEVICE, UNTAGGED]);
    expect(html).toContain("Schemas");
    expect(html).toContain("untagged");
    expect(html).toContain(">Attributes</th>");
    // One header per fixed column: key, schema, owner, attributes, expiry.
    expect(html.match(/<th /g)).toHaveLength(5);
    expect(html).not.toContain("Creation flags");
  });

  test("a single result starts expanded into the full entity", () => {
    const html = render([POST]);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Lifetime");
    expect(html).toContain("Copy link");
  });

  test("links an entity to its indexed history only where the deployment has one", () => {
    const withHistory = render([POST], { historyHref: (key) => `/entity/${key}` });
    expect(withHistory).toContain(`href="/entity/${POST.$key}"`);
    expect(withHistory).toContain(">History</a>");
    // Without transaction data there is no entity page to send the reader to.
    expect(render([POST])).not.toContain(">History</a>");
  });

  test("says a cancelled query was cancelled rather than empty", () => {
    const html = render([], { cancelled: true });
    expect(html).toContain("Query cancelled");
    expect(html).not.toContain("No entities matched");
  });

  test("offers the way back after following an entity reference", () => {
    expect(render([], { previousQuery: "arkiv.schema = str('a')" })).toContain("Back to previous query");
  });
});

describe("str values with control characters", () => {
  test("result rows show them as escapes on one line, never raw", () => {
    // As the SDK decodes them from the node (strFromChain): its str() refuses
    // control characters, but the node stores and matches them.
    const chainStr = (value: string) => ({ type: "str", value }) as ReturnType<typeof str>;
    const html = render([entity(4, undefined, { note: chainStr("line one\n\tline two"), nul: chainStr("nul\u0000inside") })]);
    expect(html).toContain('title="U+000A line feed">\\n</span><span');
    expect(html).toContain('title="U+0000 NUL">\\0</span>inside');
    expect(html).not.toContain("\u0000");
    // Not in the expanded detail either: a \n is shown, never followed.
    expect(html).not.toContain("\n");
  });

  test("a value with anything to escape copies both as itself and escaped", async () => {
    const { attributePopup } = await import("./src/entityExplorer/components/FilterPopup");
    const at = { clientX: 0, clientY: 0 };
    // popupAt places the menu inside the window; there is none under bun test.
    const scope = globalThis as { window?: unknown };
    const saved = scope.window;
    scope.window = { innerWidth: 1024 };
    const value = (text: string) => ({ type: "str", value: text }) as ReturnType<typeof str>;
    try {
      expect(attributePopup(at, { name: "nul", value: value("nul\u0000inside"), indexed: true })).toMatchObject({
        copyValue: "nul\u0000inside",
        copyEscapedValue: "nul\\0inside",
        // The query keeps the real character: the node matches it.
        expression: "nul = str('nul\u0000inside')",
      });
      expect(attributePopup(at, { name: "note", value: value("line one\n\tline two"), indexed: true })).toMatchObject({
        copyValue: "line one\n\tline two",
        copyEscapedValue: "line one\\n\\tline two",
      });
      const plain = attributePopup(at, { name: "title", value: value("Hello"), indexed: true });
      expect(plain.copyValue).toBe("Hello");
      expect(plain.copyEscapedValue).toBeUndefined();
    } finally {
      scope.window = saved;
    }
  });
});
