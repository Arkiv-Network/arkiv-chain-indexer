import { useCallback, useEffect, useMemo, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
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

const Plot = createPlotlyComponent(Plotly);

interface ChartsViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  transactionDataEnabled: boolean;
  tokenSymbol: string;
}

interface ChartsFilters extends Record<string, string> {
  zoom: string;
  startDate: string;
  blockStart: string;
  blockEnd: string;
  xAxisMode: string;
  parameters: string;
}

const FETCH_LIMIT = 1000;
const FILTER_KEYS = ["zoom", "startDate", "blockStart", "blockEnd", "xAxisMode", "parameters"] as const;
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

const GWEI_IN_WEI = 1_000_000_000;
const ETH_IN_WEI = 1_000_000_000_000_000_000;

const AXIS_GAS_PRICE = "gas-price";
const AXIS_BLOCK_GAS_LIMIT = "block-gas-limit";
const AXIS_BATCHER = "batcher";

interface ParameterDef {
  key: string;
  label: string;
  axis: string;
  axisLabel: string;
  unit: string;
  color: string;
  toNumber: (value: string | number | undefined | null) => number | null;
}

const weiToGwei = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  try {
    const wei = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
    const whole = Number(wei / BigInt(GWEI_IN_WEI));
    const rem = Number(wei % BigInt(GWEI_IN_WEI)) / GWEI_IN_WEI;
    return whole + rem;
  } catch {
    return null;
  }
};

const weiToEth = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  try {
    const wei = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
    const whole = Number(wei / BigInt(ETH_IN_WEI));
    const rem = Number(wei % BigInt(ETH_IN_WEI)) / ETH_IN_WEI;
    return whole + rem;
  } catch {
    return null;
  }
};

