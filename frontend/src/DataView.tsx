import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { fetchHealth } from "./api";
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
  resolveExpirationFilter,
  resolvePageSize,
  type EntityRecord,
  type ExpirationFilter,
  type PageSize,
} from "./dataQuery";
import {
  ARKIV_READ_METHODS,
  BACKEND_RPC_PATH,
  callRpc,
  checkRpcSource,
  describeRpcEndpoint,
  fetchBlockTiming,
  isAbortError,
  isValidRpcUrl,
  missingBackendMethods,
  readStoredRpcSource,
  writeStoredRpcSource,
  type BlockTiming,
  type RpcCheckReport,
  type RpcCheckStep,
  type RpcSource,
  type RpcSourceKind,
} from "./dataRpc";
import { EntityResults } from "./EntityResults";
import { fmtDate, fmtInteger } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import {
  entityDetailHref,
  readFiltersFromSearch,
  shouldHandleClientNavigation,
  writeEntityPermalink,
  writePermalink,
} from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { CopyButton } from "./TransactionView";
import type { MouseEvent } from "react";

const QueryEditor = lazy(() => import("./QueryEditor"));

const QUERY_PLACEHOLDER = "Paste an entity key, an owner address, or type a query such as status = str('active')";
const DOCS_URL = "https://docs.arkiv.network/start-here/data-explorer";

interface DataViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
}

type BackendForwarding =
  | { status: "loading" }
  | { status: "unknown"; error: string }
  | { status: "known"; methods: readonly string[] | false };

type CheckState =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "done"; report: RpcCheckReport };

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

