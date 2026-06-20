import { useCallback, useEffect, useMemo, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-basic-dist-min";
import {
  fetchBlocks,
  fetchRanges,
  type StoredBlock,
  type StoredBlockRange,
} from "./api";
import {
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  type View,
  writePermalink,
} from "./permalinks";
import {
  readStoredString,
  readStoredStringRecord,
  removeStoredSection,
  removeStoredValue,
  writeStoredString,
  writeStoredStringRecord,
} from "./localStorage";
import { fmtDate } from "./format";
import {
  DEFAULT_PARAMETERS,
  filterParametersForRangeMode,
  getAvailableParameters,
  parseSelectedParameters,
  type ParameterDef,
} from "./chartParameters";
import {
  chartRequestLimit,
  CHART_POINT_COUNT_OPTIONS,
  DEFAULT_CHART_POINT_COUNT,
  normalizeChartPointCount,
  parseChartPointCount,
} from "./chartPointCounts";

const Plot = createPlotlyComponent(Plotly);

interface ChartsViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  transactionDataEnabled: boolean;
  tokenSymbol: string;
  noBatcher: boolean;
  presentationMode?: "standard" | "fullscreen";
}

interface ChartsFilters extends Record<string, string> {
  zoom: string;
  points: string;
  startDate: string;
  blockStart: string;
  blockEnd: string;
  xAxisMode: string;
  parameters: string;
}

const FILTER_KEYS = ["zoom", "points", "startDate", "blockStart", "blockEnd", "xAxisMode", "parameters"] as const;
const STORAGE_SECTION = "charts.";
const FILTERS_STORAGE_KEY = `${STORAGE_SECTION}filters`;
const SIDEBAR_COLLAPSED_STORAGE_KEY = `${STORAGE_SECTION}sidebarCollapsed`;
type XAxisMode = "blocks" | "dates";
const X_AXIS_MODES: { value: XAxisMode; label: string }[] = [
  { value: "blocks", label: "Blocks" },
  { value: "dates", label: "Dates" },
];

interface ZoomLevel {
  rangeSize: number;
  label: string;
}

const ZOOM_LEVELS: ZoomLevel[] = [
  { rangeSize: 1, label: "1 (blocks)" },
  { rangeSize: 2, label: "2" },
  { rangeSize: 5, label: "5" },
  { rangeSize: 10, label: "10" },
  { rangeSize: 20, label: "20" },
  { rangeSize: 50, label: "50" },
  { rangeSize: 100, label: "100" },
  { rangeSize: 150, label: "150" },
  { rangeSize: 300, label: "300" },
  { rangeSize: 1000, label: "1000" },
];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface TimeStep {
  label: string;
  ms: number;
}

const TIME_STEPS: TimeStep[] = [
  { label: "1d", ms: DAY_MS },
  { label: "1h", ms: HOUR_MS },
  { label: "10m", ms: 10 * MINUTE_MS },
  { label: "1m", ms: MINUTE_MS },
];

const DEFAULT_FILTERS: ChartsFilters = {
  zoom: "0",
  points: String(DEFAULT_CHART_POINT_COUNT),
  startDate: "",
  blockStart: "",
  blockEnd: "",
  xAxisMode: "blocks",
  parameters: DEFAULT_PARAMETERS.join(","),
};

function clampZoomIndex(value: string): number {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return 6;
  if (n < 0) return 0;
  if (n >= ZOOM_LEVELS.length) return ZOOM_LEVELS.length - 1;
  return n;
}

function normalizeIsoDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}

function parseXAxisMode(value: string): XAxisMode {
  return value === "dates" ? "dates" : "blocks";
}

interface BlockWindow {
  start: number;
  end: number;
}

function parseBlockWindow(filters: ChartsFilters): BlockWindow | null {
  if (!filters.blockStart.trim() || !filters.blockEnd.trim()) return null;
  const start = Number(filters.blockStart);
  const end = Number(filters.blockEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start < 0 || end < start) return null;
  return { start, end };
}

function clearBlockWindow(filters: ChartsFilters): ChartsFilters {
  if (!filters.blockStart && !filters.blockEnd) return filters;
  return { ...filters, blockStart: "", blockEnd: "" };
}

function loadFilters(locationSearch: string): ChartsFilters {
  const stored = readStoredStringRecord(FILTERS_STORAGE_KEY, DEFAULT_FILTERS, FILTER_KEYS);
  const merged = readFiltersFromSearch(locationSearch, FILTER_KEYS, stored);
  return {
    ...merged,
    points: normalizeChartPointCount(merged.points),
    startDate: normalizeIsoDate(merged.startDate),
    xAxisMode: parseXAxisMode(merged.xAxisMode),
  };
}

function loadSidebarCollapsed(): boolean {
  return readStoredString(
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    "false",
    (value) => value === "true" || value === "false",
  ) === "true";
}

