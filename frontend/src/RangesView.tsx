import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchRanges, type RangesResponse, type StoredBlockRange } from "./api";
import { fmtBytes, fmtDate, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import {
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import {
  readStoredString,
  readStoredStringRecord,
  writeStoredString,
  writeStoredStringRecord,
} from "./localStorage";
import { renderTableHeader } from "./tableHeader";

interface RangesViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}

interface Filters extends Record<string, string> {
  rangeSize: string;
  rangeStartGt: string;
  rangeStartLt: string;
  dateGt: string;
  dateLt: string;
  limit: string;
}

const RANGE_SIZES = ["2", "5", "10", "20", "50", "100", "150", "200", "300", "500", "1000"];
const LIMIT_OPTIONS = ["100", "250", "500", "1000", "2500", "5000", "10000"];
const FILTER_KEYS = ["rangeSize", "rangeStartGt", "rangeStartLt", "dateGt", "dateLt", "limit"] as const;
const FILTER_STORAGE_KEY = "ranges.filters";
const COLUMN_STORAGE_KEY = "ranges.visibleColumns";
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
  group: string;
  className?: string;
  render: (row: T) => ReactNode;
}

interface ColumnGroup<T> {
  key: string;
  label: string;
  columns: Column<T>[];
}

function rangeColumns(timeZone: string, tokenSymbol: string): Column<StoredBlockRange>[] {
  return [
    {
      key: "rangeSize",
      label: "Range size",
      group: "Range",
      className: "num",
      render: (row) => row.rangeSize,
    },
    {
      key: "rangeStart",
      label: "Start",
      group: "Range",
      className: "num",
      render: (row) => row.rangeStart,
    },
    {
      key: "rangeEnd",
      label: "End",
      group: "Range",
      className: "num",
      render: (row) => row.rangeEnd,
    },
    {
      key: "minBlockDate",
      label: "Min date",
      group: "Range",
      render: (row) => fmtDate(row.minBlockDate, timeZone),
    },
    {
      key: "maxBlockDate",
      label: "Max date",
      group: "Range",
      render: (row) => fmtDate(row.maxBlockDate, timeZone),
    },
    {
      key: "minBaseFeeWei",
      label: "Min base fee (gwei)",
      group: "Gas price",
      className: "num",
      render: (row) => fmtGwei(row.minBaseFeeWei),
    },
    {
      key: "maxBaseFeeWei",
      label: "Max base fee (gwei)",
      group: "Gas price",
      className: "num",
      render: (row) => fmtGwei(row.maxBaseFeeWei),
    },
    {
      key: "averageBaseFeeWei",
      label: "Avg base fee (gwei)",
      group: "Gas price",
      className: "num",
      render: (row) => fmtGwei(row.averageBaseFeeWei),
    },
    {
      key: "totalBlockRewardWei",
      label: `Total rewards (${tokenSymbol})`,
      group: "Rewards",
      className: "num",
      render: (row) => fmtEth(row.totalBlockRewardWei),
    },
    {
      key: "totalBurntFeesWei",
      label: `Total burnt (${tokenSymbol})`,
      group: "Rewards",
      className: "num",
      render: (row) => fmtEth(row.totalBurntFeesWei),
    },
    {
      key: "averageBlockRewardWei",
      label: `Avg reward/block (${tokenSymbol})`,
      group: "Rewards",
      className: "num",
      render: (row) => fmtEth(row.averageBlockRewardWei),
    },
    {
      key: "averageBurntFeesWei",
      label: `Avg burnt/block (${tokenSymbol})`,
      group: "Rewards",
      className: "num",
      render: (row) => fmtEth(row.averageBurntFeesWei),
    },
    {
      key: "averageFeePriceWei",
      label: "Avg fee price (gwei)",
      group: "Gas price",
      className: "num",
      render: (row) => fmtGwei(row.averageFeePriceWei),
    },
    {
      key: "averagePriorityFeeWeightedWei",
      label: "Gas-weighted priority (gwei)",
      group: "Gas price",
      className: "num",
      render: (row) => fmtGwei(row.averagePriorityFeeWeightedWei),
    },
    {
      key: "averagePriorityFeeWei",
      label: "Avg priority fee (gwei)",
      group: "Gas price",
      className: "num",
      render: (row) => fmtGwei(row.averagePriorityFeeWei),
    },
    {
      key: "averageTransactionGasUsed",
      label: "Avg tx gas",
      group: "Transactions",
      className: "num",
      render: (row) => fmtInteger(row.averageTransactionGasUsed),
    },
    {
      key: "averageTransactionInputDataSizeBytes",
      label: "Avg tx input",
      group: "Transactions",
      className: "num",
      render: (row) => fmtBytes(row.averageTransactionInputDataSizeBytes),
    },
    {
      key: "averageTransactionInputDataCompressedSizeBytes",
      label: "Avg tx input zstd",
      group: "Transactions",
      className: "num",
      render: (row) => fmtBytes(row.averageTransactionInputDataCompressedSizeBytes),
    },
    {
      key: "transactionCount",
      label: "Tx count",
      group: "Transactions",
      className: "num",
      render: (row) => row.transactionCount,
    },
    {
      key: "minMaxGasInBlock",
      label: "Min block gas limit",
      group: "Block gas",
      className: "num",
      render: (row) => fmtInteger(row.minMaxGasInBlock),
    },
    {
      key: "maxMaxGasInBlock",
      label: "Max block gas limit",
      group: "Block gas",
      className: "num",
      render: (row) => fmtInteger(row.maxMaxGasInBlock),
    },
    {
      key: "gasUsed",
      label: "Gas used / total max",
      group: "Block gas",
      className: "num",
      render: (row) => fmtRatio(row.totalGasUsed, row.totalMaxGas),
    },
    {
      key: "totalGasUsed",
      label: "Total gas used",
      group: "Block gas",
      className: "num",
      render: (row) => fmtInteger(row.totalGasUsed),
    },
    {
      key: "averageTotalGasUsed",
      label: "Avg block gas used",
      group: "Block gas",
      className: "num",
      render: (row) => fmtInteger(row.averageTotalGasUsed),
    },
    {
      key: "minTotalGasUsed",
      label: "Min block gas used",
      group: "Block gas",
      className: "num",
      render: (row) => fmtInteger(row.minTotalGasUsed),
    },
    {
      key: "maxTotalGasUsed",
      label: "Max block gas used",
      group: "Block gas",
      className: "num",
      render: (row) => fmtInteger(row.maxTotalGasUsed),
    },
    {
      key: "totalInputDataSizeBytes",
      label: "Total input data",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.totalInputDataSizeBytes),
    },
    {
      key: "averageTotalInputDataSizeBytes",
      label: "Avg block input data",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.averageTotalInputDataSizeBytes),
    },
    {
      key: "minTotalInputDataSizeBytes",
      label: "Min block input data",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.minTotalInputDataSizeBytes),
    },
    {
      key: "maxTotalInputDataSizeBytes",
      label: "Max block input data",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.maxTotalInputDataSizeBytes),
    },
    {
      key: "totalInputDataCompressedSizeBytes",
      label: "Total input data zstd",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.totalInputDataCompressedSizeBytes),
    },
    {
      key: "averageTotalInputDataCompressedSizeBytes",
      label: "Avg block input zstd",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.averageTotalInputDataCompressedSizeBytes),
    },
    {
      key: "minTotalInputDataCompressedSizeBytes",
      label: "Min block input zstd",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.minTotalInputDataCompressedSizeBytes),
    },
    {
      key: "maxTotalInputDataCompressedSizeBytes",
      label: "Max block input zstd",
      group: "Data size",
      className: "num",
      render: (row) => fmtBytes(row.maxTotalInputDataCompressedSizeBytes),
    },
  ];
}

