import { useCallback, useEffect, useMemo, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import { fetchGuzzlerHistory, type GuzzlerHistoryPoint, type GuzzlerHistoryResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { blockieDataUri } from "./blockies";
import { fmtDate, fmtDurationSeconds, fmtEth, fmtInteger, fmtMillions } from "./format";
import {
  activityPlotRange,
  filterPointsByWindow,
  GUZZLER_ACTIVITY_METRICS,
  GUZZLER_ACTIVITY_WINDOWS,
  metricSeries,
  normalizeAddressInput,
  summarizeGuzzlerHistory,
  type GuzzlerActivityMetricKey,
  type GuzzlerActivityWindowKey,
} from "./guzzlerActivity";

const Plot = createPlotlyComponent(Plotly);

interface GuzzlerActivityViewProps {
  address: string;
  /** Selected time window, kept in the permalink so it survives reloads/links. */
  windowKey: GuzzlerActivityWindowKey;
  timeZone: string;
  tokenSymbol: string;
  /** Return to the leaderboard. */
  onBack: () => void;
  /** Switch the view to a different address. */
  onSelectAddress: (address: string) => void;
  /** Change the time window (rewrites the permalink). */
  onWindowChange: (windowKey: GuzzlerActivityWindowKey) => void;
}

const REFRESH_MS = 15_000;

/** Per-minute activity timeseries for a single guzzler over the last 24h. */
export function GuzzlerActivityView({
  address,
  windowKey,
  timeZone,
  tokenSymbol,
  onBack,
  onSelectAddress,
  onWindowChange,
}: GuzzlerActivityViewProps) {
  const [data, setData] = useState<GuzzlerHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [metricKey, setMetricKey] = useState<GuzzlerActivityMetricKey>("transactions");
  const [addressInput, setAddressInput] = useState(address);
  const [inputError, setInputError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGuzzlerHistory(address)
      .then((body) => {
        setData(body);
        setNow(Date.now());
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(() => {
    setAddressInput(address);
    setInputError(null);
  }, [address]);

  useEffect(() => {
    load();
    const refresh = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [load]);

  const selectedWindow =
    GUZZLER_ACTIVITY_WINDOWS.find((w) => w.key === windowKey) ?? GUZZLER_ACTIVITY_WINDOWS[2]!;
  const selectedMetric =
    GUZZLER_ACTIVITY_METRICS.find((m) => m.key === metricKey) ?? GUZZLER_ACTIVITY_METRICS[0]!;

  const allPoints = data?.points ?? [];
  const windowedPoints = useMemo(
    () => filterPointsByWindow(allPoints, now, selectedWindow.ms),
    [allPoints, now, selectedWindow.ms],
  );
  const summary = useMemo(() => summarizeGuzzlerHistory(windowedPoints), [windowedPoints]);

  const { traces, layout } = useMemo(
    () => buildActivityPlot(windowedPoints, metricKey, now, selectedWindow.ms, timeZone, tokenSymbol),
    [windowedPoints, metricKey, now, selectedWindow.ms, timeZone, tokenSymbol],
  );

  const display = addressDisplay(address);
  const retentionLabel = data ? fmtDurationSeconds(data.retentionMs / 1000) : "24h";
  // Reads naturally for both the fixed windows and the auto-fit "All" tab.
  const spanPhrase =
    selectedWindow.ms === null ? "over the full retained history" : `in the last ${selectedWindow.label}`;

  const onSubmitAddress = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeAddressInput(addressInput);
    if (!normalized) {
      setInputError("Enter a valid 0x… address");
      return;
    }
    setInputError(null);
    if (normalized !== address) {
      onSelectAddress(normalized);
    }
  };

  return (
    <section className="view guzzlers-view guzzler-activity">
      <div className="view-heading-row">
        <div className="guzzler-activity-title">
          <button type="button" className="link-button guzzler-back" onClick={onBack}>
            ← Leaderboard
          </button>
          <h2>Wallet activity</h2>
        </div>
        <div className="guzzler-controls">
          <div className="segmented" role="group" aria-label="Metric">
            {GUZZLER_ACTIVITY_METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                className={m.key === metricKey ? "active" : ""}
                aria-pressed={m.key === metricKey}
                onClick={() => setMetricKey(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Time window">
            {GUZZLER_ACTIVITY_WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                className={w.key === windowKey ? "active" : ""}
                aria-pressed={w.key === windowKey}
                onClick={() => onWindowChange(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" onClick={load} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="guzzler-activity-id">
        <img
          className="guzzler-icon"
          src={blockieDataUri(address)}
          alt=""
          width={40}
          height={40}
        />
        <form className="guzzler-address-form" onSubmit={onSubmitAddress}>
          <label className="visually-hidden" htmlFor="guzzler-address-input">
            Wallet address
          </label>
          <input
            id="guzzler-address-input"
            className="mono"
            value={addressInput}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setAddressInput(event.target.value)}
            placeholder="0x…"
            title={display.title ?? address}
          />
          <button type="submit" className="secondary">
            View
          </button>
          {inputError ? <span className="field-error">{inputError}</span> : null}
        </form>
      </div>

      <p className={`summary${error ? " error" : ""}`}>
        {error
          ? `Failed to load activity: ${error}`
          : data
            ? summary.activeMinutes > 0
              ? `${fmtInteger(summary.totalTransactions)} txs across ${fmtInteger(
                  summary.activeMinutes,
                )} active minute${summary.activeMinutes === 1 ? "" : "s"} ${spanPhrase}. Per-minute buckets are kept for ${retentionLabel}.`
              : `No activity for this address ${spanPhrase}.`
            : loading
              ? "Loading activity…"
              : "No activity loaded."}
      </p>

      <dl className="guzzler-activity-stats">
        <div>
          <dt>Transactions</dt>
          <dd>{fmtInteger(summary.totalTransactions)}</dd>
        </div>
        <div>
          <dt>Gas used</dt>
          <dd>{fmtMillions(summary.totalGasUsed)}</dd>
        </div>
        <div>
          <dt>Fees ({tokenSymbol})</dt>
          <dd>{fmtEth(summary.totalFeeWei)}</dd>
        </div>
        <div>
          <dt>Active minutes</dt>
          <dd>{fmtInteger(summary.activeMinutes)}</dd>
        </div>
        <div>
          <dt>Peak txs / min</dt>
          <dd>{fmtInteger(summary.peakTransactions)}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{summary.lastSeen ? fmtDate(summary.lastSeen, timeZone) : "—"}</dd>
        </div>
      </dl>

      <div className="guzzler-activity-chart">
        {windowedPoints.length > 0 ? (
          <Plot
            data={traces}
            layout={layout}
            useResizeHandler
            style={{ width: "100%", height: "100%" }}
            config={{ displaylogo: false, responsive: true }}
          />
        ) : (
          <div className="selection-empty">
            {error
              ? "Could not load activity for this address."
              : data
                ? `No ${selectedMetric.label.toLowerCase()} recorded for this address ${spanPhrase}.`
                : "Loading…"}
          </div>
        )}
      </div>
    </section>
  );
}

interface PlotBuildResult {
  traces: Partial<Plotly.PlotData>[];
  layout: Partial<Plotly.Layout>;
}

const METRIC_COLORS: Record<GuzzlerActivityMetricKey, string> = {
  transactions: "#2e63d8",
  gas: "#d35400",
  fees: "#2f9e44",
};

function buildActivityPlot(
  points: readonly GuzzlerHistoryPoint[],
  metric: GuzzlerActivityMetricKey,
  nowMs: number,
  windowMs: number | null,
  timeZone: string,
  tokenSymbol: string,
): PlotBuildResult {
  const meta = GUZZLER_ACTIVITY_METRICS.find((m) => m.key === metric) ?? GUZZLER_ACTIVITY_METRICS[0]!;
  const color = METRIC_COLORS[metric];

  const xs = points.map((point) => point.startTime);
  // Gas runs to tens of millions, so plot it in millions to keep the y-axis
  // readable; the axis title ("… (millions) …") and tooltip are scaled to match.
  const rawYs = metricSeries(points, metric);
  const ys = metric === "gas" ? rawYs.map((value) => value / 1_000_000) : rawYs;
  // Hover shows every measure regardless of the plotted metric, so switching
  // tabs never hides context.
  const customdata = points.map(
    (point) =>
      [
        fmtDate(point.startTime, timeZone),
        fmtInteger(point.transactionCount),
        fmtMillions(point.totalGasUsed),
        `${fmtEth(point.totalFeeWei)} ${tokenSymbol}`,
      ] as [string, string, string, string],
  );

  const traces: Partial<Plotly.PlotData>[] = [
    {
      type: "bar",
      name: meta.label,
      x: xs,
      y: ys,
      marker: { color },
      customdata: customdata as unknown as Plotly.Datum[],
      hovertemplate:
        "<b>%{customdata[0]}</b><br>" +
        "Txs %{customdata[1]}<br>" +
        "Gas %{customdata[2]}<br>" +
        "Fees %{customdata[3]}<extra></extra>",
    },
  ];

  const range = activityPlotRange(nowMs, windowMs);
  const layout: Partial<Plotly.Layout> = {
    autosize: true,
    margin: { l: 70, r: 20, t: 20, b: 50 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    // Plotly's default "Open Sans" isn't bundled, so it falls back to an ugly
    // system font; pin it to a webfont the app actually ships.
    font: {
      family: getCssVar("--font-mono", '"JetBrains Mono", ui-monospace, monospace'),
      color: getCssVar("--fg", "#1a1d23"),
    },
    bargap: 0.05,
    showlegend: false,
    hovermode: "x",
    xaxis: {
      type: "date",
      title: { text: "Time" } as Plotly.DataTitle,
      gridcolor: getCssVar("--border", "#d6d9df"),
      zerolinecolor: getCssVar("--border", "#d6d9df"),
      ...(range ? { range, autorange: false } : { autorange: true }),
    },
    yaxis: {
      title: { text: meta.axisTitle.replace("{token}", tokenSymbol) } as Plotly.DataTitle,
      rangemode: "tozero",
      gridcolor: getCssVar("--border", "#d6d9df"),
      zerolinecolor: getCssVar("--border", "#d6d9df"),
    },
  };

  return { traces, layout };
}

function getCssVar(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
