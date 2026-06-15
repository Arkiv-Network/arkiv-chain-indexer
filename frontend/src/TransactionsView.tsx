import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { fetchTransactions, type StoredTransaction, type TransactionsResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { AddressFace } from "./AddressFace";
import { BlockNumberLink } from "./blockLinks";
import { CedricOnTimer } from "./Cedric";
import { fmtBytes, fmtDate, fmtEth, fmtGwei, fmtInteger } from "./format";
import {
  buildAddressPermalinkHref,
  buildPermalinkHref,
  filtersEqual,
  readFiltersFromSearch,
  transactionDetailHref,
  writeAddressPermalink,
  writePermalink,
  writeTransactionPermalink,
} from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { addressSearchHref } from "./transactionLinks";

interface TransactionsViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
  /**
   * When set (the `/address/<0x…>` route) the address is fixed: the address
   * input is replaced by a read-only header and all filters/permalinks operate
   * within that address scope.
   */
  lockedAddress?: string | null;
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
  | "inputDataSizeBytes"
  | "inputDataCompressedSizeBytes"
  | "cumulativeGasUsed"
  | "gasPriceWei"
  | "maxFeePerGasWei"
  | "effectiveGasPriceWei"
  | "priorityFeeWei"
  | "maxPriorityFeePerGasWei"
  | "transactionFeeWei"
  | "arkivOps";

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

// "Clear" resets to this baseline rather than fully empty: the view needs at
// least one scoped filter to load anything, so block > 0 shows all transactions
// instead of the empty "enter an address…" prompt.
const BASELINE_BLOCK_GT = "0";
const CLEARED: TransactionFilters = { ...EMPTY, blockGt: BASELINE_BLOCK_GT };

function transactionColumns(
  timeZone: string,
  onLocationChange: () => void,
  tokenSymbol: string,
  addressSelected: boolean,
): Column[] {
  const block: Column = {
    key: "blockNumber",
    label: "Block",
    width: "11rem",
    render: (row) => (
      <div className="block-meta">
        <BlockNumberLink blockNumber={row.blockNumberDecimal} onLocationChange={onLocationChange} />
        <span className="block-meta-date">{fmtDate(row.blockDate, timeZone)}</span>
      </div>
    ),
  };
  const hash: Column = {
    key: "hash",
    label: "Hash",
    width: "13rem",
    render: (row) => (
      <CopyCell
        value={row.hash}
        label={shortHash(row.hash)}
        copyLabel="transaction hash"
        href={transactionDetailHref(row.hash)}
        onClick={(event) => {
          event.preventDefault();
          if (writeTransactionPermalink(row.hash)) onLocationChange();
        }}
      />
    ),
  };
  const arkivOps: Column = {
    key: "arkivOps",
    label: "Arkiv ops",
    width: "10rem",
    render: (row) =>
      row.operationsSummary?.length ? (
        <span className="op-badge-list">
          {row.operationsSummary.map((entry) => (
            <span key={entry.operationType} className={`op-badge op-${entry.operation}`}>
              {entry.count > 1 ? `${entry.operation} ×${entry.count}` : entry.operation}
            </span>
          ))}
        </span>
      ) : (
        <span className="tx-muted">—</span>
      ),
  };
  const from: Column = {
    key: "from",
    label: "From",
    width: "12rem",
    render: (row) => <AddressCell address={row.from} />,
  };
  const nonce: Column = {
    key: "nonce",
    label: "Nonce",
    className: "num",
    width: "5rem",
    render: (row) => row.nonce ?? "-",
  };
  const gas: Column = {
    key: "gasUsed",
    label: "Gas (used / limit)",
    className: "num",
    width: "10rem",
    render: (row) => `${fmtInteger(row.gasUsed)} / ${fmtInteger(row.gasLimit)}`,
  };
  const inputData: Column = {
    key: "inputDataSizeBytes",
    label: "Input data",
    className: "num",
    width: "5rem",
    render: (row) => fmtBytes(row.inputDataSizeBytes),
  };
  const inputDataCompressed: Column = {
    key: "inputDataCompressedSizeBytes",
    label: "Input zstd",
    className: "num",
    width: "5rem",
    render: (row) => fmtBytes(row.inputDataCompressedSizeBytes),
  };
  const effectiveFee: Column = {
    key: "effectiveGasPriceWei",
    label: "Effective fee (gwei)",
    className: "num",
    width: "8rem",
    render: (row) => fmtGwei(row.effectiveGasPriceWei),
  };
  const txFee: Column = {
    key: "transactionFeeWei",
    label: `Tx fee (${tokenSymbol})`,
    className: "num",
    width: "8rem",
    render: (row) => fmtEth(row.transactionFeeWei),
  };

  // When scoped to a single address every row shares the same sender, so the
  // From column is redundant — lead with the nonce instead.
  if (addressSelected) {
    return [nonce, block, hash, arkivOps, gas, inputData, inputDataCompressed, effectiveFee, txFee];
  }
  return [block, hash, arkivOps, from, nonce, gas, inputData, inputDataCompressed, effectiveFee, txFee];
}

function loadFilters(locationSearch: string, lockedAddress: string | null): TransactionFilters {
  if (lockedAddress) {
    // Address is fixed by the path; read the remaining filters from the query.
    // Skip the shared localStorage so this view never clobbers (or inherits)
    // the free /transactions view's stored address.
    const fromSearch = readFiltersFromSearch(locationSearch, FILTER_KEYS, EMPTY);
    return { ...fromSearch, address: lockedAddress };
  }
  const stored = readStoredStringRecord(STORAGE_KEY, EMPTY, FILTER_KEYS);
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, stored);
}

