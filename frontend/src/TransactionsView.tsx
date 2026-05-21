import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchTransactions, type StoredTransaction, type TransactionsResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { fmtDate, fmtEth, fmtGwei, fmtInteger } from "./format";
import {
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { addressSearchHref, transactionExplorerHref } from "./transactionLinks";

interface TransactionsViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
}

interface TransactionFilters extends Record<string, string> {
  address: string;
  block: string;
  blockGt: string;
  blockLt: string;
  nonceGt: string;
  nonceLt: string;
  dateGt: string;
  dateLt: string;
  limit: string;
  page: string;
}

type SortDirection = "asc" | "desc";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

type SortKey =
  | "blockNumber"
  | "blockDate"
  | "baseBlockFeeWei"
  | "position"
  | "hash"
  | "from"
  | "to"
  | "type"
  | "nonce"
  | "status"
  | "valueWei"
  | "gasLimit"
  | "gasUsed"
  | "cumulativeGasUsed"
  | "gasPriceWei"
  | "maxFeePerGasWei"
  | "effectiveGasPriceWei"
  | "priorityFeeWei"
  | "maxPriorityFeePerGasWei"
  | "transactionFeeWei";

interface Column {
  key: SortKey;
  label: string;
  className?: string;
  width: string;
  render: (row: StoredTransaction) => ReactNode;
}

const FILTER_KEYS = [
  "address",
  "block",
  "blockGt",
  "blockLt",
  "nonceGt",
  "nonceLt",
  "dateGt",
  "dateLt",
  "limit",
  "page",
] as const;
const STORAGE_KEY = "transactions.filters";
const EMPTY: TransactionFilters = {
  address: "",
  block: "",
  blockGt: "",
  blockLt: "",
  nonceGt: "",
  nonceLt: "",
  dateGt: "",
  dateLt: "",
  limit: "100",
  page: "1",
};

function transactionColumns(timeZone: string): Column[] {
  return [
  {
    key: "blockNumber",
    label: "Block",
    className: "num",
    width: "8rem",
    render: (row) => row.blockNumberDecimal,
  },
  {
    key: "blockDate",
    label: "Date",
    width: "13rem",
    render: (row) => fmtDate(row.blockDate, timeZone),
  },
  {
    key: "position",
    label: "Pos",
    className: "num",
    width: "5rem",
    render: (row) => row.position,
  },
  {
    key: "hash",
    label: "Hash",
    width: "16rem",
    render: (row) => (
      <CopyCell
        value={row.hash}
        label={shortHash(row.hash)}
        copyLabel="transaction hash"
        href={transactionExplorerHref(row.hash)}
        external
      />
    ),
  },
  {
    key: "from",
    label: "From",
    width: "12rem",
    render: (row) => <AddressCell address={row.from} />,
  },
  {
    key: "to",
    label: "To / contract",
    width: "12rem",
    render: (row) => <AddressCell address={row.to ?? row.contractAddress} />,
  },
  {
    key: "type",
    label: "Type",
    className: "num",
    width: "5rem",
    render: (row) => row.type ?? "-",
  },
  {
    key: "nonce",
    label: "Nonce",
    className: "num",
    width: "7rem",
    render: (row) => row.nonce ?? "-",
  },
  {
    key: "status",
    label: "Status",
    width: "6rem",
    render: (row) => statusLabel(row.status),
  },
  {
    key: "valueWei",
    label: "Value (ETH)",
    className: "num",
    width: "9rem",
    render: (row) => fmtEth(row.valueWei),
  },
  {
    key: "gasLimit",
    label: "Gas limit",
    className: "num",
    width: "9rem",
    render: (row) => fmtInteger(row.gasLimit),
  },
  {
    key: "gasUsed",
    label: "Gas used",
    className: "num",
    width: "9rem",
    render: (row) => fmtInteger(row.gasUsed),
  },
  {
    key: "cumulativeGasUsed",
    label: "Cumulative gas",
    className: "num",
    width: "11rem",
    render: (row) => fmtInteger(row.cumulativeGasUsed),
  },
  {
    key: "baseBlockFeeWei",
    label: "Base fee (gwei)",
    className: "num",
    width: "11rem",
    render: (row) => fmtGwei(row.baseBlockFeeWei),
  },
  {
    key: "gasPriceWei",
    label: "Gas price (gwei)",
    className: "num",
    width: "11rem",
    render: (row) => fmtGwei(row.gasPriceWei),
  },
  {
    key: "maxFeePerGasWei",
    label: "Max fee (gwei)",
    className: "num",
    width: "11rem",
    render: (row) => fmtGwei(row.maxFeePerGasWei),
  },
  {
    key: "effectiveGasPriceWei",
    label: "Effective fee (gwei)",
    className: "num",
    width: "12rem",
    render: (row) => fmtGwei(row.effectiveGasPriceWei),
  },
  {
    key: "priorityFeeWei",
    label: "Priority fee (gwei)",
    className: "num",
    width: "12rem",
    render: (row) => fmtGwei(row.priorityFeeWei),
  },
  {
    key: "maxPriorityFeePerGasWei",
    label: "Max priority (gwei)",
    className: "num",
    width: "12rem",
    render: (row) => fmtGwei(row.maxPriorityFeePerGasWei),
  },
  {
    key: "transactionFeeWei",
    label: "Tx fee (ETH)",
    className: "num",
    width: "10rem",
    render: (row) => fmtEth(row.transactionFeeWei),
  },
  ];
}

