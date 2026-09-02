import { useEffect, useState, type MouseEvent } from "react";
import { fetchHealth } from "./api";
import {
  ARKIV_READ_METHODS,
  BACKEND_RPC_PATH,
  checkRpcSource,
  isValidRpcUrl,
  missingBackendMethods,
  readStoredRpcSource,
  writeStoredRpcSource,
  type RpcCheckReport,
  type RpcCheckStep,
  type RpcSource,
  type RpcSourceKind,
} from "./dataRpc";
import { fmtDate, fmtInteger } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { entityDetailHref, shouldHandleClientNavigation, writeEntityPermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { CopyButton } from "./TransactionView";

interface DataViewProps {
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

export function DataView({ onLocationChange, timeZone }: DataViewProps) {
  const [source, setSource] = useState<RpcSource>(() => readStoredRpcSource());
  const [backend, setBackend] = useState<BackendForwarding>({ status: "loading" });
  const [check, setCheck] = useState<CheckState>({ status: "idle" });
  const [formError, setFormError] = useState<string | null>(null);

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
        This page reads live entity state from an Arkiv node, which the index does not store. Pick the RPC
        endpoint it should use, then run the connection check to see whether that endpoint answers the entity
        read methods.
      </p>

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
            {formError ? <p className="summary error">{formError}</p> : null}
          </div>
        </div>
      </div>

      {check.status === "done" ? (
        <CheckReport report={check.report} timeZone={timeZone} onLocationChange={onLocationChange} />
      ) : null}
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