const plainNumber = (value: string | number | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  try {
    if (typeof value === "number") return value;
    return Number(BigInt(value));
  } catch {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
};

const PARAMETERS: ParameterDef[] = [
  {
    key: "averageBaseFeeWei",
    label: "Avg base fee",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#2e63d8",
    toNumber: weiToGwei,
  },
  {
    key: "minBaseFeeWei",
    label: "Min base fee",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#54a0ff",
    toNumber: weiToGwei,
  },
  {
    key: "maxBaseFeeWei",
    label: "Max base fee",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#0a3d91",
    toNumber: weiToGwei,
  },
  {
    key: "averageFeePriceWei",
    label: "Avg fee price",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#16a085",
    toNumber: weiToGwei,
  },
  {
    key: "averagePriorityFeeWei",
    label: "Avg priority fee",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#e67e22",
    toNumber: weiToGwei,
  },
  {
    key: "averagePriorityFeeWeightedWei",
    label: "Gas-weighted priority",
    axis: AXIS_GAS_PRICE,
    axisLabel: "Gas price (gwei)",
    unit: "gwei",
    color: "#d35400",
    toNumber: weiToGwei,
  },
  {
    key: "minMaxGasInBlock",
    label: "Min block gas limit",
    axis: AXIS_BLOCK_GAS_LIMIT,
    axisLabel: "Block gas limit",
    unit: "gas",
    color: "#7f8c8d",
    toNumber: plainNumber,
  },
  {
    key: "maxMaxGasInBlock",
    label: "Max block gas limit",
    axis: AXIS_BLOCK_GAS_LIMIT,
    axisLabel: "Block gas limit",
    unit: "gas",
    color: "#2c3e50",
    toNumber: plainNumber,
  },
  {
    key: "totalGasUsed",
    label: "Total gas used",
    axis: "total-gas",
    axisLabel: "Total gas used",
    unit: "gas",
    color: "#9b59b6",
    toNumber: plainNumber,
  },
  {
    key: "totalBlockRewardWei",
    label: "Total reward",
    axis: "total-reward-eth",
    axisLabel: "Total reward (ETH)",
    unit: "ETH",
    color: "#27ae60",
    toNumber: weiToEth,
  },
  {
    key: "averageBlockRewardWei",
    label: "Avg reward / block",
    axis: "avg-reward-eth",
    axisLabel: "Avg reward / block (ETH)",
    unit: "ETH",
    color: "#16a085",
    toNumber: weiToEth,
  },
  {
    key: "totalBurntFeesWei",
    label: "Total burnt",
    axis: "total-burnt-eth",
    axisLabel: "Total burnt (ETH)",
    unit: "ETH",
    color: "#c0392b",
    toNumber: weiToEth,
  },
  {
    key: "averageBurntFeesWei",
    label: "Avg burnt / block",
    axis: "avg-burnt-eth",
    axisLabel: "Avg burnt / block (ETH)",
    unit: "ETH",
    color: "#e74c3c",
    toNumber: weiToEth,
  },
  {
    key: "transactionCount",
    label: "Tx count",
    axis: "tx-count",
    axisLabel: "Tx count",
    unit: "count",
    color: "#8e44ad",
    toNumber: plainNumber,
  },
  {
    key: "averageTransactionGasUsed",
    label: "Avg tx gas",
    axis: "avg-tx-gas",
    axisLabel: "Avg tx gas",
    unit: "gas",
    color: "#34495e",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherQueueSize",
    label: "Batcher queue",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#b83280",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherIntensity",
    label: "Batcher intensity",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#6f42c1",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherLowerThreshold",
    label: "Batcher lower",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#0f766e",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherUpperThreshold",
    label: "Batcher upper",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "count",
    color: "#be123c",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherMaxBlockSize",
    label: "Batcher max block",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "gas",
    color: "#ca8a04",
    toNumber: plainNumber,
  },
  {
    key: "averageBatcherMaxTxSize",
    label: "Batcher max tx",
    axis: AXIS_BATCHER,
    axisLabel: "Batcher value",
    unit: "gas",
    color: "#475569",
    toNumber: plainNumber,
  },
];

const PARAMETER_KEYS = new Set(PARAMETERS.map((p) => p.key));
const DEFAULT_PARAMETERS = ["averageBaseFeeWei", "averagePriorityFeeWei"];

const DEFAULT_FILTERS: ChartsFilters = {
  zoom: "0",
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

function parseSelected(value: string): string[] {
  if (!value) return [...DEFAULT_PARAMETERS];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => PARAMETER_KEYS.has(s));
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
      averageFeePriceWei: b.averageFeePriceWei,
      averagePriorityFeeWei: b.averagePriorityFeeWei,
      averagePriorityFeeWeightedWei: b.averagePriorityFeeWeightedWei,
      minMaxGasInBlock: b.maxGasInBlock,
      maxMaxGasInBlock: b.maxGasInBlock,
      totalGasUsed: b.totalGasUsed,
      totalBlockRewardWei: b.blockRewardWei,
      averageBlockRewardWei: b.blockRewardWei,
      totalBurntFeesWei: b.burntFeesWei,
      averageBurntFeesWei: b.burntFeesWei,
      transactionCount: b.transactionCount,
      averageTransactionGasUsed: b.averageTransactionGasUsed,
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
      averageFeePriceWei: r.averageFeePriceWei,
      averagePriorityFeeWei: r.averagePriorityFeeWei,
      averagePriorityFeeWeightedWei: r.averagePriorityFeeWeightedWei,
      minMaxGasInBlock: r.minMaxGasInBlock,
      maxMaxGasInBlock: r.maxMaxGasInBlock,
      totalGasUsed: r.totalGasUsed,
      totalBlockRewardWei: r.totalBlockRewardWei,
      averageBlockRewardWei: r.averageBlockRewardWei,
      totalBurntFeesWei: r.totalBurntFeesWei,
      averageBurntFeesWei: r.averageBurntFeesWei,
      transactionCount: r.transactionCount,
      averageTransactionGasUsed: r.averageTransactionGasUsed,
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

export function ChartsView({
  locationSearch,
  onLocationChange,
  timeZone,
  transactionDataEnabled,
  tokenSymbol,
}: ChartsViewProps) {
  const [filters, setFilters] = useState<ChartsFilters>(() => loadFilters(locationSearch));
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => loadSidebarCollapsed());
  const [selectedPointKey, setSelectedPointKey] = useState<string | null>(null);

  const zoomIndex = clampZoomIndex(filters.zoom);
  const xAxisMode = parseXAxisMode(filters.xAxisMode);
  const selected = useMemo(() => parseSelected(filters.parameters), [filters.parameters]);
  const startDate = filters.startDate.trim();
  const blockWindow = useMemo(() => parseBlockWindow(filters), [filters]);
  const activeBlockWindow = zoomIndex === 0 ? blockWindow : null;

  const load = useCallback((f: ChartsFilters) => {
    const idx = clampZoomIndex(f.zoom);
    const lvl = ZOOM_LEVELS[idx];
    const anchor = normalizeIsoDate(f.startDate);
    const blockRange = parseBlockWindow(f);
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();

    if (lvl.rangeSize === 1) {
      if (blockRange) {
        const blockCount = blockRange.end - blockRange.start + 1;
        params.set("limit", String(Math.min(FETCH_LIMIT, blockCount)));
        params.set("order", "asc");
        if (blockRange.start > 0) params.set("blockGt", String(blockRange.start - 1));
        params.set("blockLt", String(blockRange.end + 1));
      } else {
        params.set("limit", String(FETCH_LIMIT));
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
      params.set("limit", String(FETCH_LIMIT));
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

  useEffect(() => {
    load(filters);
  }, [filters.zoom, filters.startDate, filters.blockStart, filters.blockEnd, load]);

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
    if (selectedPointKey !== null && !points.some((point) => pointKey(point) === selectedPointKey)) {
      setSelectedPointKey(null);
    }
  }, [points, selectedPointKey]);

  const updateFilters = useCallback(
    (next: ChartsFilters) => {
      setFilters(next);
      if (writePermalink("charts", next)) {
        onLocationChange();
      }
    },
    [onLocationChange, setFilters],
  );

  const setZoomIndex = (next: number) => {
    const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, next));
    if (clamped === zoomIndex) return;
    updateFilters(clearBlockWindow({ ...filters, zoom: String(clamped) }));
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
    const next = PARAMETERS.filter((p) => set.has(p.key)).map((p) => p.key);
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
    if (writePermalink("charts", {})) {
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
    () => buildPlot(points, selected, selectedPoint, timeZone, xAxisMode, tokenSymbol),
    [points, selected, selectedPoint, timeZone, xAxisMode, tokenSymbol],
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
              <div className="parameters-grid sidebar-params">
                {PARAMETERS.map((p) => {
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

            <div className="sidebar-section">
              <div className="chart-link-actions">
                <button type="button" className="secondary" onClick={copyPermalink}>
                  Copy link
                </button>
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
            {selected.length === 0 ? (
              <div className="chart-empty">Select at least one parameter in the sidebar to plot.</div>
            ) : points.length === 0 && !loading ? (
              <div className="chart-empty">No data in the selected window.</div>
            ) : (
              <Plot
                data={traces}
                layout={layout}
                useResizeHandler
                style={{ width: "100%", height: "100%" }}
                config={{ displaylogo: false, responsive: true }}
                onClick={handlePlotClick}
              />
            )}
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
): PlotBuildResult {
  const activeParams = PARAMETERS.filter((p) => selectedKeys.includes(p.key));

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

  const traces: Partial<Plotly.PlotData>[] = activeParams.map((p) => {
    const ys = points.map((pt) => p.toNumber(pt.values[p.key]));
    const trace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines+markers",
      name: p.label,
      x: xs,
      y: ys as number[],
      yaxis: axisRef[p.axis],
      line: { color: p.color, width: 1.5 },
      marker: { color: p.color, size: 5 },
      customdata: customdata as unknown as Plotly.Datum[],
      hovertemplate:
        `<b>${p.label}</b><br>` +
        "date %{customdata[2]}<br>" +
        "blocks %{customdata[0]}–%{customdata[1]}<br>" +
        `%{y:.4~f} ${displayUnit(p.unit, tokenSymbol)}<extra></extra>`,
    };
    return trace;
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
}: {
  point: ChartPoint;
  selectedKeys: string[];
  timeZone: string;
  tokenSymbol: string;
}) {
  const activeParams = PARAMETERS.filter((p) => selectedKeys.includes(p.key));
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

function formatMetricValue(param: ParameterDef, point: ChartPoint, tokenSymbol: string): string {
  const value = param.toNumber(point.values[param.key]);
  if (value === null || !Number.isFinite(value)) return "—";

  if (param.unit === "gwei") {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} gwei`;
  }
  if (param.unit === "ETH") {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${tokenSymbol}`;
  }
  if (param.unit === "gas" || param.unit === "count") {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${param.unit}`;
  }
  return `${value.toLocaleString()} ${param.unit}`;
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