function loadFilters(locationSearch: string): TransactionFilters {
  const stored = readStoredStringRecord(STORAGE_KEY, EMPTY, FILTER_KEYS);
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, stored);
}

export function TransactionsView({ locationSearch, onLocationChange, timeZone }: TransactionsViewProps) {
  const [filters, setFilters] = useState<TransactionFilters>(() => loadFilters(locationSearch));
  const [applied, setApplied] = useState<TransactionFilters>(filters);
  const [data, setData] = useState<TransactionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);

  const load = useCallback((f: TransactionFilters) => {
    if (!hasScopedFilters(f)) {
      setData(null);
      setError(null);
      return;
    }

    const params = filtersToParams(f);
    setLoading(true);
    setError(null);
    fetchTransactions(params)
      .then((body) => setData(body))
      .catch((err: Error) => {
        setData(null);
        setError(err.message);
      })
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
    if (writePermalink("transactions", permalinkFilters(filters))) {
      onLocationChange();
    } else {
      setApplied(filters);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("transactions", permalinkFilters(applied));
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const rows = useMemo(() => {
    const transactions = data?.transactions ?? [];
    if (sort === null) return transactions;
    return transactions.slice().sort((a, b) => compareRows(a, b, sort));
  }, [data, sort]);
  const columns = useMemo(() => transactionColumns(timeZone), [timeZone]);

  const setSortKey = (key: SortKey) => {
    setSort((current) => {
      if (current?.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: defaultDirection(key) };
    });
  };

  const setFilter = (key: keyof TransactionFilters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = { ...filters, [key]: e.target.value };
    if (key !== "page") next.page = "1";
    setFilters(next);
  };

  const goToPage = (page: number) => {
    const next = { ...applied, page: String(Math.max(1, page)) };
    setFilters(next);
    if (writePermalink("transactions", permalinkFilters(next))) {
      onLocationChange();
    } else {
      setApplied(next);
    }
  };

  const hasAppliedFilters = hasScopedFilters(applied);
  const transactionLabel = applied.address.trim() ? "outgoing transactions" : "transactions";

  return (
    <section className="view transactions-view">
      <h2>Address transactions</h2>
      <form onSubmit={onSubmit} className="transactions-form">
        <label className="wide-field">
          address
          <input type="text" value={filters.address} onChange={setFilter("address")} />
        </label>
        <label>
          block
          <input type="text" inputMode="numeric" value={filters.block} onChange={setFilter("block")} />
        </label>
        <label>
          block &gt;
          <input
            type="text"
            inputMode="numeric"
            value={filters.blockGt}
            onChange={setFilter("blockGt")}
            disabled={Boolean(filters.block.trim())}
          />
        </label>
        <label>
          block &lt;
          <input
            type="text"
            inputMode="numeric"
            value={filters.blockLt}
            onChange={setFilter("blockLt")}
            disabled={Boolean(filters.block.trim())}
          />
        </label>
        <label>
          nonce &gt;
          <input type="text" inputMode="numeric" value={filters.nonceGt} onChange={setFilter("nonceGt")} />
        </label>
        <label>
          nonce &lt;
          <input type="text" inputMode="numeric" value={filters.nonceLt} onChange={setFilter("nonceLt")} />
        </label>
        <label>
          date &gt;
          <input type="text" value={filters.dateGt} onChange={setFilter("dateGt")} />
        </label>
        <label>
          date &lt;
          <input type="text" value={filters.dateLt} onChange={setFilter("dateLt")} />
        </label>
        <label>
          page size
          <input type="text" inputMode="numeric" value={filters.limit} onChange={setFilter("limit")} />
        </label>
        <label>
          page
          <input type="text" inputMode="numeric" value={filters.page} onChange={setFilter("page")} />
        </label>
        <button type="submit">Query</button>
      </form>

      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to query transactions: ${error}`
            : data
              ? `${data.totalCount} ${transactionLabel}; showing ${data.count} on page ${data.page}${
                  data.totalPages ? ` of ${data.totalPages}` : ""
                }`
              : "Enter an address, block, or date range to query stored transactions."}
      </p>

      <div className="permalink-row transactions-actions">
        <button type="button" className="secondary" onClick={copyPermalink} disabled={!hasAppliedFilters}>
          Copy link
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => goToPage((data?.page ?? toPositiveInteger(applied.page, 1)) - 1)}
          disabled={!data?.hasPreviousPage || loading}
        >
          Previous
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => goToPage((data?.page ?? toPositiveInteger(applied.page, 1)) + 1)}
          disabled={!data?.hasNextPage || loading}
        >
          Next
        </button>
        {copyStatus ? <span>{copyStatus}</span> : null}
      </div>

      <div className="table-wrap">
        <table className="data-table tx-table">
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  <button type="button" className="sort-header" onClick={() => setSortKey(column.key)}>
                    <span>{column.label}</span>
                    <span aria-hidden="true">{sort?.key === column.key ? sortIcon(sort.direction) : ""}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.blockNumberDecimal}:${row.position}:${row.hash}`}>
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

export function AddressCell({ address }: { address: string | null | undefined }) {
  const display = addressDisplay(address);
  const value = address?.trim() || null;
  return (
    <CopyCell
      value={value}
      label={display.label}
      title={display.title}
      copyLabel="address"
      href={addressSearchHref(value)}
    />
  );
}

function CopyCell({
  value,
  label,
  title,
  copyLabel,
  href,
  external = false,
}: {
  value: string | null | undefined;
  label: string;
  title?: string;
  copyLabel: string;
  href?: string | null;
  external?: boolean;
}) {
  const copyValue = value?.trim();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  if (!copyValue) {
    return (
      <span className="mono truncate" title={title}>
        {label}
      </span>
    );
  }

  const onCopy = async () => {
    if (await copyText(copyValue)) {
      setCopied(true);
    }
  };

  const text = href ? (
    <a
      className="mono truncate copy-cell-link"
      title={title ?? copyValue}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
    >
      {label}
    </a>
  ) : (
    <span className="mono truncate" title={title ?? copyValue}>
      {label}
    </span>
  );

  return (
    <span className="copy-cell">
      {text}
      <button
        type="button"
        className="copy-cell-button"
        aria-label={`Copy ${copyLabel}`}
        title={copied ? "Copied" : `Copy ${copyLabel}`}
        onClick={onCopy}
      >
        <span aria-hidden="true" className="copy-cell-icon" />
      </button>
    </span>
  );
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return copyTextFallback(value);
  }
}

function copyTextFallback(value: string): boolean {
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}

function filtersToParams(filters: TransactionFilters): URLSearchParams {
  const normalized = permalinkFilters(filters);
  const params = new URLSearchParams();
  addParam(params, "address", normalized.address);
  addParam(params, "block", normalized.block);
  addParam(params, "blockGt", normalized.blockGt);
  addParam(params, "blockLt", normalized.blockLt);
  addParam(params, "nonceGt", normalized.nonceGt);
  addParam(params, "nonceLt", normalized.nonceLt);
  addParam(params, "dateGt", normalized.dateGt);
  addParam(params, "dateLt", normalized.dateLt);
  addParam(params, "limit", normalized.limit);
  addParam(params, "page", normalized.page);
  params.set("order", "desc");
  return params;
}

function permalinkFilters(filters: TransactionFilters): TransactionFilters {
  const block = filters.block.trim();
  if (block) {
    return {
      ...filters,
      block,
      blockGt: "",
      blockLt: "",
    };
  }

  return {
    ...filters,
    block: "",
  };
}

function hasScopedFilters(filters: TransactionFilters): boolean {
  return Boolean(
    filters.address.trim() ||
      filters.block.trim() ||
      filters.blockGt.trim() ||
      filters.blockLt.trim() ||
      filters.nonceGt.trim() ||
      filters.nonceLt.trim() ||
      filters.dateGt.trim() ||
      filters.dateLt.trim(),
  );
}

function addParam(params: URLSearchParams, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) params.set(key, trimmed);
}

function compareRows(a: StoredTransaction, b: StoredTransaction, sort: SortState): number {
  const direction = sort.direction === "asc" ? 1 : -1;
  const left = sortValue(a, sort.key);
  const right = sortValue(b, sort.key);

  if (typeof left === "bigint" && typeof right === "bigint") {
    if (left === right) return a.position - b.position;
    return left < right ? -direction : direction;
  }

  const textCompare = String(left).localeCompare(String(right));
  return textCompare === 0 ? a.position - b.position : textCompare * direction;
}

function sortValue(row: StoredTransaction, key: SortKey): string | bigint {
  if (
    key === "blockNumber" ||
    key === "position" ||
    key === "type" ||
    key === "nonce" ||
    key === "status" ||
    key === "valueWei" ||
    key === "gasLimit" ||
    key === "gasUsed" ||
    key === "cumulativeGasUsed" ||
    key === "baseBlockFeeWei" ||
    key === "gasPriceWei" ||
    key === "maxFeePerGasWei" ||
    key === "effectiveGasPriceWei" ||
    key === "priorityFeeWei" ||
    key === "maxPriorityFeePerGasWei" ||
    key === "transactionFeeWei"
  ) {
    return toBigInt(row[key]);
  }
  return row[key] ?? "";
}

function toBigInt(value: string | number | null): bigint {
  if (typeof value === "number") return BigInt(value);
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function toPositiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultDirection(key: SortKey): SortDirection {
  return key === "blockNumber" ||
    key === "blockDate" ||
    key === "position" ||
    key === "hash" ||
    key === "from" ||
    key === "to"
    ? "asc"
    : "desc";
}

function sortIcon(direction: SortDirection): string {
  return direction === "asc" ? "^" : "v";
}

function shortHash(value: string | null | undefined): string {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function statusLabel(value: string | null): string {
  if (value === "1") return "Success";
  if (value === "0") return "Failed";
  return value ?? "-";
}
