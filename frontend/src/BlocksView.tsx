import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchBlocks, type BlocksResponse, type StoredBlock } from "./api";
import { fmtBytes, fmtDate, fmtEth, fmtGwei } from "./format";
import { BlockNumberLink } from "./blockLinks";
import {
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { BlockList } from "./icons";

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
  limit: "10",
};

interface Column<T> {
  key: string;
  label: string;
  className?: string;
  width: string;
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
      width: "13rem",
      render: (row) => (
        <div className="block-meta">
          <BlockNumberLink blockNumber={row.blockNumber} onLocationChange={onLocationChange} />
          <span className="block-meta-date">{fmtDate(row.blockDate, timeZone)}</span>
        </div>
      ),
    },
    {
      key: "transactionCount",
      label: "Tx count",
      className: "num",
      width: "6rem",
      render: (row) => row.transactionCount,
    },
    {
      key: "baseBlockFeeWei",
      label: "Base fee (gwei)",
      className: "num",
      width: "11rem",
      render: (row) => (
        <BaseFeeCell
          baseFeeWei={row.baseBlockFeeWei}
          previousBaseFeeWei={previousBaseFeeByBlock.get(row.blockNumber)}
        />
      ),
    },
    {
      key: "burntFeesWei",
      label: `Burnt fees (${tokenSymbol})`,
      className: "num",
      width: "10rem",
      render: (row) => fmtEth(row.burntFeesWei ?? "0"),
    },
    {
      key: "averageFeePriceWei",
      label: "Avg fee price (gwei)",
      className: "num",
      width: "11rem",
      render: (row) => fmtGwei(row.averageFeePriceWei),
    },
    {
      key: "averageTransactionGasUsed",
      label: "Avg tx gas",
      className: "num",
      width: "10rem",
      render: (row) => fmtGasK(row.averageTransactionGasUsed),
    },
    {
      key: "inputDataSizeBytes",
      label: "Input data (raw / zstd)",
      className: "num",
      width: "12rem",
      render: (row) => (
        <div className="block-size-cell">
          <span>
            {fmtBytes(row.totalInputDataSizeBytes)} / {fmtBytes(row.totalInputDataCompressedSizeBytes)}
          </span>
          <span>{fmtCompressionRatio(row.totalInputDataCompressedSizeBytes, row.totalInputDataSizeBytes)}</span>
        </div>
      ),
    },
    {
      key: "gasUsed",
      label: "Gas used / limit",
      className: "num",
      width: "15rem",
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
    <div className="base-fee-cell">
      <span>{fmtGwei(baseFeeWei)}</span>
      <span className={`base-fee-diff ${diff.className}`}>{diff.label}</span>
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
      label: `${prefix}${fmtGwei(delta.toString())}`,
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

  return (
    <section className="view blocks-view">
      <div className="page-heading">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "blocks", label: "Block list", icon: <BlockList size={16} /> },
          ]}
          onLocationChange={onLocationChange}
        />
      </div>
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
          <span className="blocks-filter-meta">{filters.limit} rows</span>
          {activeFilterCount > 0 || filters.limit !== EMPTY.limit ? (
            <button type="button" className="link-button filters-clear" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
        </div>
        {filtersOpen ? (
          <form onSubmit={onSubmit} className="blocks-filter-form">
            <fieldset className="filter-group">
              <legend>Block</legend>
              <label>
                &gt;
                <input type="text" inputMode="numeric" value={filters.blockGt} onChange={onChange("blockGt")} />
              </label>
              <label>
                &lt;
                <input type="text" inputMode="numeric" value={filters.blockLt} onChange={onChange("blockLt")} />
              </label>
            </fieldset>
            <fieldset className="filter-group blocks-date-filter">
              <legend>Date UTC</legend>
              <label>
                &gt;
                <input
                  type="text"
                  placeholder={dateGtPlaceholder}
                  value={filters.dateGt}
                  onChange={onChange("dateGt")}
                />
              </label>
              <label>
                &lt;
                <input
                  type="text"
                  placeholder={dateLtPlaceholder}
                  value={filters.dateLt}
                  onChange={onChange("dateLt")}
                />
              </label>
            </fieldset>
            <fieldset className="filter-group blocks-limit-filter">
              <legend>Rows</legend>
              <label>
                limit
                <select value={filters.limit} onChange={onLimitChange}>
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
              {activeFilterCount > 0 || filters.limit !== EMPTY.limit ? (
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
          ? "Loading…"
          : error
            ? `Failed to load blocks: ${error}`
            : data
              ? `${data.count} blocks${data.truncated ? ` (truncated to ${data.limit})` : ""}`
              : ""}
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.blockNumber}>
                {columns.map((column) => (
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
