import { useCallback, useEffect, useState } from "react";
import { fetchHealth, type HealthResponse } from "./api";
import { fmtDate, fmtDurationSeconds, fmtInteger, fmtUtcDate } from "./format";

interface HealthViewProps {
  timeZone: string;
}

export function HealthView({ timeZone }: HealthViewProps) {
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

  return (
    <section className="view health-view">
      <div className="view-heading-row">
        <h2>Health</h2>
        <button type="button" className="secondary" onClick={load} disabled={loading}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
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
            <Metric label="Build commit" value={shortCommit(data?.build.commit)} />
            <Metric label="Build date UTC" value={fmtUtcDate(data?.build.builtAtUtc)} />
          </dl>
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function shortCommit(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 12 ? value.slice(0, 12) : value;
}
