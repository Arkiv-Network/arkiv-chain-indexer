// The entity explorer's run: the query, page size and expiry filter as they
// stand in the URL (through nuqs), and the pages of entities the query matched
// (through TanStack Query), read with the SDK client.

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";
import { useMemo } from "react";
import { explorerClient } from "../lib/client";
import { EXPLORER_SELECT, type ExplorerEntity } from "../lib/entity";
import {
  DEFAULT_EXPIRATION_FILTER,
  DEFAULT_PAGE_SIZE,
  EXPIRATION_FILTERS,
  isExpiringSoon,
  MAX_QUERY_LIMIT,
  normalizeQueryInput,
  PAGE_SIZE_OPTIONS,
  type ExpirationFilter,
  type PageSize,
} from "../lib/query";

/** The run's settings, as they appear in a shareable `/entity-explorer` link. */
const urlParsers = {
  q: parseAsString.withDefault(""),
  pageSize: parseAsStringLiteral(PAGE_SIZE_OPTIONS).withDefault(DEFAULT_PAGE_SIZE),
  expiration: parseAsStringLiteral(EXPIRATION_FILTERS).withDefault(DEFAULT_EXPIRATION_FILTER),
};

const TIMING_KEY = ["block-timing"] as const;

interface ResultPage {
  entities: ExplorerEntity[];
  cursor: string | null;
  /** The block the page was read at; the next page must be read there too. */
  blockNumber: bigint;
  durationMs: number;
}

/** Resumes a query where its last page ended, at the block its first page was read at. */
type PageParam = { cursor: string; atBlock: bigint } | null;

/** The SDK takes no abort signal, so a cancelled run races its query against one. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) reject(new DOMException("Query cancelled", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("Query cancelled", "AbortError")), { once: true });
    promise.then(resolve, reject);
  });
}

export function useEntitySearch() {
  const client = useQueryClient();
  const [url, setUrl] = useQueryStates(urlParsers, { history: "push" });
  const { pageSize, expiration } = url;
  /** The query the results belong to; a bare key or address in a shared link reads as its query. */
  const executedQuery = normalizeQueryInput(url.q);
  const resultsKey = ["entity-query", executedQuery, pageSize] as const;

  const results = useInfiniteQuery({
    queryKey: resultsKey,
    enabled: executedQuery !== "",
    initialPageParam: null as PageParam,
    queryFn: async ({ pageParam, signal }): Promise<ResultPage> => {
      const started = performance.now();
      const page = await abortable(
        explorerClient.query(executedQuery, {
          select: EXPLORER_SELECT,
          limit: Math.min(Number(pageSize), MAX_QUERY_LIMIT),
          ...(pageParam ? { cursor: pageParam.cursor, atBlock: pageParam.atBlock } : {}),
        }),
        signal,
      );
      return {
        entities: page.entities,
        cursor: page.cursor ?? null,
        blockNumber: page.blockNumber,
        durationMs: Math.round(performance.now() - started),
      };
    },
    getNextPageParam: (last): PageParam | undefined => (last.cursor ? { cursor: last.cursor, atBlock: last.blockNumber } : undefined),
    // A page is read at a fixed block, so it never goes stale; running the query again reads the new head.
    staleTime: Infinity,
  });

  // Block timing turns heights into dates; a failure there is not a query failure.
  const timing =
    useQuery({
      queryKey: TIMING_KEY,
      queryFn: () => explorerClient.getBlockTiming(),
      enabled: executedQuery !== "",
      staleTime: 2_000,
    }).data ?? null;

  const pages = results.data?.pages ?? [];
  const entities = useMemo(() => (results.data?.pages ?? []).flatMap((page) => page.entities), [results.data]);
  const lastPage = pages.at(-1);
  const visibleEntities =
    expiration === "soon" ? (timing ? entities.filter((entity) => isExpiringSoon(entity.$expiresAt, timing, Date.now())) : []) : entities;

  /** Runs a query and records it in the URL, so the run can be shared or returned to. */
  const run = (text: string) => {
    const normalized = normalizeQueryInput(text);
    if (!normalized) return;
    void client.invalidateQueries({ queryKey: TIMING_KEY });
    if (normalized === executedQuery) {
      // Same query: the URL does not change, so read the head again explicitly.
      void client.resetQueries({ queryKey: resultsKey, exact: true });
      return;
    }
    void setUrl({ q: normalized });
  };

  const cancel = () => void client.cancelQueries({ queryKey: resultsKey, exact: true });

  const clear = () => {
    cancel();
    void setUrl({ q: null });
  };

  return {
    executedQuery,
    pageSize,
    expiration,
    setPageSize: (value: PageSize) => void setUrl({ pageSize: value }),
    setExpiration: (value: ExpirationFilter) => void setUrl({ expiration: value }),
    run,
    cancel,
    clear,
    loadMore: () => void results.fetchNextPage(),
    /** Every loaded entity, before the expiry filter. */
    entities,
    /** The loaded entities the expiry filter lets through. */
    visibleEntities,
    cursor: lastPage?.cursor ?? null,
    blockNumber: pages[0]?.blockNumber ?? null,
    durationMs: lastPage?.durationMs ?? null,
    timing,
    running: results.isFetchingNextPage ? ("more" as const) : results.isFetching ? ("first" as const) : null,
    // Cancelling a first page leaves the query with nothing to show and nothing in flight.
    cancelled: executedQuery !== "" && results.status === "pending" && results.fetchStatus === "idle",
    error: results.error,
  };
}
