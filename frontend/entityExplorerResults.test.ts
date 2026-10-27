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

  test("says a cancelled query was cancelled rather than empty", () => {
    const html = render([], { cancelled: true });
    expect(html).toContain("Query cancelled");
    expect(html).not.toContain("No entities matched");
  });

  test("offers the way back after following an entity reference", () => {
    expect(render([], { previousQuery: "arkiv.schema = str('a')" })).toContain("Back to previous query");
  });
});