export function DataView({ locationSearch, onLocationChange, timeZone }: DataViewProps) {
  const urlFilters = readFiltersFromSearch(locationSearch, DATA_FILTER_KEYS, EMPTY_DATA_FILTERS);

  const [source, setSource] = useState<RpcSource>(() => readStoredRpcSource());
  const [backend, setBackend] = useState<BackendForwarding>({ status: "loading" });
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

  const [query, setQuery] = useState(() => urlFilters.q);
  const [pageSize, setPageSize] = useState<PageSize>(() => resolvePageSize(urlFilters.pageSize));
  const [expiration, setExpiration] = useState<ExpirationFilter>(() => resolveExpirationFilter(urlFilters.expiration));
  const [results, setResults] = useState<ResultState>(EMPTY_RESULTS);
  const abortRef = useRef<AbortController | null>(null);
  /** The `q` this component last put into, or read from, the URL; used to tell a back/forward navigation apart. */
  const urlQueryRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((body) => {
        if (cancelled) return;
        setBackend({ status: "known", methods: body.features.jsonRpcPassthrough ?? false });
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
    async (rawQuery: string, size: PageSize, continueFrom?: { cursor: string; atBlock: number }) => {
      const normalized = normalizeQueryInput(rawQuery);
      if (!normalized) return;
      if (source.kind === "custom" && !isValidRpcUrl(source.customUrl)) {
        setFormError("Enter an absolute http(s) URL for the custom RPC endpoint, or switch back to the indexer backend.");
        return;
      }
      setFormError(null);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const more = continueFrom !== undefined;
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
          ...(continueFrom ? { cursor: continueFrom.cursor, atBlock: continueFrom.atBlock } : {}),
        });
        const deps = { signal: controller.signal };
        const [pageResult, timingResult] = await Promise.all([
          callRpc(source, "arkiv_query", params, deps),
          // Block timing turns heights into dates; a failure there is not a query failure.
          fetchBlockTiming(source, deps).catch(() => null),
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
    [source],
  );

  /** Runs the editor's text and records it in the URL so the run can be shared or returned to. */
  const execute = useCallback(
    (text: string, size: PageSize = pageSize, filter: ExpirationFilter = expiration) => {
      const normalized = normalizeQueryInput(text);
      if (!normalized) return;
      setQuery(normalized);
      urlQueryRef.current = normalized;
      if (writePermalink("data", dataPageFilters(normalized, size, filter))) onLocationChange();
      void runQuery(normalized, size);
    },
    [expiration, onLocationChange, pageSize, runQuery],
  );

  // A shared link, or back/forward, changes `q` under us: adopt it and run it.
  useEffect(() => {
    const fromUrl = urlFilters.q.trim();
    if (fromUrl === (urlQueryRef.current ?? "")) return;
    urlQueryRef.current = fromUrl;
    const size = resolvePageSize(urlFilters.pageSize);
    const filter = resolveExpirationFilter(urlFilters.expiration);
    setPageSize(size);
    setExpiration(filter);
    if (!fromUrl) {
      abortRef.current?.abort();
      setResults(EMPTY_RESULTS);
      return;
    }
    const normalized = normalizeQueryInput(fromUrl);
    setQuery(normalized);
    void runQuery(normalized, size);
  }, [runQuery, urlFilters.expiration, urlFilters.pageSize, urlFilters.q]);

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  const clear = () => {
    cancel();
    setQuery("");
    urlQueryRef.current = "";
    setResults(EMPTY_RESULTS);
    if (writePermalink("data", {})) onLocationChange();
  };

  const loadMore = () => {
    if (!results.executedQuery || !results.cursor || results.blockNumber === null) return;
    void runQuery(results.executedQuery, pageSize, { cursor: results.cursor, atBlock: results.blockNumber });
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
      if (writePermalink("data", dataPageFilters(results.executedQuery, pageSize, filter))) onLocationChange();
    }
  };

  const queryOnly = (expression: string) => execute(expression);
  const addToQuery = (expression: string) => execute(appendQueryExpression(query, expression));

  const updateSource = (next: RpcSource) => {
    setSource(next);
    writeStoredRpcSource(next);
    setFormError(null);
  };

  const onKindChange = (kind: RpcSourceKind) => updateSource({ ...source, kind });

  const runCheck = async () => {
    if (source.kind === "custom" && !isValidRpcUrl(source.customUrl)) {
      setFormError("Enter an absolute http(s) URL for the custom RPC endpoint.");
      return;
    }
    setFormError(null);
    setCheck({ status: "running", startedAt: Date.now() });
    const report = await checkRpcSource(source);
    setCheck({ status: "done", report });
  };

  const missing = backend.status === "known" ? missingBackendMethods(backend.methods) : [];
  const nowMs = Date.now();
  const visibleEntities =
    expiration === "soon"
      ? results.timing
        ? results.entities.filter((entity) => isExpiringSoon(entity.expiresAt, results.timing as BlockTiming, nowMs))
        : []
      : results.entities;
  const hasText = query.trim().length > 0;
  const running = results.running !== null;

  const onFallbackKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      execute(event.currentTarget.value);
    }
  };

  return (
    <section className="view data-view">
      <div className="page-heading">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "data", label: "Data" },
          ]}
          onLocationChange={onLocationChange}
        />
        <h2>Data</h2>
      </div>

      <p className="summary">
        Query the live entity state held by an Arkiv node. The index does not store entity state, so every result here
        comes straight from the selected RPC endpoint.{" "}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
          Query language docs
        </a>
        .
      </p>

      <div className="tx-detail-card query-card">
        <div className="query-editor">
          <Suspense
            fallback={
              <textarea
                className="query-editor-fallback"
                value={query}
                placeholder={QUERY_PLACEHOLDER}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onFallbackKeyDown}
                rows={2}
              />
            }
          >
            <QueryEditor value={query} onChange={setQuery} onExecute={(text) => execute(text)} placeholder={QUERY_PLACEHOLDER} />
          </Suspense>
        </div>
        <div className="query-toolbar">
          <span className="query-hint">
            <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs the query
          </span>
          <label className="query-toolbar-field">
            Page size
            <select value={pageSize} onChange={(event) => onPageSizeChange(event.target.value)} disabled={running}>
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="query-toolbar-field">
            Show
            <select value={expiration} onChange={(event) => onExpirationChange(event.target.value)}>
              {EXPIRATION_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All entities" : "Expiring within 24h"}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" onClick={clear} disabled={!hasText && results.executedQuery === null}>
            Clear
          </button>
          {running ? (
            <button type="button" className="query-run" onClick={cancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="query-run" onClick={() => execute(query)} disabled={!hasText}>
              Run query
            </button>
          )}
        </div>
        {formError ? <p className="summary error query-form-error">{formError}</p> : null}
        <div className="query-examples">
          <span className="query-examples-label">Try</span>
          {EXAMPLE_QUERIES.map((example) => (
            <button
              key={example.label}
              type="button"
              className="query-example"
              title={example.query}
              onClick={() => setQuery(example.query)}
            >
              {example.label}
            </button>
          ))}
        </div>
      </div>

      <EntityResults
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
      />

      <details className="rpc-endpoint-details">
        <summary>
          <span className="rpc-endpoint-summary-label">RPC endpoint</span>
          <span className="rpc-endpoint-summary-value mono">{describeRpcEndpoint(source) || "not set"}</span>
          {source.kind === "backend" && backend.status === "known" ? (
            <span className={`tx-status-badge ${backend.methods !== false && missing.length === 0 ? "ok" : "fail"}`}>
              {backend.methods === false ? "No upstream" : missing.length === 0 ? "Forwarding" : "Incomplete"}
            </span>
          ) : null}
          {check.status === "done" ? (
            <span className={`tx-status-badge ${check.report.ok ? "ok" : check.report.arkivOk ? "unknown" : "fail"}`}>
              {check.report.ok ? "Checked OK" : check.report.arkivOk ? "Arkiv reads OK" : "Check failed"}
            </span>
          ) : null}
        </summary>

        <div className="tx-detail-card rpc-source-card">
          <div className="tx-detail-groups rpc-source-groups">
            <div className="tx-detail-group">
              <h3>RPC endpoint</h3>
              <div className="rpc-source-options" role="radiogroup" aria-label="RPC endpoint">
                <label className={`rpc-source-option${source.kind === "backend" ? " selected" : ""}`}>
                  <input
                    type="radio"
                    name="rpc-source"
                    value="backend"
                    checked={source.kind === "backend"}
                    onChange={() => onKindChange("backend")}
                  />
                  <span className="rpc-source-option-body">
                    <span className="rpc-source-option-title">Indexer backend</span>
                    <span className="rpc-source-option-detail">
                      <span className="mono">{BACKEND_RPC_PATH}</span> forwards the entity reads to the node it is
                      configured with, using the deployment&apos;s own API key.
                    </span>
                    <BackendForwardingNote backend={backend} missing={missing} />
                  </span>
                </label>
                <label className={`rpc-source-option${source.kind === "custom" ? " selected" : ""}`}>
                  <input
                    type="radio"
                    name="rpc-source"
                    value="custom"
                    checked={source.kind === "custom"}
                    onChange={() => onKindChange("custom")}
                  />
                  <span className="rpc-source-option-body">
                    <span className="rpc-source-option-title">Custom RPC URL</span>
                    <span className="rpc-source-option-detail">
                      Called straight from the browser, so the node must allow cross-origin requests. A key in the
                      URL stays in this browser&apos;s local storage only.
                    </span>
                    <input
                      type="url"
                      className="rpc-source-url"
                      inputMode="url"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="https://rpc.example.arkiv.network/<api-key>"
                      value={source.customUrl}
                      disabled={source.kind !== "custom"}
                      onChange={(event) => updateSource({ ...source, customUrl: event.target.value })}
                    />
                  </span>
                </label>
              </div>
            </div>
            <div className="tx-detail-group rpc-check-actions">
              <h3>Connection check</h3>
              <p className="tx-detail-note">
                Calls <span className="mono">eth_chainId</span>, <span className="mono">web3_clientVersion</span>, and
                the three Arkiv reads ({ARKIV_READ_METHODS.join(", ")}) against the selected endpoint. Nothing is
                written.
              </p>
              <div className="rpc-check-buttons">
                <button type="button" onClick={runCheck} disabled={check.status === "running"}>
                  {check.status === "running" ? "Checking…" : "Check connection"}
                </button>
                {check.status === "done" ? (
                  <span className={`tx-status-badge ${check.report.ok ? "ok" : check.report.arkivOk ? "unknown" : "fail"}`}>
                    {check.report.ok ? "All methods answered" : check.report.arkivOk ? "Arkiv reads OK" : "Not usable"}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {check.status === "done" ? (
          <CheckReport report={check.report} timeZone={timeZone} onLocationChange={onLocationChange} />
        ) : null}
      </details>
    </section>
  );
}

function BackendForwardingNote({ backend, missing }: { backend: BackendForwarding; missing: string[] }) {
  if (backend.status === "loading") {
    return <span className="rpc-source-option-status muted">Reading the backend&apos;s forwarded methods…</span>;
  }
  if (backend.status === "unknown") {
    return (
      <span className="rpc-source-option-status warn">
        Could not read <span className="mono">/api/health</span>: {backend.error}
      </span>
    );
  }
  if (backend.methods === false) {
    return (
      <span className="rpc-source-option-status warn">
        The backend has no upstream node configured (<span className="mono">SHADOW_RPC_UPSTREAM</span> is unset), so
        it cannot forward entity reads.
      </span>
    );
  }
  if (missing.length > 0) {
    return (
      <span className="rpc-source-option-status warn">
        The backend forwards {backend.methods.length === 0 ? "no methods" : backend.methods.join(", ")}, but not{" "}
        {missing.join(", ")}. Add them to <span className="mono">SHADOW_RPC_UPSTREAM_METHODS</span>.
      </span>
    );
  }
  return <span className="rpc-source-option-status ok">Forwards all three entity read methods.</span>;
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
    <div className="tx-detail-card rpc-check-report">
      <div className="tx-detail-topline">
        <span className={`tx-status-badge ${report.ok ? "ok" : report.arkivOk ? "unknown" : "fail"}`}>
          {report.ok ? "OK" : report.arkivOk ? "Partial" : "Failed"}
        </span>
        <span className="rpc-check-endpoint mono" title={report.endpoint}>
          {report.endpoint}
        </span>
        <span className="rpc-check-meta">
          {fmtDate(report.startedAtUtc, timeZone)} · {report.steps.length} calls · {fmtInteger(totalMs)} ms
        </span>
      </div>

      <div className="tx-detail-groups">
        <div className="tx-detail-group">
          <h3>Node</h3>
          <dl className="tx-detail-grid">
            <Row label="Chain id" value={report.chainId === null ? "—" : fmtInteger(report.chainId)} />
            <Row label="Client" value={report.clientVersion ?? "—"} />
            <Row label="Head block" value={report.timing ? fmtInteger(report.timing.currentBlock) : "—"} />
            <Row label="Head time" value={headTime ? fmtDate(headTime, timeZone) : "—"} />
            <Row label="Block time" value={report.timing ? `${report.timing.blockDurationSeconds}s` : "—"} />
          </dl>
        </div>
        <div className="tx-detail-group">
          <h3>Entities</h3>
          <dl className="tx-detail-grid">
            <Row label="Live entities" value={report.entityCount === null ? "—" : fmtInteger(report.entityCount)} />
            <div className="tx-detail-row">
              <dt className="tx-detail-label">Sample key</dt>
              <dd className="tx-detail-value">
                {report.sampleEntityKey ? (
                  <span className="rpc-check-inline">
                    <SampleEntityLink entityKey={report.sampleEntityKey} onLocationChange={onLocationChange} />
                    <CopyButton value={report.sampleEntityKey} label="Copy entity key" />
                  </span>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="tx-detail-row">
              <dt className="tx-detail-label">Sample owner</dt>
              <dd className="tx-detail-value">
                {report.sampleEntityOwner ? <AddressCell address={report.sampleEntityOwner} /> : "—"}
              </dd>
            </div>
          </dl>
        </div>
        <div className="tx-detail-group">
          <h3>Verdict</h3>
          <p className="tx-detail-note">
            {report.ok
              ? "Every call answered. The Data page can use this endpoint."
              : report.arkivOk
                ? "The Arkiv entity reads answered, so entity queries will work; a plain Ethereum method failed, see below."
                : "At least one Arkiv read method failed. Entity queries will not work through this endpoint until it does."}
          </p>
        </div>
      </div>

      <div className="table-wrap rpc-check-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Checks that</th>
              <th>Status</th>
              <th>Time</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {report.steps.map((step) => (
              <StepRow key={step.method} step={step} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: RpcCheckStep }) {
  return (
    <tr className={step.status === "fail" ? "rpc-check-step-fail" : undefined}>
      <td data-label="Method" className="mono">
        {step.method}
      </td>
      <td data-label="Checks that">{step.purpose}</td>
      <td data-label="Status">
        <span className={`tx-status-badge ${step.status === "ok" ? "ok" : "fail"}`}>
          {step.status === "ok" ? "OK" : step.code !== undefined ? `Error ${step.code}` : "Failed"}
        </span>
      </td>
      <td data-label="Time" className="num">
        {fmtInteger(step.durationMs)} ms
      </td>
      <td data-label="Result" className="rpc-check-result">
        {step.summary}
      </td>
    </tr>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="tx-detail-row">
      <dt className="tx-detail-label">{label}</dt>
      <dd className="tx-detail-value">{value}</dd>
    </div>
  );
}

function SampleEntityLink({ entityKey, onLocationChange }: { entityKey: string; onLocationChange: () => void }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writeEntityPermalink(entityKey)) onLocationChange();
  };
  return (
    <a className="mono block-link" href={entityDetailHref(entityKey)} onClick={onClick} title="Open the indexed history">
      {entityKey}
    </a>
  );
}
