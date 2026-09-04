import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchBlocks, type BlocksResponse, type StoredBlock } from "./api";
import { fmtBytes, fmtGasPrice, fmtInteger, fmtTokenAmount } from "./format";
import { BlockCell } from "@/components/block-cell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterField, FilterGroup, FiltersPanel, selectClass } from "@/components/filters-panel";
import { cn } from "@/lib/utils";
import {
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { CedricOnTimer } from "./Cedric";
import { renderTableHeader } from "./tableHeader";

interface BlocksViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
  noBatcher: boolean;
}

interface Filters extends Record<string, string> {
  blockGt: string;
  blockLt: string;
  dateGt: string;
  dateLt: string;
  limit: string;
}

const LIMIT_OPTIONS = ["10", "100", "250", "500", "1000", "2500", "5000", "10000"];
const FILTER_KEYS = ["blockGt", "blockLt", "dateGt", "dateLt", "limit"] as const;
const STORAGE_KEY = "blocks.filters";
const EMPTY: Filters = {
  blockGt: "",
  blockLt: "",
  dateGt: "",
  dateLt: "",
  limit: "1000",
};

interface Column<T> {
  key: string;
  label: string;
  className?: string;
  render: (row: T) => ReactNode;
}

function blockColumns(
  timeZone: string,
  onLocationChange: () => void,
  tokenSymbol: string,
  previousBaseFeeByBlock: Map<number, string>,
): Column<StoredBlock>[] {
  return [
    {
      key: "block",
      label: "Block",
      render: (row) => (
        <BlockCell blockNumber={row.blockNumber} date={row.blockDate} timeZone={timeZone} onLocationChange={onLocationChange} />
      ),
    },
    {
      key: "blockTimeSeconds",
      label: "Block time",
      className: "text-right font-mono tabular-nums",
      render: (row) => `${fmtInteger(row.blockTimeSeconds)}s`,
    },
    {
      key: "transactionCount",
      label: "Tx count",
      className: "text-right font-mono tabular-nums",
      render: (row) => row.transactionCount,
    },
    {
      key: "baseBlockFeeWei",
      label: "Base fee",
      className: "text-right font-mono tabular-nums",
      render: (row) => (
        <BaseFeeCell
          baseFeeWei={row.baseBlockFeeWei}
          previousBaseFeeWei={previousBaseFeeByBlock.get(row.blockNumber)}
        />
      ),
    },
    {
      key: "burntFeesWei",
      label: "Burnt fees",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtTokenAmount(row.burntFeesWei ?? "0", tokenSymbol),
    },
    {
      key: "averageFeePriceWei",
      label: "Avg fee price",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtGasPrice(row.averageFeePriceWei),
    },
    {
      key: "averageTransactionGasUsed",
      label: "Avg tx gas",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtGasK(row.averageTransactionGasUsed),
    },
    {
      key: "inputDataSizeBytes",
      label: "Input data",
      className: "text-right font-mono tabular-nums",
      render: (row) => (
        <div className="flex flex-col items-end gap-0.5 leading-tight">
          <span>
            {fmtBytes(row.totalInputDataCompressedSizeBytes)} / {fmtBytes(row.totalInputDataSizeBytes)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {fmtCompressionRatio(row.totalInputDataCompressedSizeBytes, row.totalInputDataSizeBytes)}
          </span>
        </div>
      ),
    },
    {
      key: "gasUsed",
      label: "Gas used / limit",
      className: "text-right font-mono tabular-nums",
      render: (row) => fmtGasRatioK(row.totalGasUsed, row.maxGasInBlock),
    },
  ];
}

function BaseFeeCell({
  baseFeeWei,
  previousBaseFeeWei,
}: {
  baseFeeWei: string;
  previousBaseFeeWei: string | undefined;
}) {
  const diff = baseFeeDifference(baseFeeWei, previousBaseFeeWei);
  return (
    <div className="flex flex-col items-end gap-0.5 leading-tight">
      <span>{fmtGasPrice(baseFeeWei)}</span>
      <span
        className={cn(
          "font-mono text-[11px]",
          diff.className === "up" && "text-red-600 dark:text-red-400",
          diff.className === "down" && "text-emerald-600 dark:text-emerald-400",
          (diff.className === "flat" || diff.className === "missing") && "text-muted-foreground",
        )}
      >
        {diff.label}
      </span>
    </div>
  );
}

function baseFeeDifference(
  baseFeeWei: string,
  previousBaseFeeWei: string | undefined,
): { label: string; className: "up" | "down" | "flat" | "missing" } {
  if (!previousBaseFeeWei) return { label: "prev —", className: "missing" };
  try {
    const delta = BigInt(baseFeeWei) - BigInt(previousBaseFeeWei);
    if (delta === 0n) return { label: "0", className: "flat" };
    const prefix = delta > 0n ? "+" : "";
    return {
      label: `${prefix}${fmtGasPrice(delta.toString())}`,
      className: delta > 0n ? "up" : "down",
    };
  } catch {
    return { label: "prev —", className: "missing" };
  }
}

function fmtGasK(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  try {
    if (BigInt(value) === 0n) return "0";
    const scaled = Number(BigInt(value) * 10n / 1_000n) / 10;
    return `${formatGasKNumber(scaled)}k`;
  } catch {
    const parsed = Number(value);
    if (parsed === 0) return "0";
    return Number.isFinite(parsed) ? `${formatGasKNumber(parsed / 1_000)}k` : String(value);
  }
}

function formatGasKNumber(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function fmtGasRatioK(usedStr: string | null | undefined, limitStr: string | null | undefined): string {
  if (!usedStr || !limitStr) return "—";
  try {
    const used = BigInt(usedStr);
    const limit = BigInt(limitStr);
    if (limit === 0n) return `${fmtGasK(used.toString())} / 0k`;
    const pct = Number((used * 10_000n) / limit) / 100;
    return `${fmtGasK(used.toString())} / ${fmtGasK(limit.toString())} (${pct.toFixed(2)}%)`;
  } catch {
    return `${fmtGasK(usedStr)} / ${fmtGasK(limitStr)}`;
  }
}

function fmtCompressionRatio(compressedStr: string | null | undefined, rawStr: string | null | undefined): string {
  if (!compressedStr || !rawStr) return "ratio —";
  try {
    const compressed = BigInt(compressedStr);
    const raw = BigInt(rawStr);
    if (raw === 0n) return compressed === 0n ? "ratio 100%" : "ratio —";
    const pct = Number((compressed * 10_000n) / raw) / 100;
    return `ratio ${pct.toFixed(2)}%`;
  } catch {
    return "ratio —";
  }
}

function dateSuggestion(daysFromToday: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().replace(".000Z", "Z");
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
  const stored = readStoredStringRecord(STORAGE_KEY, EMPTY, FILTER_KEYS);
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, stored);
}

export function BlocksView({ locationSearch, onLocationChange, timeZone, tokenSymbol }: BlocksViewProps) {
  const [filters, setFilters] = useState<Filters>(() => loadFilters(locationSearch));
  const [applied, setApplied] = useState<Filters>(filters);
  const [data, setData] = useState<BlocksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(true);

  const load = useCallback((f: Filters) => {
    setLoading(true);
    setError(null);
    fetchBlocks(buildParams(f))
      .then((body) => setData(body))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(applied);
  }, [applied, load]);

  useEffect(() => {
    writeStoredStringRecord(STORAGE_KEY, filters, FILTER_KEYS);
  }, [filters]);

  useEffect(() => {
    const next = loadFilters(locationSearch);
    setFilters((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setApplied((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setCopyStatus("");
  }, [locationSearch, setFilters]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (writePermalink("blocks", filters)) {
      onLocationChange();
    } else {
      setApplied(filters);
    }
  };

  const clearFilters = () => {
    setFilters(EMPTY);
    if (writePermalink("blocks", EMPTY)) {
      onLocationChange();
    } else {
      setApplied(EMPTY);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("blocks", applied);
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const onChange = (key: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const onLimitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((prev) => ({ ...prev, limit: e.target.value }));
  };
  const sorted = useMemo(
    () => (data ? data.blocks.slice().sort((a, b) => b.blockNumber - a.blockNumber) : []),
    [data],
  );
  const previousBaseFeeByBlock = useMemo(() => {
    const fees = new Map<number, string>();
    for (const block of sorted) {
      fees.set(block.blockNumber, block.baseBlockFeeWei);
    }
    const previousFees = new Map<number, string>();
    for (const block of sorted) {
      const previousBaseFee = fees.get(block.blockNumber - 1);
      if (previousBaseFee !== undefined) {
        previousFees.set(block.blockNumber, previousBaseFee);
      }
    }
    return previousFees;
  }, [sorted]);
  const columns = useMemo(
    () => blockColumns(timeZone, onLocationChange, tokenSymbol, previousBaseFeeByBlock),
    [timeZone, onLocationChange, tokenSymbol, previousBaseFeeByBlock],
  );
  const activeFilterCount = [filters.blockGt, filters.blockLt, filters.dateGt, filters.dateLt].filter(
    (value) => value.trim() !== "",
  ).length;
  const dateGtPlaceholder = useMemo(() => dateSuggestion(-1), []);
  const dateLtPlaceholder = useMemo(() => dateSuggestion(1), []);
  const filtersChanged = activeFilterCount > 0 || filters.limit !== EMPTY.limit;

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <PageBreadcrumbs
        items={[
          { view: "home", label: "Home" },
          { view: "blocks", label: "Block list" },
        ]}
        onLocationChange={onLocationChange}
      />
      <h2 className="font-heading text-lg font-black tracking-tight">Block list</h2>

      <FiltersPanel
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        activeCount={activeFilterCount}
        meta={`${filters.limit} rows`}
        onClearAll={filtersChanged ? clearFilters : undefined}
      >
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <FilterGroup label="Block">
            <FilterField label="&gt;">
              <Input type="text" inputMode="numeric" className="w-28" value={filters.blockGt} onChange={onChange("blockGt")} />
            </FilterField>
            <FilterField label="&lt;">
              <Input type="text" inputMode="numeric" className="w-28" value={filters.blockLt} onChange={onChange("blockLt")} />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Date UTC">
            <FilterField label="&gt;">
              <Input type="text" className="w-52" placeholder={dateGtPlaceholder} value={filters.dateGt} onChange={onChange("dateGt")} />
            </FilterField>
            <FilterField label="&lt;">
              <Input type="text" className="w-52" placeholder={dateLtPlaceholder} value={filters.dateLt} onChange={onChange("dateLt")} />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Rows">
            <FilterField label="Limit">
              <select className={cn(selectClass, "w-28")} value={filters.limit} onChange={onLimitChange}>
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
          ? "Loading…"
          : error
            ? `Failed to load blocks: ${error}`
            : data
              ? `${data.count} blocks${data.truncated ? ` (truncated to ${data.limit})` : ""}`
              : ""}
      </p>

      <div className="relative mt-6">
        <CedricOnTimer />
        <div className="relative z-10 overflow-x-auto border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((column) => (
                  <TableHead key={column.key} className={column.className}>
                    {renderTableHeader(column.label)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.blockNumber}>
                  {columns.map((column) => (
                    <TableCell key={column.key} className={column.className} data-label={column.label}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </section>
  );
}
