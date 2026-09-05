import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type HealthResponse } from "./api";
import { fmtBytes, fmtDate, fmtDurationSeconds, fmtInteger, fmtUtcDate } from "./format";
import { ServerMetricsPanel } from "./ServerMetricsPanel";
import { SyncDetails } from "./SyncStatusBanner";
import { describeSync } from "./syncStatus";

interface HealthViewProps {
  timeZone: string;
  /** The verified admin token, or undefined when admin mode is off. */
  adminToken?: string;
}

export function HealthView({ timeZone, adminToken }: HealthViewProps) {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [browserNow, setBrowserNow] = useState(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchHealth()
      .then((body) => setData(body))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const refresh = window.setInterval(load, 15_000);
    const tick = window.setInterval(() => setBrowserNow(new Date()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(tick);
    };
  }, [load]);

  const scanner = data?.scanner;
  const sync = data?.sync ?? null;
  const syncPresentation = describeSync(sync);
  const database = data?.database;
  const guzzlers = data?.guzzlers;
  const guzzlersEnabled = guzzlers?.enabled ?? data?.features.guzzlers ?? false;

  return (
    <section className="view health-view">
      <div className="view-heading-row">
        <h2>Health</h2>
        <button type="button" className="secondary" onClick={load} disabled={loading}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {sync ? (
        <section className={`health-panel sync-panel sync-banner-${syncPresentation.tone}`}>
          <div className="sync-panel-heading">
            <h3>Sync status</h3>
            <span className="sync-banner-badge">{syncPresentation.label}</span>
          </div>
          <p className="sync-panel-headline">{syncPresentation.headline}</p>
          <p className="sync-panel-detail">{syncPresentation.detail}</p>
          <SyncDetails status={sync} timeZone={timeZone} />
        </section>
      ) : null}
      <div className="health-grid">
        <section className="health-panel">
          <h3>Scanner progress</h3>
          <dl>
            <Metric label="Last stored block" value={fmtInteger(scanner?.lastSuccessfulBlock)} />
            <Metric label="Safe head lag" value={fmtInteger(scanner?.safeHeadLagBlocks)} />
            <Metric label="Chain head lag" value={fmtInteger(scanner?.headLagBlocks)} />
            <Metric label="Last block age" value={fmtDurationSeconds(scanner?.lastBlockAgeSeconds)} />
            <Metric label="Last block time" value={fmtDate(scanner?.lastSuccessfulBlockDate, timeZone)} />
            <Metric label="Stored at UTC" value={fmtUtcDate(scanner?.lastSuccessfulScannedAtUtc)} />
          </dl>
        </section>

        <section className="health-panel">
          <h3>Chain observation</h3>
          <dl>
            <Metric label="Latest observed head" value={fmtInteger(scanner?.latestObservedBlock)} />
            <Metric label="Safe head" value={fmtInteger(scanner?.safeHeadBlock)} />
            <Metric label="Backfill next block" value={fmtInteger(scanner?.backfillNextBlock)} />
            <Metric label="Observed at UTC" value={fmtUtcDate(scanner?.latestObservedAtUtc)} />
            <Metric
              label="Observation age"
              value={fmtDurationSeconds(scanner?.latestObservationAgeSeconds)}
            />
          </dl>
        </section>

        <section className="health-panel">
          <h3>Time and build</h3>
          <dl>
            <Metric label="Server UTC" value={fmtUtcDate(data?.serverTimeUtc)} />
            <Metric label="Browser time" value={fmtDate(browserNow.toISOString(), browserTimeZone)} />
            <Metric label="Selected time" value={fmtDate(browserNow.toISOString(), timeZone)} />
            <Metric label="Selected time zone" value={timeZone} />
            <Metric label="Transaction data" value={data?.features.transactionData === false ? "Disabled" : "Enabled"} />
            <Metric label="Build commit" value={shortCommit(data?.build.commit)} />
            <Metric label="Build date UTC" value={fmtUtcDate(data?.build.builtAtUtc)} />
          </dl>
        </section>

        <section className="health-panel">
          <h3>Guzzler cache</h3>
          <dl>
            <Metric label="Status" value={guzzlersEnabled ? "Enabled" : "Disabled"} />
            <Metric
              label="Cached senders"
              value={guzzlersEnabled ? fmtInteger(guzzlers?.entryCount) : "—"}
            />
            <Metric
              label="Cached buckets"
              value={guzzlersEnabled ? fmtInteger(guzzlers?.bucketCount) : "—"}
            />
            <Metric
              label="Cache size"
              value={guzzlersEnabled ? fmtBytes(guzzlers?.totalSizeBytes) : "—"}
              title={guzzlersEnabled ? bytesTitle(guzzlers?.totalSizeBytes) : undefined}
            />
            <Metric
              label="Oldest bucket"
              value={guzzlersEnabled ? fmtDate(guzzlers?.oldestBucket, timeZone) : "—"}
            />
            <Metric
              label="Newest bucket"
              value={guzzlersEnabled ? fmtDate(guzzlers?.newestBucket, timeZone) : "—"}
            />
          </dl>
        </section>
      </div>

      <section className="health-panel database-panel">
        <h3>Database</h3>
        <dl>
          <Metric
            label="Total database size"
            value={fmtBytes(database?.totalSizeBytes)}
            title={bytesTitle(database?.totalSizeBytes)}
          />
        </dl>
        <div className="table-wrap health-table-wrap">
            <table className="data-table health-table">
              <thead>
                <tr>
                  <th>Table</th>
                  <th>Rows (est.)</th>
                  <th>Table</th>
                  <th>Indexes</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {(database?.tables ?? []).map((table) => (
                  <tr key={table.tableName}>
                    <td>{table.tableName}</td>
                    <td className="num">{fmtInteger(table.rowCount)}</td>
                    <td className="num" title={bytesTitle(table.tableSizeBytes)}>
                      {fmtBytes(table.tableSizeBytes)}
                    </td>
                    <td className="num" title={bytesTitle(table.indexesSizeBytes)}>
                      {fmtBytes(table.indexesSizeBytes)}
                    </td>
                    <td className="num" title={bytesTitle(table.totalSizeBytes)}>
                      {fmtBytes(table.totalSizeBytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

      <ServerMetricsPanel {...(adminToken ? { adminToken } : {})} />
    </section>
  );
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </>
  );
}

function shortCommit(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function bytesTitle(value: string | null | undefined): string | undefined {
  return value ? `${value} bytes` : undefined;
}
