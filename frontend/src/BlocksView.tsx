import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchBlocks, type BlocksResponse, type StoredBlock } from "./api";
import { fmtDate, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import { BlockNumberLink } from "./blockLinks";
import {
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";

interface BlocksViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}

interface Filters extends Record<string, string> {
  blockGt: string;
  blockLt: string;
  dateGt: string;
  dateLt: string;
  limit: string;
}

const LIMIT_OPTIONS = ["100", "250", "500", "1000", "2500", "5000", "10000"];
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
  width: string;
  render: (row: T) => ReactNode;
}

function blockColumns(timeZone: string, onLocationChange: () => void, tokenSymbol: string): Column<StoredBlock>[] {
  return [
    {
      key: "block",
      label: "Block",
      className: "num",
      width: "7.5rem",
      render: (row) => <BlockNumberLink blockNumber={row.blockNumber} onLocationChange={onLocationChange} />,
    },
    {
      key: "date",
      label: "Date",
      width: "12.5rem",
      render: (row) => fmtDate(row.blockDate, timeZone),
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
      width: "9rem",
      render: (row) => fmtGwei(row.baseBlockFeeWei),
    },
    {
      key: "blockRewardWei",
      label: `Block reward (${tokenSymbol})`,
      className: "num",
      width: "11rem",
      render: (row) => fmtEth(row.blockRewardWei ?? "0"),
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
      key: "averagePriorityFeeWeightedWei",
      label: "Gas-weighted priority (gwei)",
      className: "num",
      width: "14rem",
      render: (row) => fmtGwei(row.averagePriorityFeeWeightedWei),
    },
    {
      key: "averagePriorityFeeWei",
      label: "Avg priority fee (gwei)",
      className: "num",
      width: "11rem",
      render: (row) => fmtGwei(row.averagePriorityFeeWei),
    },
    {
      key: "averageTransactionGasUsed",
      label: "Avg tx gas",
      className: "num",
      width: "10rem",
      render: (row) => fmtInteger(row.averageTransactionGasUsed),
    },
    {
      key: "gasUsed",
      label: "Gas used / limit",
      className: "num",
      width: "15rem",
      render: (row) => fmtRatio(row.totalGasUsed, row.maxGasInBlock),
    },
    {
      key: "batcherQueueSize",
      label: "Batcher queue",
      className: "num",
      width: "10rem",
      render: (row) => fmtInteger(row.batcherQueueSize),
    },
    {
      key: "batcherIntensity",
      label: "Batcher intensity",
      className: "num",
      width: "11rem",
      render: (row) => fmtInteger(row.batcherIntensity),
    },
    {
      key: "batcherLowerThreshold",
      label: "Batcher lower",
      className: "num",
      width: "10rem",
      render: (row) => fmtInteger(row.batcherLowerThreshold),
    },
    {
      key: "batcherUpperThreshold",
      label: "Batcher upper",
      className: "num",
      width: "10rem",
      render: (row) => fmtInteger(row.batcherUpperThreshold),
    },
    {
      key: "batcherMaxBlockSize",
      label: "Batcher max block",
      className: "num",
      width: "12rem",
      render: (row) => fmtInteger(row.batcherMaxBlockSize),
    },
    {
      key: "batcherMaxTxSize",
      label: "Batcher max tx",
      className: "num",
      width: "11rem",
      render: (row) => fmtInteger(row.batcherMaxTxSize),
    },
  ];
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
  const columns = useMemo(
    () => blockColumns(timeZone, onLocationChange, tokenSymbol),
    [timeZone, onLocationChange, tokenSymbol],
  );

  const sorted = data
    ? data.blocks.slice().sort((a, b) => b.blockNumber - a.blockNumber)
    : [];

  return (
    <section className="view">
      <h2>Latest blocks</h2>
      <form onSubmit={onSubmit}>
        <label>
          blockGt
          <input type="text" inputMode="numeric" value={filters.blockGt} onChange={onChange("blockGt")} />
        </label>
        <label>
          blockLt
          <input type="text" inputMode="numeric" value={filters.blockLt} onChange={onChange("blockLt")} />
        </label>
        <label>
          dateGt (ISO)
          <input type="text" placeholder="2024-01-01T00:00:00Z" value={filters.dateGt} onChange={onChange("dateGt")} />
        </label>
        <label>
          dateLt (ISO)
          <input type="text" placeholder="2024-12-31T00:00:00Z" value={filters.dateLt} onChange={onChange("dateLt")} />
        </label>
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
        <button type="submit">Search</button>
      </form>
      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading…"
          : error
            ? `Failed to load blocks: ${error}`
            : data
              ? `${data.count} blocks${data.truncated ? ` (truncated to ${data.limit})` : ""}`
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
