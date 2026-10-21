import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExplorerEntity } from "./src/entityExplorer/lib/entity";
import { explorerClient as client } from "./src/entityExplorer/lib/client";
import { EntityResults, type EntityResultsProps } from "./src/entityExplorer/components/EntityResults";

const timing = await client.getBlockTiming();

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
  test("lists mixed schemas as rows with schema chips, never as attribute columns", async () => {
    const { entities } = await client.query("$expiresAt >= u64(0)", { select: "*", limit: 50 });
    const html = render(entities);
    expect(html).toContain("Schemas");
    expect(html).toContain("untagged");
    expect(html).toContain(">Attributes</th>");
    // One header per fixed column: key, schema, owner, attributes, expiry.
    expect(html.match(/<th /g)).toHaveLength(5);
    expect(html).not.toContain("Creation flags");
  });

  test("a single result starts expanded into the full entity", async () => {
    const { entities } = await client.query("arkiv.schema = str('arkiv-demo.posts')", { select: "*", limit: 1 });
    const html = render(entities);
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
