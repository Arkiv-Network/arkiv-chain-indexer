import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchServerMetricsText } from "./api";
import { fmtBytes, fmtDurationSeconds, fmtInteger } from "./format";
import {
  cacheStats,
  parsePrometheusText,
  processStats,
  routeTraffic,
  rpcTraffic,
} from "./promMetrics";

interface ServerMetricsPanelProps {
  /** The verified admin token, or undefined when admin mode is off. */
  adminToken?: string;
}

/**
 * The backend's Prometheus registry, rendered at the bottom of the health page.
 *
 * Counters are cumulative since the process started, so this is a running total
 * rather than a rate; `process_start_time_seconds` is shown alongside to say
 * what window the totals cover.
 */
export function ServerMetricsPanel({ adminToken }: ServerMetricsPanelProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = useCallback(() => {
    if (!adminToken) return;
    setLoading(true);
    setError(null);
    fetchServerMetricsText(adminToken)
      .then((body) => {
        setText(body);
        setFetchedAt(new Date());
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [adminToken]);

  useEffect(() => {
    if (!adminToken) {
      setText(null);
      setError(null);
      return;
    }
    load();
  }, [adminToken, load]);

  const samples = useMemo(() => (text ? parsePrometheusText(text) : []), [text]);
  const routes = useMemo(() => routeTraffic(samples), [samples]);
  const rpc = useMemo(() => rpcTraffic(samples), [samples]);
  const caches = useMemo(() => cacheStats(samples), [samples]);
  const process = useMemo(
    () => processStats(samples, fetchedAt ?? new Date()),
    [samples, fetchedAt],
  );

  if (!adminToken) {
    return (
      <section className="health-panel server-metrics-panel">
        <h3>Server metrics</h3>
        <p className="muted">
          Enable admin mode to load the backend's Prometheus registry. It is served on
          <code> /api/admin/metrics</code>, behind the admin bearer token.
        </p>
      </section>
    );
  }

  return (
    <section className="health-panel server-metrics-panel">
      <div className="view-heading-row">
        <h3>Server metrics</h3>
        <div className="server-metrics-actions">
          <button type="button" className="secondary" onClick={() => setShowRaw((value) => !value)}>
            {showRaw ? "Hide raw" : "Show raw"}
          </button>
          <button type="button" className="secondary" onClick={load} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <p className="muted server-metrics-caption">
        Totals since the process started {fmtDurationSeconds(process.uptimeSeconds)} ago:{" "}
        {fmtInteger(process.totalRequests)} requests, {fmtInteger(process.totalRpcCalls)} JSON-RPC
        calls. Resident memory {fmtBytes(process.residentBytes)}, heap {fmtBytes(process.heapBytes)}.
      </p>

      <h4>Traffic by route</h4>
      {routes.length === 0 ? (
        <p className="muted">No requests recorded yet.</p>
      ) : (
        <div className="table-wrap health-table-wrap">
          <table className="data-table health-table">
            <thead>
              <tr>
                <th>Route</th>
                <th>Requests</th>
                <th>4xx</th>
                <th>5xx</th>
                <th>Mean</th>
                <th>DB</th>
                <th>Queries/req</th>
                <th>Sent</th>
                <th>In flight</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((row) => (
                <tr key={row.route}>
                  <td>{row.route}</td>
                  <td className="num">{fmtInteger(row.requests)}</td>
                  <td className="num">{row.clientErrors ? fmtInteger(row.clientErrors) : "—"}</td>
                  <td className={`num${row.serverErrors ? " error" : ""}`}>
                    {row.serverErrors ? fmtInteger(row.serverErrors) : "—"}
                  </td>
                  <td className="num">{fmtMillis(row.meanSeconds)}</td>
                  <td className="num">{fmtMillis(row.meanDbSeconds)}</td>
                  <td className="num">{fmtDecimal(row.dbQueriesPerRequest)}</td>
                  <td className="num">{fmtBytes(row.responseBytes)}</td>
                  <td className="num">{row.inFlight ? fmtInteger(row.inFlight) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>JSON-RPC by method</h4>
      {rpc.length === 0 ? (
        <p className="muted">No JSON-RPC calls recorded yet.</p>
      ) : (
        <div className="table-wrap health-table-wrap">
          <table className="data-table health-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Answered by</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>Mean</th>
              </tr>
            </thead>
            <tbody>
              {rpc.map((row) => (
                <tr key={`${row.path} ${row.method}`}>
                  <td>{row.method}</td>
                  <td>{row.path}</td>
                  <td>{row.sources.join(", ") || "—"}</td>
                  <td className="num">{fmtInteger(row.calls)}</td>
                  <td className="num">{row.errors ? fmtInteger(row.errors) : "—"}</td>
                  <td className="num">{fmtMillis(row.meanSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4>Caches</h4>
      {caches.length === 0 ? (
        <p className="muted">No caches reported.</p>
      ) : (
        <div className="table-wrap health-table-wrap">
          <table className="data-table health-table">
            <thead>
              <tr>
                <th>Cache</th>
                <th>Hit rate</th>
                <th>Hits</th>
                <th>Misses</th>
                <th>Coalesced</th>
                <th>Entries</th>
                <th>Size</th>
                <th>Evictions</th>
              </tr>
            </thead>
            <tbody>
              {caches.map((row) => (
                <tr key={row.cache}>
                  <td>{row.cache}</td>
                  <td className="num">{fmtPercent(row.hitRatio)}</td>
                  <td className="num">{fmtInteger(row.hits)}</td>
                  <td className="num">{fmtInteger(row.misses)}</td>
                  <td className="num">{fmtInteger(row.coalesced)}</td>
                  <td className="num">{fmtInteger(row.entries)}</td>
                  <td className="num">{fmtBytes(row.bytes)}</td>
                  <td className="num">{fmtInteger(row.evictions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRaw ? <pre className="server-metrics-raw">{text ?? ""}</pre> : null}
    </section>
  );
}

/** Seconds to a millisecond reading, the unit every latency here lands in. */
function fmtMillis(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—";
  const ms = seconds * 1000;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 10) return `${ms.toFixed(1)} ms`;
  return `${ms.toFixed(2)} ms`;
}

function fmtDecimal(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

function fmtPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}
