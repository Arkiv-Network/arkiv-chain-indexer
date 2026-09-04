import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-basic-dist-min";
import { AddressFace } from "./AddressFace";
import { fetchGuzzlerHistory, type GuzzlerHistoryPoint, type GuzzlerHistoryResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { Stat, StatGrid } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fmtDate, fmtDurationSeconds, fmtInteger, fmtMillions, fmtTokenAmount } from "./format";
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
import { addressSearchHref } from "./transactionLinks";

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
  const transactionsHref = addressSearchHref(address);
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
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={onBack} className="gap-1">
            <ArrowLeft className="size-3.5" />
            Leaderboard
          </Button>
          <h2 className="font-heading text-lg font-black tracking-tight">Wallet activity</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={metricKey} onValueChange={(value) => setMetricKey(value as GuzzlerActivityMetricKey)}>
            <TabsList aria-label="Metric">
              {GUZZLER_ACTIVITY_METRICS.map((m) => (
                <TabsTrigger key={m.key} value={m.key}>
                  {m.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Tabs value={windowKey} onValueChange={(value) => onWindowChange(value as GuzzlerActivityWindowKey)}>
            <TabsList aria-label="Time window">
              {GUZZLER_ACTIVITY_WINDOWS.map((w) => (
                <TabsTrigger key={w.key} value={w.key}>
                  {w.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border border-border bg-card p-3">
        <AddressFace address={address} className="size-10 border border-border" />
        <form className="flex items-end gap-2" onSubmit={onSubmitAddress}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="guzzler-address-input" className="sr-only">
              Wallet address
            </Label>
            <Input
              id="guzzler-address-input"
              className="w-96 font-mono"
              value={addressInput}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setAddressInput(event.target.value)}
              placeholder="0x…"
              title={display.title ?? address}
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            View
          </Button>
          {inputError ? <span className="text-xs text-destructive">{inputError}</span> : null}
        </form>
        {transactionsHref ? (
          <a className="text-xs text-accent hover:underline" href={transactionsHref}>
            View transactions
          </a>
        ) : null}
      </div>

      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
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

      <StatGrid className="sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Transactions" size="lg">{fmtInteger(summary.totalTransactions)}</Stat>
        <Stat label="Gas used" size="lg" wide>{fmtMillions(summary.totalGasUsed)}</Stat>
        <Stat label="Fees" size="lg" wide>{fmtTokenAmount(summary.totalFeeWei, tokenSymbol)}</Stat>
        <Stat label="Active minutes" size="lg">{fmtInteger(summary.activeMinutes)}</Stat>
        <Stat label="Peak txs / min" size="lg">{fmtInteger(summary.peakTransactions)}</Stat>
        <Stat label="Last seen" size="lg">{summary.lastSeen ? fmtDate(summary.lastSeen, timeZone) : "—"}</Stat>
      </StatGrid>

      <div className="h-96 border border-border bg-card p-2">
        {windowedPoints.length > 0 ? (
          <Plot
            data={traces}
            layout={layout}
            useResizeHandler
            style={{ width: "100%", height: "100%" }}
            config={{ displaylogo: false, responsive: true }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
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
        fmtTokenAmount(point.totalFeeWei, tokenSymbol),
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
      family: getCssVar("--font-mono", '"IBM Plex Mono", ui-monospace, monospace'),
      color: getCssVar("--foreground", "#111111"),
    },
    bargap: 0.05,
    showlegend: false,
    hovermode: "x",
    xaxis: {
      type: "date",
      title: { text: "Time" } as Plotly.DataTitle,
      gridcolor: getCssVar("--border", "#e9e6de"),
      zerolinecolor: getCssVar("--border", "#e9e6de"),
      ...(range ? { range, autorange: false } : { autorange: true }),
    },
    yaxis: {
      title: { text: meta.axisTitle.replace("{token}", tokenSymbol) } as Plotly.DataTitle,
      rangemode: "tozero",
      gridcolor: getCssVar("--border", "#e9e6de"),
      zerolinecolor: getCssVar("--border", "#e9e6de"),
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
