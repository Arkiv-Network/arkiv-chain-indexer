import { ChevronRight } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-cell";
import { selectClass } from "@/components/filters-panel";
import { StatusBadge } from "@/components/op-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fetchHealth, type EntityQueryIndexHealth } from "./api";
import {
  appendQueryExpression,
  buildQueryParams,
  DATA_FILTER_KEYS,
  dataPageFilters,
  decodeQueryResult,
  EMPTY_DATA_FILTERS,
  EXAMPLE_QUERIES,
  EXPIRATION_FILTERS,
  isExpiringSoon,
  normalizeQueryInput,
  PAGE_SIZE_OPTIONS,
  parseQueryBlock,
  resolveExpirationFilter,
  resolvePageSize,
  type EntityRecord,
  type ExpirationFilter,
  type PageSize,
} from "./dataQuery";
import {
  ARKIV_READ_METHODS,
  BACKEND_INDEX_RPC_PATH,
  BACKEND_RPC_PATH,
  COMPARE_SOURCES,
  callRpc,
  checkRpcSource,
  describeRpcEndpoint,
  fetchBlockTiming,
  isAbortError,
  isValidRpcUrl,
  missingBackendMethods,
  permittedRpcMode,
  readStoredRpcMode,
  readStoredRpcSource,
  rpcModeFromLinkValue,
  rpcModeLinkValue,
  writeStoredRpcMode,
  writeStoredRpcSource,
  type BlockTiming,
  type RpcCheckReport,
  type RpcCheckStep,
  type RpcMode,
  type RpcSource,
  type RpcSourceKind,
} from "./dataRpc";
import {
  compareEntityPages,
  pickComparisonBlock,
  speedupFactor,
  type ComparisonReport,
  type ComparisonSide,
} from "./entityCompare";
import { EntityResults, QueryError } from "./EntityResults";
import { QueryHistoryDialog } from "./QueryHistoryDialog";
import { editQueryHistory, readQueryHistory, rememberQuery, writeQueryHistory, type QueryHistoryEntry } from "./queryHistory";
import { fmtDate, fmtInteger } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import {
  buildPermalinkHref,
  entityDetailHref,
  readFiltersFromSearch,
  shouldHandleClientNavigation,
  writeEntityPermalink,
  writePermalink,
} from "./permalinks";
import { AddressCell, copyText } from "./TransactionsView";
import type { MouseEvent } from "react";

const QueryEditor = lazy(() => import("./QueryEditor"));

const QUERY_PLACEHOLDER = "Paste an entity key, an owner address, or type a query such as status = str('active')";
const DOCS_URL = "https://docs.arkiv.network/start-here/data-explorer";

interface DataViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  /** Whether the node relay (`backend`, `both`) may be offered; without it the page is index-only. */
  adminModeActive: boolean;
  /** The current session's CSRF token, sent only to the application relay. */
  csrfToken: string | undefined;
}

type BackendForwarding =
  | { status: "loading" }
  | { status: "unknown"; error: string }
  | { status: "known"; methods: readonly string[] | false; entityQueryIndex: false | EntityQueryIndexHealth };

type CheckState =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; report: RpcCheckReport };

type CompareState = { status: "idle" } | { status: "running" } | { status: "done"; report: ComparisonReport };

interface ResultState {
  /** The query the results belong to, as sent to the node; null before the first run. */
  executedQuery: string | null;
  entities: EntityRecord[];
  cursor: string | null;
  blockNumber: number | null;
  timing: BlockTiming | null;
  durationMs: number | null;
  running: "first" | "more" | null;
  error: unknown | null;
}

/** The mode and endpoint a shared link names, or null when it has none (or junk). */
function modeFromUrl(rpc: string): { mode: RpcMode; source: RpcSource } | null {
  return rpcModeFromLinkValue(rpc);
}

const EMPTY_RESULTS: ResultState = {
  executedQuery: null,
  entities: [],
  cursor: null,
  blockNumber: null,
  timing: null,
  durationMs: null,
  running: null,
  error: null,
};