function columnGroupKey(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-");
}

function groupColumns<T>(columns: readonly Column<T>[]): ColumnGroup<T>[] {
  const groups = new Map<string, ColumnGroup<T>>();
  for (const column of columns) {
    const key = columnGroupKey(column.group);
    const group = groups.get(key);
    if (group) {
      group.columns.push(column);
    } else {
      groups.set(key, { key, label: column.group, columns: [column] });
    }
  }
  return [...groups.values()];
}

function buildParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    const trimmed = v.trim();
    if (trimmed) params.set(k, trimmed);
  }
  return params;
}

function loadFilters(locationSearch: string): Filters {
  const stored = readStoredStringRecord(FILTER_STORAGE_KEY, EMPTY, FILTER_KEYS);
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, stored);
}

function loadVisibleColumnKeys(columns: readonly Column<StoredBlockRange>[]): string[] {
  const allKeys = columns.map((column) => column.key);
  const stored = readStoredString(COLUMN_STORAGE_KEY, "");
  if (!stored) return allKeys;

  const known = new Set(allKeys);
  const visible = stored
    .split(",")
    .map((key) => key.trim())
    .filter((key) => known.has(key));
  return visible.length > 0 ? visible : allKeys;
}

function saveVisibleColumnKeys(keys: readonly string[]) {
  writeStoredString(COLUMN_STORAGE_KEY, keys.join(","));
}

