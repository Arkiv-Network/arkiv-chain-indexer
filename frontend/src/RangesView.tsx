import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchRanges, type RangesResponse, type StoredBlockRange } from "./api";
import { fmtDate, fmtGwei, fmtRatio } from "./format";
import {
  buildPermalinkHref,
  filtersEqual,
  hasAnyFilterParam,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import { loadFromStorage, usePersistentState } from "./persistentState";

interface RangesViewProps {
  locationSearch: string;
  onLocationChange: () => void;
}

interface Filters extends Record<string, string> {
  rangeSize: string;
  rangeStartGt: string;
  rangeStartLt: string;
  dateGt: string;
  dateLt: string;
  limit: string;
}

const RANGE_SIZES = ["2", "5", "10", "20", "50", "100", "200", "500", "1000"];
const LIMIT_OPTIONS = ["100", "250", "500", "1000", "2500", "5000", "10000"];
const STORAGE_KEY = "gas-tracker.filters.ranges";
const FILTER_KEYS = ["rangeSize", "rangeStartGt", "rangeStartLt", "dateGt", "dateLt", "limit"] as const;
const EMPTY: Filters = {
  rangeSize: "100",
  rangeStartGt: "",
  rangeStartLt: "",
  dateGt: "",
  dateLt: "",
  limit: "1000",
};

interface Column<T> {
  key: string;
  label: string;
  className?: string;
  width: string;
  render: (row: T) => ReactNode;
}

const RANGE_COLUMNS: Column<StoredBlockRange>[] = [
  {
    key: "rangeSize",
    label: "Range size",
    className: "num",
    width: "7rem",
    render: (row) => row.rangeSize,
  },
  {
    key: "rangeStart",
    label: "Start",
    className: "num",
    width: "7.5rem",
    render: (row) => row.rangeStart,
  },
  {
    key: "rangeEnd",
    label: "End",
    className: "num",
    width: "7.5rem",
    render: (row) => row.rangeEnd,
  },
  {
    key: "minBlockDate",
    label: "Min date",
    width: "12.5rem",
    render: (row) => fmtDate(row.minBlockDate),
  },
  {
    key: "maxBlockDate",
    label: "Max date",
    width: "12.5rem",
    render: (row) => fmtDate(row.maxBlockDate),
  },
  {
    key: "averageBaseFeeWei",
    label: "Avg base fee (gwei)",
    className: "num",
    width: "11rem",
    render: (row) => fmtGwei(row.averageBaseFeeWei),
  },
  {
    key: "averagePriorityFeeWei",
    label: "Avg priority fee (gwei)",
    className: "num",
    width: "11rem",
    render: (row) => fmtGwei(row.averagePriorityFeeWei),
  },
  {
    key: "averagePriorityFeeWeightedWei",
    label: "Weighted avg priority (gwei)",
    className: "num",
    width: "13rem",
    render: (row) => fmtGwei(row.averagePriorityFeeWeightedWei),
  },
  {
    key: "transactionCount",
    label: "Tx count",
    className: "num",
    width: "7rem",
    render: (row) => row.transactionCount,
  },
  {
    key: "gasUsed",
    label: "Gas used / total max",
    className: "num",
    width: "16rem",
    render: (row) => fmtRatio(row.totalGasUsed, row.totalMaxGas),
  },
];

function buildParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    const trimmed = v.trim();
    if (trimmed) params.set(k, trimmed);
  }
  return params;
}

function loadFilters(locationSearch: string): Filters {
  const stored = loadFromStorage<Filters>(STORAGE_KEY, EMPTY);
  const fallback = hasAnyFilterParam(locationSearch, FILTER_KEYS) ? EMPTY : stored;
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, fallback);
}

export function RangesView({ locationSearch, onLocationChange }: RangesViewProps) {
  const [filters, setFilters] = usePersistentState<Filters>(STORAGE_KEY, loadFilters(locationSearch));
  const [applied, setApplied] = useState<Filters>(filters);
  const [data, setData] = useState<RangesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const load = useCallback((f: Filters) => {
    setLoading(true);
    setError(null);
    fetchRanges(buildParams(f))
      .then((body) => setData(body))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(applied);
  }, [applied, load]);

  useEffect(() => {
    const next = loadFilters(locationSearch);
    setFilters((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setApplied((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setCopyStatus("");
  }, [locationSearch, setFilters]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (writePermalink("ranges", filters)) {
      onLocationChange();
    } else {
      setApplied(filters);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("ranges", applied);
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const onTextChange = (key: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const onSelectChange = (key: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const sorted = data
    ? data.ranges.slice().sort((a, b) => b.rangeStart - a.rangeStart)
    : [];

  return (
    <section className="view">
      <h2>Aggregated ranges</h2>
      <form onSubmit={onSubmit}>
        <label>
          rangeSize
          <select value={filters.rangeSize} onChange={onSelectChange("rangeSize")}>
            {RANGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          rangeStartGt
          <input
            type="text"
            inputMode="numeric"
            value={filters.rangeStartGt}
            onChange={onTextChange("rangeStartGt")}
          />
        </label>
        <label>
          rangeStartLt
          <input
            type="text"
            inputMode="numeric"
            value={filters.rangeStartLt}
            onChange={onTextChange("rangeStartLt")}
          />
        </label>
        <label>
          dateGt (ISO)
          <input
            type="text"
            placeholder="2024-01-01T00:00:00Z"
            value={filters.dateGt}
            onChange={onTextChange("dateGt")}
          />
        </label>
        <label>
          dateLt (ISO)
          <input
            type="text"
            placeholder="2024-12-31T00:00:00Z"
            value={filters.dateLt}
            onChange={onTextChange("dateLt")}
          />
        </label>
        <label>
          limit
          <select value={filters.limit} onChange={onSelectChange("limit")}>
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading…"
          : error
            ? `Failed to load ranges: ${error}`
            : data
              ? `${data.count} ranges${data.truncated ? ` (truncated to ${data.limit})` : ""}`
              : ""}
      </p>
      <div className="permalink-row">
        <button type="button" className="secondary" onClick={copyPermalink}>
          Copy link
        </button>
        {copyStatus ? <span>{copyStatus}</span> : null}
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <colgroup>
            {RANGE_COLUMNS.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {RANGE_COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={`${row.rangeSize}-${row.rangeStart}`}>
                {RANGE_COLUMNS.map((column) => (
                  <td key={column.key} className={column.className} data-label={column.label}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