export function DataView({ locationSearch, onLocationChange, timeZone, adminModeActive, csrfToken }: DataViewProps) {
  const urlFilters = readFiltersFromSearch(locationSearch, DATA_FILTER_KEYS, EMPTY_DATA_FILTERS);

  // A link that names an endpoint wins over the remembered one, without overwriting it.
  const linkedSource = modeFromUrl(urlFilters.rpc);
  const [chosenSource, setSource] = useState<RpcSource>(() => linkedSource?.source ?? readStoredRpcSource());
  const [chosenMode, setMode] = useState<RpcMode>(() => linkedSource?.mode ?? readStoredRpcMode());
  // The relay is an admin surface: outside admin mode a remembered or linked
  // `backend`/`both` is used as `index`, and the choice itself is kept for
  // when admin mode comes back.
  const mode = permittedRpcMode(chosenMode, adminModeActive);
  const source: RpcSource = mode === "both" || mode === chosenSource.kind ? chosenSource : { ...chosenSource, kind: mode };
  const rpcDeps = { csrfToken };
  const [backend, setBackend] = useState<BackendForwarding>({ status: "loading" });
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [comparison, setComparison] = useState<CompareState>({ status: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

  const [query, setQuery] = useState(() => urlFilters.q);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [queryHistory, setQueryHistory] = useState(readQueryHistory);
  const historyRef = useRef(queryHistory);
  const [historyOpen, setHistoryOpen] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();
  const updateHistory = useCallback((change: (entries: QueryHistoryEntry[]) => QueryHistoryEntry[]) => {
    const next = change(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setQueryHistory(next);
    writeQueryHistory(next);
  }, []);
  const remember = useCallback((text: string) => updateHistory(entries => rememberQuery(entries, text)), [updateHistory]);

  useEffect(() => {
    draftTimer.current = setTimeout(() => remember(query), 800);
    return () => clearTimeout(draftTimer.current);
  }, [query, remember]);

  const [blockInput, setBlockInput] = useState(() => urlFilters.block);
  const [pageSize, setPageSize] = useState<PageSize>(() => resolvePageSize(urlFilters.pageSize));
  const [expiration, setExpiration] = useState<ExpirationFilter>(() => resolveExpirationFilter(urlFilters.expiration));
  const [results, setResults] = useState<ResultState>(EMPTY_RESULTS);
  const [countResult, setCountResult] = useState<{
    query: string;
    total: number | null;
    error: unknown | null;
    running: boolean;
  } | null>(null);
  const countAbortRef = useRef<AbortController | null>(null);
  const resetCount = useCallback(() => {
    countAbortRef.current?.abort();
    countAbortRef.current = null;
    setCountResult(null);
  }, []);
  useEffect(() => {
    resetCount();
    return () => countAbortRef.current?.abort();
  }, [query, mode, source.customUrl, blockInput, resetCount]);
  const abortRef = useRef<AbortController | null>(null);
  /** The `q` this component last put into, or read from, the URL; used to tell a back/forward navigation apart. */
  const urlQueryRef = useRef<string | null>(null);
  const urlBlockRef = useRef(urlFilters.block);

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((body) => {
        if (cancelled) return;
        setBackend({
          status: "known",
          methods: body.features.jsonRpcPassthrough ?? false,
          entityQueryIndex: body.features.entityQueryIndex ?? false,
        });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setBackend({ status: "unknown", error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const runQuery = useCallback(
    async (rawQuery: string, size: PageSize, continueFrom?: { cursor: string; atBlock: number }, via: RpcSource = source, requestedBlock?: number) => {
      if (via.kind === "backend" && !adminModeActive) via = { kind: "index", customUrl: "" };
      const normalized = normalizeQueryInput(rawQuery);
      if (!normalized) return;
      if (via.kind === "custom" && !isValidRpcUrl(via.customUrl)) {
        setFormError("Enter an absolute http(s) URL for the custom RPC endpoint, or switch back to the indexer backend.");
        return;
      }
      setFormError(null);
      resetCount();

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const more = continueFrom !== undefined;
      if (!more) setComparison({ status: "idle" });
      setResults((previous) =>
        more
          ? { ...previous, running: "more", error: null }
          : { ...EMPTY_RESULTS, executedQuery: normalized, running: "first" },
      );

      const started = performance.now();
      try {
        const params = buildQueryParams({
          query: normalized,
          pageSize: Number(size),
          atBlock: requestedBlock,
          ...(continueFrom ? { cursor: continueFrom.cursor, atBlock: continueFrom.atBlock } : {}),
        });
        const deps = { ...rpcDeps, signal: controller.signal };
        const [pageResult, timingResult] = await Promise.all([
          callRpc(via, "arkiv_query", params, deps),
          // Block timing turns heights into dates; a failure there is not a query failure.
          fetchBlockTiming(via, deps).catch(() => null),
        ]);
        if (controller.signal.aborted) return;
        const page = decodeQueryResult(pageResult);
        const durationMs = Math.round(performance.now() - started);
        setResults((previous) => ({
          executedQuery: normalized,
          entities: more ? [...previous.entities, ...page.entities] : page.entities,
          cursor: page.cursor,
          blockNumber: page.blockNumber,
          timing: timingResult ?? previous.timing,
          durationMs,
          running: null,
          error: null,
        }));
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          setResults((previous) => ({ ...previous, running: null }));
          return;
        }
        setResults((previous) => ({ ...previous, running: null, error }));
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [source, csrfToken, adminModeActive, resetCount],
  );

  /**
   * Sends the same query to the node's relay and to the experimental index and
   * reports where they part company. Both calls are pinned to the lower of the
   * two heads: the index runs a little behind the node, and an unpinned pair
   * would read as a wall of differences that is really just that lag. An index
   * far behind is not followed down (see {@link pickComparisonBlock}): the
   * node's head is used and the index side fails, which is the honest report.
   */
  const runComparison = useCallback(async (rawQuery: string, size: PageSize, requestedBlock?: number) => {
    if (!adminModeActive) return;
    const normalized = normalizeQueryInput(rawQuery);
    if (!normalized) return;
    setFormError(null);
    resetCount();

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setComparison({ status: "running" });
    setResults({ ...EMPTY_RESULTS, executedQuery: normalized, running: "first" });

    const [nodeSource, indexSource] = COMPARE_SOURCES;
    const deps = { ...rpcDeps, signal: controller.signal };
    /** A cancelled run takes its own spinner down, unless a newer run owns it now. */
    const cancelled = () => {
      if (abortRef.current !== null && abortRef.current !== controller) return;
      setResults((previous) => ({ ...previous, running: null }));
      setComparison({ status: "idle" });
    };
    try {
      const [nodeTiming, indexTiming] = await Promise.all([
        fetchBlockTiming(nodeSource, deps).catch(() => null),
        fetchBlockTiming(indexSource, deps).catch(() => null),
      ]);
      if (controller.signal.aborted) {
        cancelled();
        return;
      }
      const atBlock = requestedBlock ?? pickComparisonBlock(nodeTiming?.currentBlock, indexTiming?.currentBlock);
      const params = buildQueryParams({
        query: normalized,
        pageSize: Number(size),
        ...(atBlock === undefined ? {} : { atBlock }),
      });

      const call = async (via: RpcSource): Promise<ComparisonSide> => {
        const started = performance.now();
        try {
          const raw = await callRpc(via, "arkiv_query", params, deps);
          return { durationMs: Math.round(performance.now() - started), page: decodeQueryResult(raw), error: null };
        } catch (error) {
          return { durationMs: Math.round(performance.now() - started), page: null, error };
        }
      };
      const [nodeSide, indexSide] = await Promise.all([call(nodeSource), call(indexSource)]);
      if (controller.signal.aborted || isAbortError(nodeSide.error) || isAbortError(indexSide.error)) {
        cancelled();
        return;
      }

      setComparison({ status: "done", report: compareEntityPages(nodeSide, indexSide) });

      // The table shows the node's answer; when only the index answered, its own.
      const shown = nodeSide.page ?? indexSide.page;
      if (!shown) {
        setResults((previous) => ({ ...previous, running: null, error: nodeSide.error ?? indexSide.error }));
        return;
      }
      setResults({
        executedQuery: normalized,
        entities: shown.entities,
        cursor: shown.cursor,
        blockNumber: shown.blockNumber,
        timing: nodeTiming ?? indexTiming,
        durationMs: nodeSide.page ? nodeSide.durationMs : indexSide.durationMs,
        running: null,
        error: null,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        cancelled();
      } else {
        setResults((previous) => ({ ...previous, running: null, error }));
        setComparison({ status: "idle" });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [csrfToken, adminModeActive, resetCount]);

  const countQuery = async () => {
    const normalized = normalizeQueryInput(query);
    if (!normalized || mode !== "index") return;
    let block: number | undefined;
    try { block = parseQueryBlock(blockInput); }
    catch (error) { setFormError((error as Error).message); return; }
    remember(query);
    setFormError(null);
    urlQueryRef.current = normalized;
    urlBlockRef.current = block === undefined ? "" : String(block);
    if (writePermalink("data", dataPageFilters(normalized, pageSize, expiration, rpcModeLinkValue(mode, source), urlBlockRef.current))) onLocationChange();
    abortRef.current?.abort();
    resetCount();
    const controller = new AbortController();
    countAbortRef.current = controller;
    setResults(EMPTY_RESULTS);
    setComparison({ status: "idle" });
    setCountResult({ query: normalized, total: null, error: null, running: true });
    try {
      const total = await callRpc({ kind: "index", customUrl: "" }, "arkiv_getEntityCount", [{ query: normalized, ...(block === undefined ? {} : { block }) }], {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
        throw new Error("The endpoint returned an invalid entity count.");
      }
      setCountResult({ query: normalized, total, error: null, running: false });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setCountResult({ query: normalized, total: null, error, running: false });
    } finally {
      if (countAbortRef.current === controller) countAbortRef.current = null;
    }
  };

  /** Runs the editor's text and records it in the URL so the run can be shared or returned to. */
  const execute = useCallback(
    (text: string, size: PageSize = pageSize, filter: ExpirationFilter = expiration) => {
      const normalized = normalizeQueryInput(text);
      if (!normalized) return;
      let block: number | undefined;
      try { block = parseQueryBlock(blockInput); }
      catch (error) { setFormError((error as Error).message); return; }
      remember(queryRef.current);
      remember(normalized);
      setQuery(normalized);
      urlQueryRef.current = normalized;
      urlBlockRef.current = block === undefined ? "" : String(block);
      if (writePermalink("data", dataPageFilters(normalized, size, filter, rpcModeLinkValue(mode, source), urlBlockRef.current))) {
        onLocationChange();
      }
      if (mode === "both") void runComparison(normalized, size, block);
      else void runQuery(normalized, size, undefined, undefined, block);
    },
    [blockInput, expiration, mode, onLocationChange, pageSize, remember, runComparison, runQuery, source],
  );

  // A shared link, or back/forward, changes `q` under us: adopt it and run it.
  useEffect(() => {
    const fromUrl = urlFilters.q.trim();
    if (fromUrl === (urlQueryRef.current ?? "") && urlFilters.block === urlBlockRef.current) return;
    remember(queryRef.current);
    urlQueryRef.current = fromUrl;
    urlBlockRef.current = urlFilters.block;
    setBlockInput(urlFilters.block);
    resetCount();
    const size = resolvePageSize(urlFilters.pageSize);
    const filter = resolveExpirationFilter(urlFilters.expiration);
    setPageSize(size);
    setExpiration(filter);
    if (!fromUrl) {
      abortRef.current?.abort();
      setResults(EMPTY_RESULTS);
      return;
    }
    let block: number | undefined;
    try { block = parseQueryBlock(urlFilters.block); }
    catch (error) { setFormError((error as Error).message); return; }
    const normalized = normalizeQueryInput(fromUrl);
    remember(normalized);
    setQuery(normalized);
    const linked = modeFromUrl(urlFilters.rpc);
    if (linked) {
      setSource(linked.source);
      setMode(linked.mode);
    }
    const linkedMode = permittedRpcMode(linked?.mode ?? mode, adminModeActive);
    if (linkedMode === "both") void runComparison(normalized, size, block);
    else void runQuery(normalized, size, undefined, linked?.source ?? undefined, block);
    // `mode` is only read as the fallback for a link that names none; a mode
    // change on its own must not re-run the query behind the user's back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remember, resetCount, runComparison, runQuery, urlFilters.block, urlFilters.expiration, urlFilters.pageSize, urlFilters.q, urlFilters.rpc]);

  const cancel = () => {
    resetCount();
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const clear = () => {
    remember(query);
    cancel();
    setQuery("");
    urlQueryRef.current = "";
    urlBlockRef.current = "";
    setBlockInput("");
    setResults(EMPTY_RESULTS);
    setComparison({ status: "idle" });
    if (writePermalink("data", {})) onLocationChange();
  };

  const loadMore = () => {
    if (!results.executedQuery || !results.cursor || results.blockNumber === null) return;
    // A cursor belongs to the endpoint that issued it, so in compare mode the
    // later pages come from the side the table is showing: the node's.
    const via = mode === "both" ? COMPARE_SOURCES[0] : source;
    void runQuery(results.executedQuery, pageSize, { cursor: results.cursor, atBlock: results.blockNumber }, via);
  };

  const onPageSizeChange = (value: string) => {
    const size = resolvePageSize(value);
    setPageSize(size);
    if (results.executedQuery) execute(results.executedQuery, size, expiration);
  };

  const onExpirationChange = (value: string) => {
    const filter = resolveExpirationFilter(value);
    setExpiration(filter);
    if (results.executedQuery) {
      if (writePermalink("data", dataPageFilters(results.executedQuery, pageSize, filter, rpcModeLinkValue(mode, source), urlBlockRef.current))) {
        onLocationChange();
      }
    }
  };

  const queryOnly = (expression: string) => execute(expression);
  const addToQuery = (expression: string) => execute(appendQueryExpression(query, expression));

  const updateSource = (next: RpcSource) => {
    setSource(next);
    writeStoredRpcSource(next);
    setFormError(null);
  };

  const updateMode = (next: RpcMode) => {
    setMode(next);
    writeStoredRpcMode(next);
    setFormError(null);
    if (next !== "both") updateSource({ ...source, kind: next });
    // The old comparison describes endpoints the page is no longer using.
    setComparison({ status: "idle" });
  };

  const onKindChange = (kind: RpcSourceKind) => updateMode(kind);

  /** The one endpoint the connection check and the summary line talk about. */
  const checkSource: RpcSource = mode === "both" ? COMPARE_SOURCES[0] : source;

  const runCheck = async () => {
    if (checkSource.kind === "custom" && !isValidRpcUrl(checkSource.customUrl)) {
      setFormError("Enter an absolute http(s) URL for the custom RPC endpoint.");
      return;
    }
    setFormError(null);
    setCheck({ status: "running", startedAt: Date.now() });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const report = await checkRpcSource(checkSource, { ...rpcDeps, signal: controller.signal });
    if (!controller.signal.aborted) setCheck({ status: "done", report });
    if (abortRef.current === controller) abortRef.current = null;
  };

  /** True once `/health` has said this deployment serves no entity index. */
  const indexOff = backend.status === "known" && backend.entityQueryIndex === false;

  const missing = backend.status === "known" ? missingBackendMethods(backend.methods) : [];
  const nowMs = Date.now();
  const visibleEntities =
    expiration === "soon"
      ? results.timing
        ? results.entities.filter((entity) => isExpiringSoon(entity.expiresAt, results.timing as BlockTiming, nowMs))
        : []
      : results.entities;
  const hasText = query.trim().length > 0;
  const running = results.running !== null || countResult?.running === true;
  const permalink =
    results.executedQuery === null
      ? null
      : buildPermalinkHref("data", dataPageFilters(results.executedQuery, pageSize, expiration, rpcModeLinkValue(mode, source), urlBlockRef.current));

  const onFallbackKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      execute(event.currentTarget.value);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-6 px-3 md:px-6">
      <div className="flex flex-col gap-1.5">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "data", label: "Data" },
          ]}
          onLocationChange={onLocationChange}
        />
        <h2 className="font-heading text-lg font-black tracking-tight">Data</h2>
        <p className="page-caution" role="note">
          Experimental — use with caution
        </p>
      </div>

      <p className="max-w-3xl text-xs text-muted-foreground">
        Query entity state from the indexer&apos;s experimental entity index, or from any node you name; in admin mode
        the deployment&apos;s own node relay is available too, so the two can be compared.{" "}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          Query language docs
        </a>
        .
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">Query against</span>
        <Tabs value={mode} onValueChange={(value) => updateMode(value as RpcMode)}>
          <TabsList aria-label="RPC source">
            {adminModeActive ? <TabsTrigger value="backend" title={BACKEND_RPC_PATH}>
              Default node
            </TabsTrigger> : null}
            <TabsTrigger value="index" title={BACKEND_INDEX_RPC_PATH}>
              Experimental index
            </TabsTrigger>
            {adminModeActive ? <TabsTrigger value="both">Both (compare)</TabsTrigger> : null}
            {mode === "custom" || source.customUrl.trim() ? (
              <TabsTrigger value="custom" title={describeRpcEndpoint({ kind: "custom", customUrl: source.customUrl })}>
                Custom
              </TabsTrigger>
            ) : null}
          </TabsList>
        </Tabs>
        <span className="font-mono text-xs text-muted-foreground">
          {mode === "both" ? `${BACKEND_RPC_PATH} vs ${BACKEND_INDEX_RPC_PATH}` : describeRpcEndpoint(source) || "not set"}
        </span>
      </div>
      {indexOff && (mode === "index" || mode === "both") ? (
        <p className="border border-amber-600/30 bg-amber-600/10 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
          This deployment has switched off the entity index (<span className="font-mono">ENTITY_QUERY_INDEX=false</span>), so{" "}
          <span className="font-mono">{BACKEND_INDEX_RPC_PATH}</span> answers 404.
        </p>
      ) : null}

      <Card className="gap-3 p-4">
        <Suspense
          fallback={
            <div className="overflow-hidden rounded-md border border-input bg-muted">
              <textarea
                className="w-full resize-y bg-transparent px-3 py-2 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
                value={query}
                placeholder={QUERY_PLACEHOLDER}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onFallbackKeyDown}
                rows={2}
              />
            </div>
          }
        >
          <QueryEditor value={query} onChange={setQuery} onExecute={(text) => execute(text)} placeholder={QUERY_PLACEHOLDER} />
        </Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <span className="mr-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
            Press
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">Ctrl</kbd>+
            <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80">Enter</kbd>
            to run the query
          </span>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            At block
            <input
              type="text"
              aria-label="At block"
              placeholder="Latest"
              value={blockInput}
              disabled={running}
              onChange={(event) => { setBlockInput(event.target.value); setFormError(null); }}
              className="w-40 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Page size
            <select value={pageSize} onChange={(event) => onPageSizeChange(event.target.value)} disabled={running} className={selectClass}>
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Show
            <select value={expiration} onChange={(event) => onExpirationChange(event.target.value)} className={selectClass}>
              {EXPIRATION_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All entities" : "Expiring within 24h"}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" onClick={clear} disabled={!hasText && results.executedQuery === null && countResult === null}>
            Clear
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => {
            clearTimeout(draftTimer.current);
            remember(query);
            setHistoryOpen(true);
          }}>
            History{queryHistory.length > 0 ? ` (${queryHistory.length})` : ""}
          </Button>
          {permalink ? <CopyLinkButton href={permalink} /> : null}
          <button
            type="button"
            className="secondary"
            onClick={() => void countQuery()}
            disabled={!hasText || running || mode !== "index" || indexOff}
            title={mode === "index" ? "Count all matches, regardless of page size or the Show filter" : "Select Experimental index to count query matches"}
          >
            Count query
          </button>
          {running ? (
            <Button type="button" variant="destructive" size="sm" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => execute(query)} disabled={!hasText}>
              Run query
            </Button>
          )}
        </div>
        {backend.status === "known" && backend.entityQueryIndex && (mode === "index" || mode === "both") ? (
          <p className="text-xs text-muted-foreground">Available index blocks: {backend.entityQueryIndex.floorBlock}–{backend.entityQueryIndex.projectedThroughBlock}. Leave At block blank for latest.</p>
        ) : null}
        {formError ? <p className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{formError}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Copy example</span>
          {EXAMPLE_QUERIES.map((example) => (
            <CopyQueryHint key={example.label} label={example.label} query={example.query} />
          ))}
        </div>
      </Card>

      {historyOpen ? <QueryHistoryDialog
        entries={queryHistory}
        timeZone={timeZone}
        onClose={() => setHistoryOpen(false)}
        onEdit={(id, text) => updateHistory(entries => editQueryHistory(entries, id, text))}
        onDelete={id => updateHistory(entries => entries.filter(entry => entry.id !== id))}
        onLoad={text => {
          remember(query);
          cancel();
          setQuery(text);
          setFormError(null);
          setHistoryOpen(false);
        }}
      /> : null}

      {comparison.status === "running" ? (
        <p className="text-xs text-muted-foreground">Running the query on both endpoints…</p>
      ) : comparison.status === "done" ? (
        <ComparisonPanel report={comparison.report} />
      ) : null}

      {countResult ? (
        <div className="query-results">
          {countResult.error !== null ? <QueryError error={countResult.error} query={countResult.query} /> : (
            <p className="summary query-status" role="status">
              {countResult.running ? "Counting matching entities…" : `${fmtInteger(countResult.total)} matching entities at ${blockInput.trim() && blockInput.trim().toLowerCase() !== "latest" ? `block ${blockInput.trim()}` : "latest"}`}
              {!countResult.running && expiration === "soon" ? " (before the Show filter)" : ""}
            </p>
          )}
        </div>
      ) : <EntityResults
        executedQuery={results.executedQuery}
        entities={visibleEntities}
        loadedCount={results.entities.length}
        cursor={results.cursor}
        blockNumber={results.blockNumber}
        timing={results.timing}
        durationMs={results.durationMs}
        running={results.running}
        error={results.error}
        expirationFilter={expiration}
        timeZone={timeZone}
        onLoadMore={loadMore}
        onQueryOnly={queryOnly}
        onAddToQuery={addToQuery}
        onLocationChange={onLocationChange}
      />}

      <details className="group border border-border bg-card">
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-4 py-2.5 text-xs font-medium text-foreground [&::-webkit-details-marker]:hidden [&::marker]:content-none">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="text-muted-foreground">RPC endpoint</span>
          <span className="min-w-0 flex-1 truncate font-mono text-foreground">
            {mode === "both" ? `${BACKEND_RPC_PATH} vs ${BACKEND_INDEX_RPC_PATH}` : describeRpcEndpoint(source) || "not set"}
          </span>
          {mode === "backend" && backend.status === "known" ? (
            <StatusBadge tone={backend.methods !== false && missing.length === 0 ? "ok" : "fail"}>
              {backend.methods === false ? "No upstream" : missing.length === 0 ? "Forwarding" : "Incomplete"}
            </StatusBadge>
          ) : null}
          {mode === "index" || mode === "both" ? (
            <StatusBadge tone={backend.status !== "known" ? "unknown" : backend.entityQueryIndex === false ? "fail" : "ok"}>
              {backend.status !== "known" ? "Experimental" : backend.entityQueryIndex === false ? "Not enabled" : "Experimental"}
            </StatusBadge>
          ) : null}
          {check.status === "done" ? (
            <StatusBadge tone={check.report.ok ? "ok" : check.report.arkivOk ? "unknown" : "fail"}>
              {check.report.ok ? "Checked OK" : check.report.arkivOk ? "Arkiv reads OK" : "Check failed"}
            </StatusBadge>
          ) : null}
        </summary>

        <div className="flex flex-col gap-4 border-t border-border p-4">
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-foreground">RPC endpoint</h3>
              <div className="flex flex-col gap-2" role="radiogroup" aria-label="RPC endpoint">
                {adminModeActive ? <RpcSourceOption checked={mode === "backend"} onChange={() => onKindChange("backend")} title="Indexer backend">
                  <span>
                    <span className="font-mono">{BACKEND_RPC_PATH}</span> forwards the entity reads to the node it is
                    configured with, using the deployment&apos;s own API key.
                  </span>
                  <BackendForwardingNote backend={backend} missing={missing} />
                </RpcSourceOption> : null}

                <RpcSourceOption
                  checked={mode === "index"}
                  onChange={() => onKindChange("index")}
                  title="Indexer entity index"
                  badge={<StatusBadge tone="unknown">experimental</StatusBadge>}
                >
                  <span>
                    <span className="font-mono">{BACKEND_INDEX_RPC_PATH}</span> answers the entity reads from the
                    indexer&apos;s own projection of the decoded operations, without asking a node. Same query
                    language and wire format, so its answers can be checked against the backend&apos;s. Payloads are
                    never available, entities created before the index floor are unknown, and{" "}
                    <span className="font-mono">latest</span> means the projected head.
                  </span>
                  <IndexStatusNote backend={backend} />
                </RpcSourceOption>

                <RpcSourceOption checked={mode === "custom"} onChange={() => onKindChange("custom")} title="Custom RPC URL">
                  <span>
                    Called straight from the browser, so the node must allow cross-origin requests. A key in the URL
                    stays in this browser&apos;s local storage only.
                  </span>
                  <input
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="https://rpc.example.arkiv.network/<api-key>"
                    value={source.customUrl}
                    disabled={mode !== "custom"}
                    onChange={(event) => updateSource({ ...source, customUrl: event.target.value })}
                    className={cn(selectClass, "w-full font-mono")}
                  />
                </RpcSourceOption>

                {adminModeActive ? <RpcSourceOption checked={mode === "both"} onChange={() => updateMode("both")} title="Both, compared">
                  <span>
                    Sends each query to <span className="font-mono">{BACKEND_RPC_PATH}</span> and{" "}
                    <span className="font-mono">{BACKEND_INDEX_RPC_PATH}</span> at once, both pinned to the lower of
                    the two heads so the index&apos;s lag does not read as a difference, and reports the timings side
                    by side with every field the two answers disagree on. The table below shows the node&apos;s
                    answer.
                  </span>
                  <IndexStatusNote backend={backend} />
                </RpcSourceOption> : null}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-foreground">Connection check</h3>
              <p className="text-xs text-muted-foreground">
                Calls <span className="font-mono">eth_chainId</span>, <span className="font-mono">web3_clientVersion</span>, and
                the three Arkiv reads ({ARKIV_READ_METHODS.join(", ")}) against the selected endpoint. Nothing is
                written.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" onClick={runCheck} disabled={check.status === "running"}>
                  {check.status === "running" ? "Checking…" : "Check connection"}
                </Button>
                {check.status === "done" ? (
                  <StatusBadge tone={check.report.ok ? "ok" : check.report.arkivOk ? "unknown" : "fail"}>
                    {check.report.ok ? "All methods answered" : check.report.arkivOk ? "Arkiv reads OK" : "Not usable"}
                  </StatusBadge>
                ) : null}
              </div>
            </div>
          </div>

          {check.status === "done" ? <CheckReport report={check.report} timeZone={timeZone} onLocationChange={onLocationChange} /> : null}
        </div>
      </details>
    </section>
  );
}

/** One radio option in the RPC endpoint picker: a title, a description, and an optional status note. */
function RpcSourceOption({
  checked,
  onChange,
  title,
  badge,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer gap-3 border p-3 transition-colors",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
      )}
    >
      <input type="radio" name="rpc-source" checked={checked} onChange={onChange} className="mt-0.5 accent-primary" />
      <span className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground">
          {title}
          {badge}
        </span>
        <span className="flex flex-col gap-1.5 text-xs text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

/**
 * The verdict of a "Both" run: what each endpoint cost, and every field the two
 * answers disagree on. It covers the first page only — cursors are not
 * interchangeable between the node and the index, so "Load more" reads on from
 * the node alone.
 */
function ComparisonPanel({ report }: { report: ComparisonReport }) {
  const speedup = speedupFactor(report);
  const verdict = report.identical
    ? { tone: "ok" as const, text: `Identical (${report.comparedEntities} entities compared)` }
    : { tone: "fail" as const, text: `${report.differences.length} difference${report.differences.length === 1 ? "" : "s"}` };

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-heading text-sm">Node vs experimental index</h3>
        <StatusBadge tone={verdict.tone}>{verdict.text}</StatusBadge>
        {speedup !== null ? (
          <span className="text-xs text-muted-foreground">
            index {speedup >= 1 ? `${speedup.toFixed(1)}× faster` : `${(1 / speedup).toFixed(1)}× slower`}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <ComparisonSideRow label="Default node" path={BACKEND_RPC_PATH} side={report.node} />
        <ComparisonSideRow label="Experimental index" path={BACKEND_INDEX_RPC_PATH} side={report.index} />
      </div>

      {report.identical ? (
        <p className="text-xs text-muted-foreground">
          Same entities, same order, same fields on the first page. Later pages are not compared: a cursor belongs to
          the endpoint that issued it.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 border-t border-border pt-3">
          {report.differences.map((difference, position) => (
            <li key={`${difference.scope}-${position}`} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{difference.scope}</span>
              <span className="text-foreground">{difference.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ComparisonSideRow({
  label,
  path,
  side,
}: {
  label: string;
  path: string;
  side: ComparisonReport["node"];
}) {
  return (
    <div className="flex flex-col gap-0.5 border border-border bg-muted/30 px-3 py-2">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{path}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{fmtInteger(side.durationMs)} ms</span>
      <span className="text-xs text-foreground">
        {side.error !== null
          ? "failed"
          : `${fmtInteger(side.count ?? 0)} ${side.count === 1 ? "entity" : "entities"}${side.hasMore ? ", more" : ""}`}
      </span>
      {side.blockNumber !== null ? (
        <span className="font-mono text-[11px] text-muted-foreground">block {fmtInteger(side.blockNumber)}</span>
      ) : null}
      {side.error !== null ? <span className="text-xs text-destructive">{side.error}</span> : null}
    </div>
  );
}

function IndexStatusNote({ backend }: { backend: BackendForwarding }) {
  if (backend.status === "loading") {
    return <span className="block text-xs text-muted-foreground">Reading the backend&apos;s entity index status…</span>;
  }
  if (backend.status === "unknown") {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        Could not read <span className="font-mono">/api/health</span>: {backend.error}
      </span>
    );
  }
  const index = backend.entityQueryIndex;
  if (index === false) {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        This deployment has switched off the entity index (<span className="font-mono">ENTITY_QUERY_INDEX=false</span>), so
        this endpoint answers 404.
      </span>
    );
  }
  const genesis = index.genesis;
  if (genesis?.status === "running") {
    return (
      <span className="rpc-source-option-status warn">
        Importing genesis entities: {genesis.imported.toLocaleString("en-US")} /{" "}
        {genesis.total.toLocaleString("en-US")}
        {genesis.phase === "repair"
          ? " are in; refolding the ones with later operations"
          : genesis.source === "dump"
            ? " (offline import from the seed's state dump)"
            : " (from the node)"}
        . Results are incomplete until the import is done.
      </span>
    );
  }
  if (genesis?.status === "waiting") {
    return (
      <span className="rpc-source-option-status warn">
        {genesis.total.toLocaleString("en-US")} genesis entities are waiting for the offline import
        (<span className="mono">scripts/importGenesisState.ts</span>); until then entities created before
        block {index.floorBlock ?? "?"} are not indexed.
      </span>
    );
  }
  if (genesis?.status === "failed") {
    return (
      <span className="rpc-source-option-status warn">
        The genesis import failed: {genesis.error ?? "no reason recorded"}. Entities created before block{" "}
        {index.floorBlock ?? "?"} are not indexed.
      </span>
    );
  }
  if (index.projectedThroughBlock === null) {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        Enabled, but the projector has not folded a block yet
        {index.floorBlock ? ` (starting at block ${index.floorBlock})` : ""}.
      </span>
    );
  }
  const lag = index.lagBlocks === null ? "" : `, ${index.lagBlocks} blocks behind the scanner`;
  const live = index.liveEntities === null ? "" : `; ${index.liveEntities.toLocaleString("en-US")} live entities`;
  const coverage =
    genesis?.status === "done" && index.floorBlock === "0"
      ? `Every entity is indexed, including the ${genesis.total.toLocaleString("en-US")} from the genesis state.`
      : genesis?.status === "unavailable"
        ? `Entities created before block ${index.floorBlock ?? "?"} are not indexed, and the node could not say whether the genesis state holds any.`
        : `Entities created before block ${index.floorBlock ?? "?"} are not indexed.`;
  return (
    <span className="block text-xs text-emerald-700 dark:text-emerald-400">
      Projected through block {index.projectedThroughBlock}
      {lag}
      {live}. {coverage}
    </span>
  );
}

function BackendForwardingNote({ backend, missing }: { backend: BackendForwarding; missing: string[] }) {
  if (backend.status === "loading") {
    return <span className="block text-xs text-muted-foreground">Reading the backend&apos;s forwarded methods…</span>;
  }
  if (backend.status === "unknown") {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        Could not read <span className="font-mono">/api/health</span>: {backend.error}
      </span>
    );
  }
  if (backend.methods === false) {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        The backend has no upstream node configured (<span className="font-mono">SHADOW_RPC_UPSTREAM</span> is
        unset), so it cannot forward entity reads.
      </span>
    );
  }
  if (missing.length > 0) {
    return (
      <span className="block text-xs text-amber-700 dark:text-amber-400">
        The backend forwards {backend.methods.length === 0 ? "no methods" : backend.methods.join(", ")}, but not{" "}
        {missing.join(", ")}. Add them to <span className="font-mono">SHADOW_RPC_UPSTREAM_METHODS</span>.
      </span>
    );
  }
  return <span className="block text-xs text-emerald-700 dark:text-emerald-400">Forwards all three entity read methods.</span>;
}

function CheckReport({
  report,
  timeZone,
  onLocationChange,
}: {
  report: RpcCheckReport;
  timeZone: string;
  onLocationChange: () => void;
}) {
  const totalMs = report.steps.reduce((sum, step) => sum + step.durationMs, 0);
  const headTime = report.timing ? new Date(report.timing.currentBlockTime * 1000).toISOString() : null;

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={report.ok ? "ok" : report.arkivOk ? "unknown" : "fail"}>
          {report.ok ? "OK" : report.arkivOk ? "Partial" : "Failed"}
        </StatusBadge>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={report.endpoint}>
          {report.endpoint}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {fmtDate(report.startedAtUtc, timeZone)} · {report.steps.length} calls · {fmtInteger(totalMs)} ms
        </span>
      </div>

      <div className="grid gap-6 border-t border-border pt-4 sm:grid-cols-3">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Node</h3>
          <dl className="flex flex-col gap-2">
            <Row label="Chain id" value={report.chainId === null ? "—" : fmtInteger(report.chainId)} />
            <Row label="Client" value={report.clientVersion ?? "—"} />
            <Row label="Head block" value={report.timing ? fmtInteger(report.timing.currentBlock) : "—"} />
            <Row label="Head time" value={headTime ? fmtDate(headTime, timeZone) : "—"} />
            <Row label="Block time" value={report.timing ? `${report.timing.blockDurationSeconds}s` : "—"} />
          </dl>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Entities</h3>
          <dl className="flex flex-col gap-2">
            <Row label="Live entities" value={report.entityCount === null ? "—" : fmtInteger(report.entityCount)} />
            <div className="flex flex-col gap-0.5">
              <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Sample key</dt>
              <dd className="text-xs text-foreground">
                {report.sampleEntityKey ? (
                  <span className="flex items-center gap-1.5">
                    <SampleEntityLink entityKey={report.sampleEntityKey} onLocationChange={onLocationChange} />
                    <CopyButton value={report.sampleEntityKey} label="entity key" />
                  </span>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Sample owner</dt>
              <dd className="text-xs text-foreground">
                {report.sampleEntityOwner ? <AddressCell address={report.sampleEntityOwner} /> : "—"}
              </dd>
            </div>
          </dl>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">Verdict</h3>
          <p className="text-xs text-muted-foreground">
            {report.ok
              ? "Every call answered. The Data page can use this endpoint."
              : report.arkivOk
                ? "The Arkiv entity reads answered, so entity queries will work; a plain Ethereum method failed, see below."
                : "At least one Arkiv read method failed. Entity queries will not work through this endpoint until it does."}
          </p>
        </section>
      </div>

      <div className="border-t border-border pt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Method</TableHead>
              <TableHead>Checks that</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.steps.map((step) => (
              <StepRow key={step.method} step={step} />
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function StepRow({ step }: { step: RpcCheckStep }) {
  return (
    <TableRow className={step.status === "fail" ? "bg-destructive/5" : undefined}>
      <TableCell className="font-mono">{step.method}</TableCell>
      <TableCell className="max-w-2xs text-wrap text-muted-foreground">{step.purpose}</TableCell>
      <TableCell>
        <StatusBadge tone={step.status === "ok" ? "ok" : "fail"}>
          {step.status === "ok" ? "OK" : step.code !== undefined ? `Error ${step.code}` : "Failed"}
        </StatusBadge>
      </TableCell>
      <TableCell className="text-right font-mono">{fmtInteger(step.durationMs)} ms</TableCell>
      <TableCell className="max-w-2xs truncate text-muted-foreground" title={step.summary}>
        {step.summary}
      </TableCell>
    </TableRow>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="text-xs text-foreground">{value}</dd>
    </div>
  );
}

function CopyQueryHint({ label, query }: { label: string; query: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [status]);
  return (
    <button type="button" className="query-example" title={`Copy query: ${query}`} aria-label={`Copy example: ${label}`}
      onClick={async () => setStatus(await copyText(query) ? "copied" : "failed")}>
      {label}<span className="query-copy-feedback" role="status">{status === "copied" ? " · Copied" : status === "failed" ? " · Could not copy" : ""}</span>
    </button>
  );
}

/** Copies the permalink of the last run: the query, its page size and filter, and a custom endpoint if one is in use. */
function CopyLinkButton({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      // Clipboard unavailable (e.g. insecure context): the address bar already holds the same link.
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={onCopy} title={href}>
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

function SampleEntityLink({ entityKey, onLocationChange }: { entityKey: string; onLocationChange: () => void }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writeEntityPermalink(entityKey)) onLocationChange();
  };
  return (
    <a
      className="truncate font-mono text-xs text-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 transition-colors hover:text-accent-foreground hover:decoration-accent-foreground"
      href={entityDetailHref(entityKey)}
      onClick={onClick}
      title="Open the indexed history"
    >
      {entityKey}
    </a>
  );
}