interface ChartPoint {
  rangeStart: number;
  rangeEnd: number;
  rangeSize: number;
  midBlock: number;
  midDate: string;
  startDate: string;
  endDate: string;
  values: Record<string, string | number | null | undefined>;
}

interface ParameterGroup {
  key: string;
  label: string;
  parameters: ParameterDef[];
}

function blockToPoint(b: StoredBlock): ChartPoint {
  return {
    rangeStart: b.blockNumber,
    rangeEnd: b.blockNumber,
    rangeSize: 1,
    midBlock: b.blockNumber,
    midDate: b.blockDate,
    startDate: b.blockDate,
    endDate: b.blockDate,
    values: {
      minBaseFeeWei: b.baseBlockFeeWei,
      maxBaseFeeWei: b.baseBlockFeeWei,
      averageBaseFeeWei: b.baseBlockFeeWei,
      minBlockTimeSeconds: b.blockTimeSeconds,
      maxBlockTimeSeconds: b.blockTimeSeconds,
      averageBlockTimeSeconds: b.blockTimeSeconds,
      averageFeePriceWei: b.averageFeePriceWei,
      averagePriorityFeeWei: b.averagePriorityFeeWei,
      averagePriorityFeeWeightedWei: b.averagePriorityFeeWeightedWei,
      minMaxGasInBlock: b.maxGasInBlock,
      maxMaxGasInBlock: b.maxGasInBlock,
      totalGasUsed: b.totalGasUsed,
      totalInputDataSizeBytes: b.totalInputDataSizeBytes,
      totalInputDataCompressedSizeBytes: b.totalInputDataCompressedSizeBytes,
      totalBlockRewardWei: b.blockRewardWei,
      averageBlockRewardWei: b.blockRewardWei,
      totalBurntFeesWei: b.burntFeesWei,
      averageBurntFeesWei: b.burntFeesWei,
      transactionCount: b.transactionCount,
      averageTransactionGasUsed: b.averageTransactionGasUsed,
      averageTransactionInputDataSizeBytes: b.averageTransactionInputDataSizeBytes,
      averageTransactionInputDataCompressedSizeBytes: b.averageTransactionInputDataCompressedSizeBytes,
      minBatcherQueueSize: b.batcherQueueSize,
      maxBatcherQueueSize: b.batcherQueueSize,
      averageBatcherQueueSize: b.batcherQueueSize,
      averageBatcherIntensity: b.batcherIntensity,
      averageBatcherLowerThreshold: b.batcherLowerThreshold,
      averageBatcherUpperThreshold: b.batcherUpperThreshold,
      averageBatcherMaxBlockSize: b.batcherMaxBlockSize,
      averageBatcherMaxTxSize: b.batcherMaxTxSize,
    },
  };
}

function rangeToPoint(r: StoredBlockRange): ChartPoint {
  const mid = Math.floor((r.rangeStart + r.rangeEnd) / 2);
  const t0 = Date.parse(r.minBlockDate);
  const t1 = Date.parse(r.maxBlockDate);
  const midTs = Number.isFinite(t0) && Number.isFinite(t1) ? (t0 + t1) / 2 : t0;
  return {
    rangeStart: r.rangeStart,
    rangeEnd: r.rangeEnd,
    rangeSize: r.rangeSize,
    midBlock: mid,
    midDate: Number.isFinite(midTs) ? new Date(midTs).toISOString() : r.minBlockDate,
    startDate: r.minBlockDate,
    endDate: r.maxBlockDate,
    values: {
      minBaseFeeWei: r.minBaseFeeWei,
      maxBaseFeeWei: r.maxBaseFeeWei,
      averageBaseFeeWei: r.averageBaseFeeWei,
      minBlockTimeSeconds: r.minBlockTimeSeconds,
      maxBlockTimeSeconds: r.maxBlockTimeSeconds,
      averageBlockTimeSeconds: r.averageBlockTimeSeconds,
      averageFeePriceWei: r.averageFeePriceWei,
      averagePriorityFeeWei: r.averagePriorityFeeWei,
      averagePriorityFeeWeightedWei: r.averagePriorityFeeWeightedWei,
      minMaxGasInBlock: r.minMaxGasInBlock,
      maxMaxGasInBlock: r.maxMaxGasInBlock,
      totalGasUsed: r.totalGasUsed,
      averageTotalGasUsed: r.averageTotalGasUsed,
      minTotalGasUsed: r.minTotalGasUsed,
      maxTotalGasUsed: r.maxTotalGasUsed,
      totalInputDataSizeBytes: r.totalInputDataSizeBytes,
      averageTotalInputDataSizeBytes: r.averageTotalInputDataSizeBytes,
      minTotalInputDataSizeBytes: r.minTotalInputDataSizeBytes,
      maxTotalInputDataSizeBytes: r.maxTotalInputDataSizeBytes,
      totalInputDataCompressedSizeBytes: r.totalInputDataCompressedSizeBytes,
      averageTotalInputDataCompressedSizeBytes: r.averageTotalInputDataCompressedSizeBytes,
      minTotalInputDataCompressedSizeBytes: r.minTotalInputDataCompressedSizeBytes,
      maxTotalInputDataCompressedSizeBytes: r.maxTotalInputDataCompressedSizeBytes,
      totalBlockRewardWei: r.totalBlockRewardWei,
      averageBlockRewardWei: r.averageBlockRewardWei,
      totalBurntFeesWei: r.totalBurntFeesWei,
      averageBurntFeesWei: r.averageBurntFeesWei,
      transactionCount: r.transactionCount,
      averageTransactionGasUsed: r.averageTransactionGasUsed,
      averageTransactionInputDataSizeBytes: r.averageTransactionInputDataSizeBytes,
      averageTransactionInputDataCompressedSizeBytes: r.averageTransactionInputDataCompressedSizeBytes,
      minBatcherQueueSize: r.minBatcherQueueSize,
      maxBatcherQueueSize: r.maxBatcherQueueSize,
      averageBatcherQueueSize: r.averageBatcherQueueSize,
      averageBatcherIntensity: r.averageBatcherIntensity,
      averageBatcherLowerThreshold: r.averageBatcherLowerThreshold,
      averageBatcherUpperThreshold: r.averageBatcherUpperThreshold,
      averageBatcherMaxBlockSize: r.averageBatcherMaxBlockSize,
      averageBatcherMaxTxSize: r.averageBatcherMaxTxSize,
    },
  };
}