export function RangesView({ locationSearch, onLocationChange, timeZone, tokenSymbol }: RangesViewProps) {
  const [filters, setFilters] = useState<Filters>(() => loadFilters(locationSearch));
  const [applied, setApplied] = useState<Filters>(filters);
  const [data, setData] = useState<RangesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState<string[]>(() =>
    loadVisibleColumnKeys(rangeColumns(timeZone, tokenSymbol)),
  );

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
    writeStoredStringRecord(FILTER_STORAGE_KEY, filters, FILTER_KEYS);
  }, [filters]);

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

  const clearFilters = () => {
    setFilters(EMPTY);
    if (writePermalink("ranges", EMPTY)) {
      onLocationChange();
    } else {
      setApplied(EMPTY);
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

  const sorted = data ? data.ranges.slice().sort((a, b) => b.rangeStart - a.rangeStart) : [];
  const columns = useMemo(() => rangeColumns(timeZone, tokenSymbol), [timeZone, tokenSymbol]);
  const columnGroups = useMemo(() => groupColumns(columns), [columns]);
  const visibleColumns = useMemo(() => {
    const visible = new Set(visibleColumnKeys);
    const selected = columns.filter((column) => visible.has(column.key));
    return selected.length > 0 ? selected : columns.slice(0, 1);
  }, [columns, visibleColumnKeys]);
  const activeFilterCount = [
    filters.rangeStartGt,
    filters.rangeStartLt,
    filters.dateGt,
    filters.dateLt,
  ].filter((value) => value.trim() !== "").length;

  useEffect(() => {
    const known = new Set(columns.map((column) => column.key));
    setVisibleColumnKeys((current) => {
      const next = current.filter((key) => known.has(key));
      return next.length > 0 ? next : columns.map((column) => column.key);
    });
  }, [columns]);

  useEffect(() => {
    saveVisibleColumnKeys(visibleColumnKeys);
  }, [visibleColumnKeys]);

  const showAllColumns = () => {
    setVisibleColumnKeys(columns.map((column) => column.key));
  };

  const toggleColumn = (key: string) => {
    setVisibleColumnKeys((current) => {
      if (current.includes(key)) {
        return current.length > 1 ? current.filter((columnKey) => columnKey !== key) : current;
      }
      return columns.some((column) => column.key === key) ? [...current, key] : current;
    });
  };

  const filtersChanged =
    activeFilterCount > 0 || filters.limit !== EMPTY.limit || filters.rangeSize !== EMPTY.rangeSize;

  return (
    <section className="view ranges-view">
      <h2>Aggregated ranges</h2>
      <div className={`filters-panel blocks-filters-panel${filtersOpen ? " open" : ""}`}>
        <div className="filters-panel-head">
          <button
            type="button"
            className="filters-toggle"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <span className="filters-toggle-chevron" aria-hidden="true" />
            <span>Filters</span>
            {activeFilterCount > 0 ? <span className="filters-count">{activeFilterCount}</span> : null}
          </button>
          <span className="blocks-filter-meta">
            {filters.limit} rows / {filters.rangeSize} blocks
          </span>
          {filtersChanged ? (
            <button type="button" className="link-button filters-clear" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
        </div>
        {filtersOpen ? (
          <form onSubmit={onSubmit} className="blocks-filter-form ranges-filter-form">
            <fieldset className="filter-group ranges-size-filter">
              <legend>Range</legend>
              <label>
                size
                <select value={filters.rangeSize} onChange={onSelectChange("rangeSize")}>
                  {RANGE_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                &gt;
                <input
                  type="text"
                  inputMode="numeric"
                  value={filters.rangeStartGt}
                  onChange={onTextChange("rangeStartGt")}
                />
              </label>
              <label>
                &lt;
                <input
                  type="text"
                  inputMode="numeric"
                  value={filters.rangeStartLt}
                  onChange={onTextChange("rangeStartLt")}
                />
              </label>
            </fieldset>
            <fieldset className="filter-group blocks-date-filter">
              <legend>Date UTC</legend>
              <label>
                &gt;
                <input
                  type="text"
                  placeholder="2024-01-01T00:00:00Z"
                  value={filters.dateGt}
                  onChange={onTextChange("dateGt")}
                />
              </label>
              <label>
                &lt;
                <input
                  type="text"
                  placeholder="2024-12-31T00:00:00Z"
                  value={filters.dateLt}
                  onChange={onTextChange("dateLt")}
                />
              </label>
            </fieldset>
            <fieldset className="filter-group blocks-limit-filter">
              <legend>Rows</legend>
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
            </fieldset>
            <div className="blocks-filter-actions">
              <button type="button" className="secondary" onClick={copyPermalink}>
                Copy link
              </button>
              {filtersChanged ? (
                <button type="button" className="secondary" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
              <button type="submit">Search</button>
              {copyStatus ? <span className="copy-status">{copyStatus}</span> : null}
            </div>
          </form>
        ) : null}
      </div>
      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to load ranges: ${error}`
            : data
              ? `${data.count} ranges${data.truncated ? ` (truncated to ${data.limit})` : ""}`
              : ""}
      </p>
      <div className={`ranges-columns-panel${columnsOpen ? " open" : ""}`}>
        <div className="ranges-columns-head">
          <button
            type="button"
            className="filters-toggle"
            aria-expanded={columnsOpen}
            onClick={() => setColumnsOpen((open) => !open)}
          >
            <span className="filters-toggle-chevron" aria-hidden="true" />
            <span>Columns</span>
            <span className="filters-count">{visibleColumns.length}</span>
          </button>
          {visibleColumns.length < columns.length ? (
            <button type="button" className="link-button filters-clear" onClick={showAllColumns}>
              Show all
            </button>
          ) : null}
        </div>
        {columnsOpen ? (
          <div className="ranges-column-groups">
            {columnGroups.map((group) => (
              <div key={group.key} className="ranges-column-group">
                <span className="ranges-column-group-title">{group.label}</span>
                <div className="ranges-column-grid">
                  {group.columns.map((column) => {
                    const checked = visibleColumnKeys.includes(column.key);
                    return (
                      <label key={column.key} className="ranges-column-toggle">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={checked && visibleColumns.length === 1}
                          onChange={() => toggleColumn(column.key)}
                        />
                        <span>{column.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="table-wrap">
        <table className="data-table ranges-table">
          <thead>
            <tr>
              {visibleColumns.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  {renderTableHeader(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={`${row.rangeSize}-${row.rangeStart}`}>
                {visibleColumns.map((column) => (
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
