import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchRanges, type RangesResponse, type StoredBlockRange } from "./api";
import { fmtBytes, fmtDate, fmtGasPrice, fmtInteger, fmtRatio, fmtTokenAmount } from "./format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterField, FilterGroup, FiltersPanel, selectClass } from "@/components/filters-panel";
import { cn } from "@/lib/utils";
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
  const num = "text-right font-mono tabular-nums";
  return [
    {
      key: "rangeSize",
      label: "Range size",
      group: "Range",
      className: num,
      render: (row) => row.rangeSize,
    },
    {
      key: "rangeStart",
      label: "Start block",
      group: "Range",
      className: num,
      render: (row) => row.rangeStart,
    },
    {
      key: "rangeEnd",
      label: "End block",
      group: "Range",
      className: num,
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
      label: "Min base fee",
      group: "Gas price",
      className: num,
      render: (row) => fmtGasPrice(row.minBaseFeeWei),
    },
    {
      key: "maxBaseFeeWei",
      label: "Max base fee",
      group: "Gas price",
      className: num,
      render: (row) => fmtGasPrice(row.maxBaseFeeWei),
    },
    {
      key: "averageBaseFeeWei",
      label: "Avg base fee",
      group: "Gas price",
      className: num,
      render: (row) => fmtGasPrice(row.averageBaseFeeWei),
    },
    {
      key: "totalBlockRewardWei",
      label: "Total rewards",
      group: "Rewards",
      className: num,
      render: (row) => fmtTokenAmount(row.totalBlockRewardWei, tokenSymbol),
    },
    {
      key: "totalBurntFeesWei",
      label: "Total burnt",
      group: "Rewards",
      className: num,
      render: (row) => fmtTokenAmount(row.totalBurntFeesWei, tokenSymbol),
    },
    {
      key: "averageBlockRewardWei",
      label: "Avg reward/block",
      group: "Rewards",
      className: num,
      render: (row) => fmtTokenAmount(row.averageBlockRewardWei, tokenSymbol),
    },
    {
      key: "averageBurntFeesWei",
      label: "Avg burnt/block",
      group: "Rewards",
      className: num,
      render: (row) => fmtTokenAmount(row.averageBurntFeesWei, tokenSymbol),
    },
    {
      key: "averageFeePriceWei",
      label: "Avg fee price",
      group: "Gas price",
      className: num,
      render: (row) => fmtGasPrice(row.averageFeePriceWei),
    },
    {
      key: "averagePriorityFeeWeightedWei",
      label: "Gas-weighted priority",
      group: "Gas price",
      className: num,
      render: (row) => fmtGasPrice(row.averagePriorityFeeWeightedWei),
    },
    {
      key: "averagePriorityFeeWei",
      label: "Avg priority fee",
      group: "Gas price",
      className: num,
      render: (row) => fmtGasPrice(row.averagePriorityFeeWei),
    },
    {
      key: "averageTransactionGasUsed",
      label: "Avg tx gas",
      group: "Transactions",
      className: num,
      render: (row) => fmtInteger(row.averageTransactionGasUsed),
    },
    {
      key: "averageTransactionInputDataSizeBytes",
      label: "Avg tx input",
      group: "Transactions",
      className: num,
      render: (row) => fmtBytes(row.averageTransactionInputDataSizeBytes),
    },
    {
      key: "averageTransactionInputDataCompressedSizeBytes",
      label: "Avg tx input zstd",
      group: "Transactions",
      className: num,
      render: (row) => fmtBytes(row.averageTransactionInputDataCompressedSizeBytes),
    },
    {
      key: "transactionCount",
      label: "Tx count",
      group: "Transactions",
      className: num,
      render: (row) => row.transactionCount,
    },
    {
      key: "minMaxGasInBlock",
      label: "Min block gas limit",
      group: "Block gas",
      className: num,
      render: (row) => fmtInteger(row.minMaxGasInBlock),
    },
    {
      key: "maxMaxGasInBlock",
      label: "Max block gas limit",
      group: "Block gas",
      className: num,
      render: (row) => fmtInteger(row.maxMaxGasInBlock),
    },
    {
      key: "gasUsed",
      label: "Gas used / total max",
      group: "Block gas",
      className: num,
      render: (row) => fmtRatio(row.totalGasUsed, row.totalMaxGas),
    },
    {
      key: "totalGasUsed",
      label: "Total gas used",
      group: "Block gas",
      className: num,
      render: (row) => fmtInteger(row.totalGasUsed),
    },
    {
      key: "averageTotalGasUsed",
      label: "Avg block gas used",
      group: "Block gas",
      className: num,
      render: (row) => fmtInteger(row.averageTotalGasUsed),
    },
    {
      key: "minTotalGasUsed",
      label: "Min block gas used",
      group: "Block gas",
      className: num,
      render: (row) => fmtInteger(row.minTotalGasUsed),
    },
    {
      key: "maxTotalGasUsed",
      label: "Max block gas used",
      group: "Block gas",
      className: num,
      render: (row) => fmtInteger(row.maxTotalGasUsed),
    },
    {
      key: "totalInputDataSizeBytes",
      label: "Total input data",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.totalInputDataSizeBytes),
    },
    {
      key: "averageTotalInputDataSizeBytes",
      label: "Avg block input data",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.averageTotalInputDataSizeBytes),
    },
    {
      key: "minTotalInputDataSizeBytes",
      label: "Min block input data",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.minTotalInputDataSizeBytes),
    },
    {
      key: "maxTotalInputDataSizeBytes",
      label: "Max block input data",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.maxTotalInputDataSizeBytes),
    },
    {
      key: "totalInputDataCompressedSizeBytes",
      label: "Total input data zstd",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.totalInputDataCompressedSizeBytes),
    },
    {
      key: "averageTotalInputDataCompressedSizeBytes",
      label: "Avg block input zstd",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.averageTotalInputDataCompressedSizeBytes),
    },
    {
      key: "minTotalInputDataCompressedSizeBytes",
      label: "Min block input zstd",
      group: "Data size",
      className: num,
      render: (row) => fmtBytes(row.minTotalInputDataCompressedSizeBytes),
    },
    {
      key: "maxTotalInputDataCompressedSizeBytes",
      label: "Max block input zstd",
      group: "Data size",
      className: num,
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
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <h2 className="font-heading text-lg font-black tracking-tight">Aggregated ranges</h2>

      <FiltersPanel
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        activeCount={activeFilterCount}
        meta={`${filters.limit} rows / ${filters.rangeSize} blocks`}
        onClearAll={filtersChanged ? clearFilters : undefined}
      >
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <FilterGroup label="Range">
            <FilterField label="Size">
              <select className={cn(selectClass, "w-24")} value={filters.rangeSize} onChange={onSelectChange("rangeSize")}>
                {RANGE_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label="&gt;">
              <Input type="text" inputMode="numeric" className="w-28" value={filters.rangeStartGt} onChange={onTextChange("rangeStartGt")} />
            </FilterField>
            <FilterField label="&lt;">
              <Input type="text" inputMode="numeric" className="w-28" value={filters.rangeStartLt} onChange={onTextChange("rangeStartLt")} />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Date UTC">
            <FilterField label="&gt;">
              <Input type="text" className="w-52" placeholder="2024-01-01T00:00:00Z" value={filters.dateGt} onChange={onTextChange("dateGt")} />
            </FilterField>
            <FilterField label="&lt;">
              <Input type="text" className="w-52" placeholder="2024-12-31T00:00:00Z" value={filters.dateLt} onChange={onTextChange("dateLt")} />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Rows">
            <FilterField label="Limit">
              <select className={cn(selectClass, "w-28")} value={filters.limit} onChange={onSelectChange("limit")}>
                {LIMIT_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </FilterField>
          </FilterGroup>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copyPermalink}>
              Copy link
            </Button>
            {filtersChanged ? (
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              Search
            </Button>
            {copyStatus ? <span className="text-xs text-muted-foreground">{copyStatus}</span> : null}
          </div>
        </form>
      </FiltersPanel>

      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to load ranges: ${error}`
            : data
              ? `${data.count} ranges${data.truncated ? ` (truncated to ${data.limit})` : ""}`
              : ""}
      </p>

      <FiltersPanel
        title="Columns"
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        activeCount={visibleColumns.length}
        showCountAlways
        onClearAll={visibleColumns.length < columns.length ? showAllColumns : undefined}
        clearLabel="Show all"
      >
        <div className="flex flex-col gap-4">
          {columnGroups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                {group.label}
              </span>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {group.columns.map((column) => {
                  const checked = visibleColumnKeys.includes(column.key);
                  return (
                    <label key={column.key} className="flex items-center gap-1.5 text-xs text-foreground">
                      <input
                        type="checkbox"
                        className="size-3.5 rounded-none border-input accent-primary"
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
      </FiltersPanel>

      <div className="overflow-x-auto border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {visibleColumns.map((column) => (
                <TableHead key={column.key} className={column.className}>
                  {renderTableHeader(column.label)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={`${row.rangeSize}-${row.rangeStart}`}>
                {visibleColumns.map((column) => (
                  <TableCell key={column.key} className={column.className} data-label={column.label}>
                    {column.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