function pointKey(point: ChartPoint): string {
  return `${point.rangeSize}:${point.rangeStart}:${point.rangeEnd}`;
}

function parameterGroupLabel(parameter: ParameterDef): string {
  if (parameter.axis === "gas-price") return "Gas price";
  if (parameter.axis === "block-time") return "Block time";
  if (parameter.axis === "block-gas-limit" || parameter.axis === "total-gas") return "Block gas";
  if (parameter.axis.includes("input-data")) return "Data size";
  if (parameter.axis.includes("reward") || parameter.axis.includes("burnt")) return "Rewards";
  if (parameter.axis === "tx-count" || parameter.axis.startsWith("avg-tx-")) return "Transactions";
  if (parameter.axis === "batcher") return "Batcher";
  return "Other";
}

function groupParameters(parameters: readonly ParameterDef[]): ParameterGroup[] {
  const groups = new Map<string, ParameterGroup>();
  for (const parameter of parameters) {
    const label = parameterGroupLabel(parameter);
    const key = label.toLowerCase().replace(/\s+/g, "-");
    const group = groups.get(key);
    if (group) {
      group.parameters.push(parameter);
    } else {
      groups.set(key, { key, label, parameters: [parameter] });
    }
  }
  return [...groups.values()];
}

export function ChartsView({
  locationSearch,
  onLocationChange,
  timeZone,
  transactionDataEnabled,
  tokenSymbol,
  noBatcher,
  presentationMode = "standard",
}: ChartsViewProps) {
  const [filters, setFilters] = useState<ChartsFilters>(() => loadFilters(locationSearch));
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => loadSidebarCollapsed());
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);

  const zoomIndex = clampZoomIndex(filters.zoom);
  const pointCount = parseChartPointCount(filters.points);
  const xAxisMode = parseXAxisMode(filters.xAxisMode);
  const isRangeMode = zoomIndex > 0;
  const availableParameters = useMemo(
    () => filterParametersForRangeMode(getAvailableParameters(noBatcher), isRangeMode),
    [noBatcher, isRangeMode],
  );
  const parameterGroups = useMemo(() => groupParameters(availableParameters), [availableParameters]);
  const selected = useMemo(
    () => parseSelectedParameters(filters.parameters, availableParameters),
    [filters.parameters, availableParameters],
  );
  const startDate = filters.startDate.trim();
  const blockWindow = useMemo(() => parseBlockWindow(filters), [filters]);
  const activeBlockWindow = zoomIndex === 0 ? blockWindow : null;
  const routeView: View = presentationMode === "fullscreen" ? "chart-fullscreen" : "charts";

  const load = useCallback((f: ChartsFilters) => {
    const idx = clampZoomIndex(f.zoom);
    const lvl = ZOOM_LEVELS[idx];
    const requestedPoints = parseChartPointCount(f.points);
    const anchor = normalizeIsoDate(f.startDate);
    const blockRange = parseBlockWindow(f);
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();

    if (lvl.rangeSize === 1) {
      if (blockRange) {
        const blockCount = blockRange.end - blockRange.start + 1;
        params.set("limit", String(chartRequestLimit(requestedPoints, blockCount)));
        params.set("order", "asc");
        if (blockRange.start > 0) params.set("blockGt", String(blockRange.start - 1));
        params.set("blockLt", String(blockRange.end + 1));
      } else {
        params.set("limit", String(chartRequestLimit(requestedPoints)));
        params.set("order", "desc");
        if (anchor) params.set("dateLt", anchor);
      }

      fetchBlocks(params)
        .then((body) => {
          const pts = body.blocks
            .slice()
            .sort((a, b) => a.blockNumber - b.blockNumber)
            .map(blockToPoint);
          setPoints(pts);
        })
        .catch((err: Error) => {
          setPoints([]);
          setError(err.message);
        })
        .finally(() => setLoading(false));
    } else {
      params.set("limit", String(chartRequestLimit(requestedPoints)));
      params.set("order", "desc");
      if (anchor) params.set("dateLt", anchor);
      params.set("rangeSize", String(lvl.rangeSize));
      fetchRanges(params)
        .then((body) => {
          const pts = body.ranges
            .slice()
            .sort((a, b) => a.rangeStart - b.rangeStart)
            .map(rangeToPoint);
          setPoints(pts);
        })
        .catch((err: Error) => {
          setPoints([]);
          setError(err.message);
        })
        .finally(() => setLoading(false));
    }
  }, []);

  const updateFilters = useCallback(
    (next: ChartsFilters) => {
      setFilters(next);
      if (writePermalink(routeView, next)) {
        onLocationChange();
      }
    },
    [onLocationChange, routeView, setFilters],
  );

  useEffect(() => {
    load(filters);
  }, [filters.zoom, filters.points, filters.startDate, filters.blockStart, filters.blockEnd, load]);

  useEffect(() => {
    if (filtersEqual(filters, DEFAULT_FILTERS, FILTER_KEYS)) {
      removeStoredValue(FILTERS_STORAGE_KEY);
      return;
    }
    writeStoredStringRecord(FILTERS_STORAGE_KEY, filters, FILTER_KEYS);
  }, [filters]);

  useEffect(() => {
    if (sidebarCollapsed) {
      writeStoredString(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
      return;
    }
    removeStoredValue(SIDEBAR_COLLAPSED_STORAGE_KEY);
  }, [sidebarCollapsed]);

  useEffect(() => {
    const next = loadFilters(locationSearch);
    setFilters((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setCopyStatus("");
  }, [locationSearch, setFilters]);

  useEffect(() => {
    const normalizedParameters = selected.join(",");
    if (filters.parameters === normalizedParameters) return;
    updateFilters({ ...filters, parameters: normalizedParameters });
  }, [filters, selected, updateFilters]);

  useEffect(() => {
    if (selectedPointKey !== null && !points.some((point) => pointKey(point) === selectedPointKey)) {
      setSelectedPointKey(null);
    }
  }, [points, selectedPointKey]);

  const setZoomIndex = (next: number) => {
    const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, next));
    if (clamped === zoomIndex) return;
    updateFilters(clearBlockWindow({ ...filters, zoom: String(clamped) }));
  };

  const setPointCount = (next: number) => {
    const normalized = normalizeChartPointCount(String(next));
    if (normalized === filters.points) return;
    updateFilters({ ...filters, points: normalized });
  };

  const panTime = (deltaMs: number) => {
    let anchorMs: number;
    if (startDate) {
      const parsed = Date.parse(startDate);
      if (!Number.isFinite(parsed)) return;
      anchorMs = parsed;
    } else if (points.length > 0) {
      const last = Date.parse(points[points.length - 1].midDate);
      if (!Number.isFinite(last)) return;
      anchorMs = last;
    } else {
      anchorMs = Date.now();
    }

    const nowMs = Date.now();
    const nextMs = anchorMs + deltaMs;
    if (nextMs >= nowMs) {
      if (!startDate) return;
      updateFilters(clearBlockWindow({ ...filters, startDate: "" }));
      return;
    }
    updateFilters(clearBlockWindow({ ...filters, startDate: new Date(nextMs).toISOString() }));
  };

  const goLatest = () => {
    if (!startDate && !activeBlockWindow) return;
    updateFilters(clearBlockWindow({ ...filters, startDate: "" }));
  };

  const toggleParameter = (key: string) => {
    const set = new Set(selected);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    const next = availableParameters.filter((p) => set.has(p.key)).map((p) => p.key);
    updateFilters({ ...filters, parameters: next.join(",") });
  };

  const setXAxisMode = (next: XAxisMode) => {
    if (next === xAxisMode) return;
    updateFilters({ ...filters, xAxisMode: next });
  };

  const resetChartSettings = () => {
    removeStoredSection(STORAGE_SECTION);
    setSidebarCollapsed(false);
    setSelectedPointKey(null);
    setCopyStatus("");
    setFilters(DEFAULT_FILTERS);
    if (writePermalink(routeView, {})) {
      onLocationChange();
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("charts", filters);
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const fullscreenHref = useMemo(
    () => buildPermalinkHref("chart-fullscreen", filters),
    [filters],
  );

  const selectedPoint = useMemo(
    () => points.find((point) => pointKey(point) === selectedPointKey) ?? null,
    [points, selectedPointKey],
  );

  const handlePlotClick = useCallback(
    (event: Readonly<Plotly.PlotMouseEvent>) => {
      const clicked = event.points[0];
      const index = clicked?.pointIndex;
      if (typeof index !== "number") return;
      const point = points[index];
      if (!point) return;
      setSelectedPointKey(pointKey(point));
    },
    [points],
  );

  const zoomToSelectedRange = () => {
    if (!selectedPoint || selectedPoint.rangeSize === 1) return;
    updateFilters({
      ...filters,
      zoom: "0",
      startDate: "",
      blockStart: String(selectedPoint.rangeStart),
      blockEnd: String(selectedPoint.rangeEnd),
    });
  };

  const inspectSelectedBlock = () => {
    if (!selectedPoint || selectedPoint.rangeSize !== 1) return;
    if (writePermalink("transactions", { block: String(selectedPoint.rangeStart) })) {
      onLocationChange();
    }
  };

  const { traces, layout } = useMemo(
    () => buildPlot(points, selected, selectedPoint, timeZone, xAxisMode, tokenSymbol, availableParameters),
    [points, selected, selectedPoint, timeZone, xAxisMode, tokenSymbol, availableParameters],
  );
  const chartConfig = useMemo(
    () => ({
      displaylogo: false,
      responsive: true,
      ...(presentationMode === "fullscreen" ? { displayModeBar: false } : {}),
    }),
    [presentationMode],
  );

  const chartContent = error ? (
    <div className="chart-empty">Failed: {error}</div>
  ) : selected.length === 0 ? (
    <div className="chart-empty">Select at least one parameter to plot.</div>
  ) : points.length === 0 && !loading ? (
    <div className="chart-empty">No data in the selected window.</div>
  ) : (
    <Plot
      data={traces}
      layout={layout}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
      config={chartConfig}
      onClick={presentationMode === "fullscreen" ? undefined : handlePlotClick}
    />
  );

  const windowInfo = useMemo(() => {
    if (points.length === 0) return null;
    return {
      first: points[0].rangeStart,
      last: points[points.length - 1].rangeEnd,
      firstDate: points[0].midDate,
      lastDate: points[points.length - 1].midDate,
    };
  }, [points]);

  if (presentationMode === "fullscreen") {
    return (
      <section className="view charts-view chart-only-view">
        <div className="chart-only-frame">{chartContent}</div>
      </section>
    );
  }

  return (
    <section className={`view charts-view${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <div className="charts-layout">
        {sidebarCollapsed ? (
          <button
            type="button"
            className="sidebar-show"
            onClick={() => setSidebarCollapsed(false)}
            title="Show options"
            aria-label="Show options"
          >
            »
          </button>
        ) : (
          <aside className="charts-sidebar">
            <div className="sidebar-header">
              <h2>History charts</h2>
              <button
                type="button"
                className="sidebar-hide"
                onClick={() => setSidebarCollapsed(true)}
                title="Hide options"
                aria-label="Hide options"
              >
                «
              </button>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">Pan window</span>
              <div className="time-nav-grid">
                {TIME_STEPS.map((s) => (
                  <button
                    key={`back-${s.label}`}
                    type="button"
                    className="secondary time-nav-btn"
                    onClick={() => panTime(-s.ms)}
                    title={`Go back ${s.label}`}
                  >
                    −{s.label}
                  </button>
                ))}
                {TIME_STEPS.slice().reverse().map((s) => (
                  <button
                    key={`fwd-${s.label}`}
                    type="button"
                    className="secondary time-nav-btn"
                    onClick={() => panTime(s.ms)}
                    disabled={!startDate && !activeBlockWindow}
                    title={startDate || activeBlockWindow ? `Go forward ${s.label}` : "Already at latest"}
                  >
                    +{s.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="secondary latest-btn"
                onClick={goLatest}
                disabled={!startDate && !activeBlockWindow}
                title={startDate || activeBlockWindow ? "Jump to latest" : "Already at latest"}
              >
                ⤓ Jump to latest
              </button>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">Zoom (range size)</span>
              <div className="zoom-buttons">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setZoomIndex(zoomIndex - 1)}
                  disabled={zoomIndex === 0}
                  title="Zoom in (smaller range size)"
                >
                  −
                </button>
                <div className="zoom-options">
                  {ZOOM_LEVELS.map((z, i) => (
                    <button
                      type="button"
                      key={z.rangeSize}
                      className={`zoom-pill${i === zoomIndex ? " active" : ""}`}
                      onClick={() => setZoomIndex(i)}
                    >
                      {z.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setZoomIndex(zoomIndex + 1)}
                  disabled={zoomIndex === ZOOM_LEVELS.length - 1}
                  title="Zoom out (larger range size)"
                >
                  +
                </button>
              </div>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">Points</span>
              <div className="point-count-toggle" role="group" aria-label="Chart point count">
                {CHART_POINT_COUNT_OPTIONS.map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={pointCount === count ? "active" : ""}
                    onClick={() => setPointCount(count)}
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">X axis</span>
              <div className="axis-mode-toggle" role="group" aria-label="X axis mode">
                {X_AXIS_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={xAxisMode === mode.value ? "active" : ""}
                    onClick={() => setXAxisMode(mode.value)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">Anchor</span>
              <div className="anchor-info">
                {activeBlockWindow
                  ? `Blocks ${activeBlockWindow.start}–${activeBlockWindow.end}`
                  : startDate
                    ? fmtShortDate(startDate, timeZone)
                    : "Latest"}
              </div>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">Status</span>
              <div className="charts-status">
                {loading
                  ? "Loading…"
                  : error
                    ? <span className="error">Failed: {error}</span>
                    : windowInfo
                      ? (
                        <>
                          {points.length} pts · blocks {windowInfo.first}–{windowInfo.last}
                          <br />
                          {fmtShortDate(windowInfo.firstDate, timeZone)} → {fmtShortDate(windowInfo.lastDate, timeZone)}
                        </>
                      )
                      : "No data"}
              </div>
            </div>

            <div className="sidebar-section">
              <span className="toolbar-label">Parameters</span>
              <div className="parameter-groups">
                {parameterGroups.map((group) => (
                  <div key={group.key} className="parameter-group">
                    <span className="parameter-group-title">{group.label}</span>
                    <div className="parameters-grid sidebar-params">
                      {group.parameters.map((p) => {
                        const isOn = selected.includes(p.key);
                        return (
                          <label key={p.key} className={`param-check${isOn ? " on" : ""}`}>
                            <input
                              type="checkbox"
                              checked={isOn}
                              onChange={() => toggleParameter(p.key)}
                            />
                            <span className="param-swatch" style={{ background: isOn ? p.color : "transparent", borderColor: p.color }} />
                            <span className="param-label">{p.label}</span>
                            <span className="param-unit">{displayUnit(p.unit, tokenSymbol)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="sidebar-section">
              <div className="chart-link-actions">
                <button type="button" className="secondary" onClick={copyPermalink}>
                  Copy link
                </button>
                <a
                  className="secondary-link"
                  href={fullscreenHref}
                  target="_blank"
                  rel="noreferrer"
                  title="Open chart-only permalink in a new tab"
                >
                  Fullscreen chart
                </a>
                <button type="button" className="secondary" onClick={resetChartSettings}>
                  Reset to defaults
                </button>
              </div>
              {copyStatus ? <span className="copy-status">{copyStatus}</span> : null}
            </div>
          </aside>
        )}

        <div className="chart-area">
          <div className="chart-card">
            {chartContent}
          </div>
        </div>
        <aside className="selection-panel">
          <div className="selection-header">
            <h2>Selection</h2>
            <div className="selection-actions">
              <button
                type="button"
                className="secondary"
                onClick={zoomToSelectedRange}
                disabled={!selectedPoint || selectedPoint.rangeSize === 1}
                title={
                  selectedPoint
                    ? selectedPoint.rangeSize === 1
                      ? "Blocks cannot be zoomed further"
                      : "Zoom to this range and show blocks"
                    : "Select a chart point first"
                }
              >
                Zoom to range
              </button>
              {transactionDataEnabled ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={inspectSelectedBlock}
                  disabled={!selectedPoint || selectedPoint.rangeSize !== 1}
                  title={
                    selectedPoint
                      ? selectedPoint.rangeSize === 1
                        ? "Inspect this block"
                        : "Zoom to blocks before inspecting one block"
                      : "Select a chart point first"
                  }
                >
                  Inspect block
                </button>
              ) : null}
            </div>
          </div>
          {selectedPoint ? (
            <SelectionDetails
              point={selectedPoint}
              selectedKeys={selected}
              timeZone={timeZone}
              tokenSymbol={tokenSymbol}
              availableParameters={availableParameters}
            />
          ) : (
            <div className="selection-empty">Click a chart point to view block or range details.</div>
          )}
        </aside>
      </div>
    </section>
  );
}

function fmtShortDate(value: string, timeZone = "UTC"): string {
  return fmtDate(value, timeZone);
}

interface PlotBuildResult {
  traces: Partial<Plotly.PlotData>[];
  layout: Partial<Plotly.Layout>;
}

function buildPlot(
  points: ChartPoint[],
  selectedKeys: string[],
  selectedPoint: ChartPoint | null,
  timeZone: string,
  xAxisMode: XAxisMode,
  tokenSymbol: string,
  availableParameters: readonly ParameterDef[],
): PlotBuildResult {
  const activeParams = availableParameters.filter((p) => selectedKeys.includes(p.key));

  const usedAxes: { axis: string; axisLabel: string }[] = [];
  for (const p of activeParams) {
    if (!usedAxes.find((a) => a.axis === p.axis)) {
      usedAxes.push({ axis: p.axis, axisLabel: displayAxisLabel(p.axisLabel, tokenSymbol) });
    }
  }

  const axisRef: Record<string, string> = {};
  usedAxes.forEach((a, i) => {
    axisRef[a.axis] = i === 0 ? "y" : `y${i + 1}`;
  });

  const xs = points.map((pt) => getPointXValue(pt, xAxisMode));
  const customdata = points.map(
    (pt) => [pt.rangeStart, pt.rangeEnd, fmtShortDate(pt.midDate, timeZone)] as [number, number, string],
  );

  const traces: Partial<Plotly.PlotData>[] = activeParams.flatMap((p) => {
    const yaxis = axisRef[p.axis];
    const avgTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines+markers",
      name: p.label,
      x: xs,
      y: points.map((pt) => p.toNumber(pt.values[p.key])) as number[],
      yaxis,
      line: { color: p.color, width: 1.5 },
      marker: { color: p.color, size: 5 },
      customdata: customdata as unknown as Plotly.Datum[],
      hovertemplate:
        `<b>${p.label}</b><br>` +
        "date %{customdata[2]}<br>" +
        "blocks %{customdata[0]}–%{customdata[1]}<br>" +
        `%{y:.4~f} ${displayUnit(p.unit, tokenSymbol)}<extra></extra>`,
    };

    if (!p.band) {
      return [avgTrace];
    }

    // Render a min/max band (filled area) with the average line on top,
    // mirroring the home view's MinAvgMaxPanel. `fill: "tonexty"` on the min
    // trace fills the gap down to the immediately-preceding max trace.
    const band = p.band;
    const bandFill = withAlpha(p.color, 0.18);
    const bandLine = withAlpha(p.color, 0.5);
    const maxTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines",
      name: `${p.label} max`,
      x: xs,
      y: points.map((pt) => p.toNumber(pt.values[band.maxKey])) as number[],
      yaxis,
      connectgaps: true,
      line: { color: bandLine, width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    };
    const minTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines",
      name: `${p.label} min`,
      x: xs,
      y: points.map((pt) => p.toNumber(pt.values[band.minKey])) as number[],
      yaxis,
      connectgaps: true,
      fill: "tonexty",
      fillcolor: bandFill,
      line: { color: bandLine, width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    };
    return [maxTrace, minTrace, avgTrace];
  });

  const sideAxisCount = Math.max(0, usedAxes.length - 1);
  const rightSideCount = Math.ceil(sideAxisCount / 2);
  const leftSideCount = sideAxisCount - rightSideCount;
  const sidePad = 0.06;
  const domainStart = leftSideCount * sidePad;
  const domainEnd = 1 - rightSideCount * sidePad;
  const xRange = getPlotXRange(points, xAxisMode);

  const layout: Partial<Plotly.Layout> = {
    autosize: true,
    margin: { l: 60, r: 60, t: 30, b: 50 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: getCssColor("--fg", "#1a1d23") },
    legend: {
      orientation: "h",
      yanchor: "bottom",
      y: 1.02,
      x: 0,
    },
    hovermode: "x unified",
    xaxis: {
      type: xAxisMode === "dates" ? "date" : "linear",
      title: { text: xAxisMode === "dates" ? "Date" : "Block range" } as Plotly.DataTitle,
      domain: [domainStart, domainEnd],
      range: xRange,
      gridcolor: getCssColor("--border", "#d6d9df"),
      zerolinecolor: getCssColor("--border", "#d6d9df"),
    },
  };

  if (selectedPoint) {
    const [selectedStart, selectedEnd] = getSelectionXRange(selectedPoint, xAxisMode);
    layout.shapes = [
      {
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: selectedStart,
        x1: selectedEnd,
        y0: 0,
        y1: 1,
        fillcolor: "rgba(46, 99, 216, 0.14)",
        line: { color: getCssColor("--accent", "#2e63d8"), width: 1 },
        layer: "below",
      },
    ];
  }

  let leftIdx = 0;
  let rightIdx = 0;
  usedAxes.forEach((a, i) => {
    const refKey = i === 0 ? "yaxis" : `yaxis${i + 1}`;
    const baseAxis: Partial<Plotly.LayoutAxis> = {
      title: { text: a.axisLabel } as Plotly.DataTitle,
      gridcolor: getCssColor("--border", "#d6d9df"),
      zerolinecolor: getCssColor("--border", "#d6d9df"),
    };

    if (i === 0) {
      (layout as Record<string, unknown>)[refKey] = baseAxis;
      return;
    }

    const sideIsRight = i % 2 === 1;
    const axisOverlay: Partial<Plotly.LayoutAxis> = {
      ...baseAxis,
      overlaying: "y" as never,
      side: sideIsRight ? "right" : "left",
    };

    if (sideIsRight) {
      axisOverlay.anchor = rightIdx === 0 ? ("x" as never) : "free";
      axisOverlay.position = 1 - rightIdx * sidePad;
      rightIdx++;
    } else {
      axisOverlay.anchor = "free";
      axisOverlay.position = leftIdx * sidePad;
      leftIdx++;
    }

    (layout as Record<string, unknown>)[refKey] = axisOverlay;
  });

  return { traces, layout };
}

function getPointXValue(point: ChartPoint, xAxisMode: XAxisMode): number | string {
  return xAxisMode === "dates" ? point.midDate : point.midBlock;
}

function getPlotXRange(points: ChartPoint[], xAxisMode: XAxisMode): [number, number] | [string, string] | undefined {
  if (points.length === 0) return undefined;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return undefined;
  if (xAxisMode === "dates") {
    const start = Date.parse(first.startDate);
    const end = Date.parse(last.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
    if (start === end) {
      return [
        new Date(start - 30_000).toISOString(),
        new Date(end + 30_000).toISOString(),
      ];
    }
    return [new Date(start).toISOString(), new Date(end).toISOString()];
  }
  if (first.rangeStart === last.rangeEnd) {
    return [first.rangeStart - 0.5, last.rangeEnd + 0.5];
  }
  return [first.rangeStart, last.rangeEnd];
}

function getSelectionXRange(point: ChartPoint, xAxisMode: XAxisMode): [number, number] | [string, string] {
  if (xAxisMode === "blocks") {
    const selectedStart = point.rangeSize === 1 ? point.rangeStart - 0.5 : point.rangeStart;
    const selectedEnd = point.rangeSize === 1 ? point.rangeEnd + 0.5 : point.rangeEnd;
    return [selectedStart, selectedEnd];
  }

  const start = Date.parse(point.startDate);
  const end = Date.parse(point.endDate);
  const mid = Date.parse(point.midDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    const fallback = Number.isFinite(mid) ? mid : Date.now();
    return [
      new Date(fallback - 30_000).toISOString(),
      new Date(fallback + 30_000).toISOString(),
    ];
  }
  if (start === end) {
    return [
      new Date(start - 30_000).toISOString(),
      new Date(end + 30_000).toISOString(),
    ];
  }
  return [new Date(start).toISOString(), new Date(end).toISOString()];
}

function SelectionDetails({
  point,
  selectedKeys,
  timeZone,
  tokenSymbol,
  availableParameters,
}: {
  point: ChartPoint;
  selectedKeys: string[];
  timeZone: string;
  tokenSymbol: string;
  availableParameters: readonly ParameterDef[];
}) {
  const activeParams = availableParameters.filter((p) => selectedKeys.includes(p.key));
  return (
    <div className="selection-content">
      <dl className="selection-meta">
        <div>
          <dt>Type</dt>
          <dd>{point.rangeSize === 1 ? "Block" : "Range"}</dd>
        </div>
        <div>
          <dt>Blocks</dt>
          <dd>{point.rangeStart === point.rangeEnd ? point.rangeStart : `${point.rangeStart}–${point.rangeEnd}`}</dd>
        </div>
        <div>
          <dt>Range size</dt>
          <dd>{point.rangeSize}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{fmtShortDate(point.midDate, timeZone)}</dd>
        </div>
      </dl>

      <div className="selection-metrics">
        <span className="toolbar-label">Selected metrics</span>
        {activeParams.length === 0 ? (
          <div className="selection-empty compact">No active metrics.</div>
        ) : (
          activeParams.map((param) => (
            <div key={param.key} className="selection-metric-row">
              <span className="param-swatch" style={{ background: param.color, borderColor: param.color }} />
              <span className="selection-metric-label">{param.label}</span>
              <span className="selection-metric-value">{formatMetricValue(param, point, tokenSymbol)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatParamNumber(param: ParameterDef, value: number): string {
  if (param.unit === "gwei") {
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (param.unit === "ETH") {
    return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }
  if (param.unit === "gas" || param.unit === "count") {
    return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  return value.toLocaleString();
}

function formatMetricValue(param: ParameterDef, point: ChartPoint, tokenSymbol: string): string {
  const value = param.toNumber(point.values[param.key]);
  if (value === null || !Number.isFinite(value)) return "—";

  const unit = displayUnit(param.unit, tokenSymbol);
  const avg = `${formatParamNumber(param, value)} ${unit}`;
  if (!param.band) return avg;

  const min = param.toNumber(point.values[param.band.minKey]);
  const max = param.toNumber(point.values[param.band.maxKey]);
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max)) {
    return avg;
  }
  return `${avg} (${formatParamNumber(param, min)}–${formatParamNumber(param, max)})`;
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length !== 6) return color;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((c) => Number.isNaN(c))) return color;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function displayUnit(unit: string, tokenSymbol: string): string {
  return unit === "ETH" ? tokenSymbol : unit;
}

function displayAxisLabel(axisLabel: string, tokenSymbol: string): string {
  return axisLabel.replace("(ETH)", `(${tokenSymbol})`);
}

function getCssColor(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