export function TransactionsView({
  locationSearch,
  onLocationChange,
  timeZone,
  tokenSymbol,
  lockedAddress = null,
}: TransactionsViewProps) {
  const locked = Boolean(lockedAddress?.trim());
  const lockedAddr = locked ? lockedAddress!.trim() : "";
  const [filters, setFilters] = useState<TransactionFilters>(() => loadFilters(locationSearch, lockedAddr || null));
  const [applied, setApplied] = useState<TransactionFilters>(filters);
  const [data, setData] = useState<TransactionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(true);

  // Address lives in the path here, so permalinks/share-links must route to
  // /address/<addr>; the free view keeps using /transactions?address=…
  const scopedWritePermalink = (f: TransactionFilters): boolean =>
    locked
      ? writeAddressPermalink(lockedAddr, permalinkFilters(f))
      : writePermalink("transactions", permalinkFilters(f));
  const scopedPermalinkHref = (f: TransactionFilters): string =>
    locked
      ? buildAddressPermalinkHref(lockedAddr, permalinkFilters(f))
      : buildPermalinkHref("transactions", permalinkFilters(f));

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
    if (locked) return;
    writeStoredStringRecord(STORAGE_KEY, filters, FILTER_KEYS);
  }, [filters, locked]);

  useEffect(() => {
    const next = loadFilters(locationSearch, lockedAddr || null);
    setFilters((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setApplied((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setCopyStatus("");
  }, [locationSearch, lockedAddr, setFilters]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (scopedWritePermalink(filters)) {
      onLocationChange();
    } else {
      setApplied(filters);
    }
  };

  const clearFilters = () => {
    // A locked address already scopes the query, so clearing can drop every
    // other filter; the free view needs block > 0 to keep showing rows.
    const cleared = locked ? { ...EMPTY, address: lockedAddr } : CLEARED;
    setFilters(cleared);
    if (scopedWritePermalink(cleared)) {
      onLocationChange();
    } else {
      setApplied(cleared);
    }
  };

  const copyPermalink = async () => {
    const href = scopedPermalinkHref(applied);
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
  const addressSelected = applied.address.trim() !== "";
  const columns = useMemo(
    () => transactionColumns(timeZone, onLocationChange, tokenSymbol, addressSelected),
    [timeZone, onLocationChange, tokenSymbol, addressSelected],
  );

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
    if (scopedWritePermalink(next)) {
      onLocationChange();
    } else {
      setApplied(next);
    }
  };

  const hasAppliedFilters = hasScopedFilters(applied);
  const activeFilterCount = countActiveFilters(filters, locked);
  const transactionLabel = applied.address.trim() ? "outgoing transactions" : "transactions";

  return (
    <section className="view transactions-view">
      <h2>Address transactions</h2>
      {locked ? (
        <div className="address-id">
          <AddressFace address={lockedAddr} />
          <CopyCell value={lockedAddr} label={lockedAddr} copyLabel="address" />
        </div>
      ) : null}
      <div className={`filters-panel${filtersOpen ? " open" : ""}`}>
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
          {activeFilterCount > 0 ? (
            <button type="button" className="link-button filters-clear" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
        </div>
        {filtersOpen ? (
          <form onSubmit={onSubmit} className="transactions-form">
            {locked ? null : (
              <label className="wide-field">
                address
                <input type="text" value={filters.address} onChange={setFilter("address")} />
              </label>
            )}
            <fieldset className="filter-group">
              <legend>Block</legend>
              <label>
                exact
                <input type="text" inputMode="numeric" value={filters.block} onChange={setFilter("block")} />
              </label>
              <label>
                &gt;
                <input
                  type="text"
                  inputMode="numeric"
                  value={filters.blockGt}
                  onChange={setFilter("blockGt")}
                  disabled={Boolean(filters.block.trim())}
                />
              </label>
              <label>
                &lt;
                <input
                  type="text"
                  inputMode="numeric"
                  value={filters.blockLt}
                  onChange={setFilter("blockLt")}
                  disabled={Boolean(filters.block.trim())}
                />
              </label>
            </fieldset>
            <fieldset className="filter-group">
              <legend>Nonce</legend>
              <label>
                &gt;
                <input type="text" inputMode="numeric" value={filters.nonceGt} onChange={setFilter("nonceGt")} />
              </label>
              <label>
                &lt;
                <input type="text" inputMode="numeric" value={filters.nonceLt} onChange={setFilter("nonceLt")} />
              </label>
            </fieldset>
            <fieldset className="filter-group">
              <legend>Date</legend>
              <label>
                &gt;
                <input type="text" value={filters.dateGt} onChange={setFilter("dateGt")} />
              </label>
              <label>
                &lt;
                <input type="text" value={filters.dateLt} onChange={setFilter("dateLt")} />
              </label>
            </fieldset>
            <fieldset className="filter-group">
              <legend>Paging</legend>
              <label>
                page size
                <input type="text" inputMode="numeric" value={filters.limit} onChange={setFilter("limit")} />
              </label>
              <label>
                page
                <input type="text" inputMode="numeric" value={filters.page} onChange={setFilter("page")} />
              </label>
            </fieldset>
            <div className="transactions-form-actions">
              {activeFilterCount > 0 ? (
                <button type="button" className="secondary" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
              <button type="submit">Query</button>
            </div>
          </form>
        ) : null}
      </div>

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

      <div className="cedric-table-wrap">
        <CedricOnTimer />
        {/* Opaque shelf hiding Cedric's body so only his head peeks over the
            table's top edge (the table-wrap clips its own overflow). */}
        <div className="cedric-shelf cedric-table-shelf" aria-hidden="true" />
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
  onClick,
}: {
  value: string | null | undefined;
  label: string;
  title?: string;
  copyLabel: string;
  href?: string | null;
  external?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
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
      onClick={onClick}
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
        <span aria-hidden="true" className="copy-cell-icon">
          {copied ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
            </svg>
          )}
        </span>
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

function countActiveFilters(filters: TransactionFilters, ignoreAddress = false): number {
  return [
    // On the locked /address page the address is the page scope, not a filter.
    ignoreAddress ? "" : filters.address,
    filters.block,
    // block > 0 is the "show everything" baseline, not a real narrowing filter
    filters.blockGt === BASELINE_BLOCK_GT ? "" : filters.blockGt,
    filters.blockLt,
    filters.nonceGt,
    filters.nonceLt,
    filters.dateGt,
    filters.dateLt,
  ].filter((value) => value.trim() !== "").length;
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
  if (key === "arkivOps") {
    return BigInt((row.operationsSummary ?? []).reduce((total, entry) => total + entry.count, 0));
  }
  if (
    key === "blockNumber" ||
    key === "position" ||
    key === "type" ||
    key === "nonce" ||
    key === "status" ||
    key === "valueWei" ||
    key === "gasLimit" ||
    key === "gasUsed" ||
    key === "inputDataSizeBytes" ||
    key === "inputDataCompressedSizeBytes" ||
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
