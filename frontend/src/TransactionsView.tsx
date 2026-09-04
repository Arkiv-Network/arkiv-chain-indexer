import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchTransactions, type StoredTransaction, type TransactionsResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { AddressFace } from "./AddressFace";
import { BlockCell } from "@/components/block-cell";
import { CopyCell } from "@/components/copy-cell";
import { OpBadgeList } from "@/components/op-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterField, FilterGroup, FiltersPanel } from "@/components/filters-panel";
import { cn } from "@/lib/utils";
import { CedricOnTimer } from "./Cedric";
import { fmtBytes, fmtGasPrice, fmtInteger, fmtTokenAmount } from "./format";
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
import { renderTableHeader, SortIcon } from "./tableHeader";

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
    render: (row) => (
      <BlockCell
        blockNumber={row.blockNumberDecimal}
        date={row.blockDate}
        timeZone={timeZone}
        onLocationChange={onLocationChange}
      />
    ),
  };
  const hash: Column = {
    key: "hash",
    label: "Hash",
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
    render: (row) => <OpBadgeList operations={row.operationsSummary} />,
  };
  const from: Column = {
    key: "from",
    label: "From",
    render: (row) => <AddressCell address={row.from} />,
  };
  const nonce: Column = {
    key: "nonce",
    label: "Nonce",
    className: "text-right font-mono tabular-nums",
    render: (row) => row.nonce ?? "-",
  };
  const gas: Column = {
    key: "gasUsed",
    label: "Gas (used / limit)",
    className: "text-right font-mono tabular-nums",
    render: (row) => `${fmtInteger(row.gasUsed)} / ${fmtInteger(row.gasLimit)}`,
  };
  const inputData: Column = {
    key: "inputDataSizeBytes",
    label: "Input data",
    className: "text-right font-mono tabular-nums",
    render: (row) => fmtBytes(row.inputDataSizeBytes),
  };
  const inputDataCompressed: Column = {
    key: "inputDataCompressedSizeBytes",
    label: "Input zstd",
    className: "text-right font-mono tabular-nums",
    render: (row) => fmtBytes(row.inputDataCompressedSizeBytes),
  };
  const effectiveFee: Column = {
    key: "effectiveGasPriceWei",
    label: "Effective fee",
    className: "text-right font-mono tabular-nums",
    render: (row) => fmtGasPrice(row.effectiveGasPriceWei),
  };
  const txFee: Column = {
    key: "transactionFeeWei",
    label: "Tx fee",
    className: "text-right font-mono tabular-nums",
    render: (row) => fmtTokenAmount(row.transactionFeeWei, tokenSymbol),
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
  // Column sorting reorders the rows already loaded, not the whole result set:
  // the server orders by block (or by nonce for an address) and pages from
  // there. Say so whenever the result spans more than one page, so a sorted
  // first page is not mistaken for the overall top.
  const sortIsPageLocal = sort !== null && (data?.totalPages ?? 0) > 1;
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
  const filtersChanged = activeFilterCount > 0 || filters.limit !== EMPTY.limit;

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <h2 className="font-heading text-lg font-black tracking-tight">Address transactions</h2>
      {locked ? (
        <div className="flex items-center gap-2 border border-border bg-card px-3 py-2">
          <AddressFace address={lockedAddr} />
          <CopyCell value={lockedAddr} label={lockedAddr} copyLabel="address" />
        </div>
      ) : null}

      <FiltersPanel
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        activeCount={activeFilterCount}
        onClearAll={activeFilterCount > 0 ? clearFilters : undefined}
      >
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          {locked ? null : (
            <FilterField label="Address" className="basis-full">
              <Input type="text" className="max-w-2xl font-mono" value={filters.address} onChange={setFilter("address")} />
            </FilterField>
          )}
          <FilterGroup label="Block">
            <FilterField label="exact">
              <Input type="text" inputMode="numeric" className="w-24" value={filters.block} onChange={setFilter("block")} />
            </FilterField>
            <FilterField label="&gt;">
              <Input
                type="text"
                inputMode="numeric"
                className="w-24"
                value={filters.blockGt}
                onChange={setFilter("blockGt")}
                disabled={Boolean(filters.block.trim())}
              />
            </FilterField>
            <FilterField label="&lt;">
              <Input
                type="text"
                inputMode="numeric"
                className="w-24"
                value={filters.blockLt}
                onChange={setFilter("blockLt")}
                disabled={Boolean(filters.block.trim())}
              />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Nonce">
            <FilterField label="&gt;">
              <Input type="text" inputMode="numeric" className="w-20" value={filters.nonceGt} onChange={setFilter("nonceGt")} />
            </FilterField>
            <FilterField label="&lt;">
              <Input type="text" inputMode="numeric" className="w-20" value={filters.nonceLt} onChange={setFilter("nonceLt")} />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Date">
            <FilterField label="&gt;">
              <Input type="text" className="w-48" value={filters.dateGt} onChange={setFilter("dateGt")} />
            </FilterField>
            <FilterField label="&lt;">
              <Input type="text" className="w-48" value={filters.dateLt} onChange={setFilter("dateLt")} />
            </FilterField>
          </FilterGroup>
          <FilterGroup label="Paging">
            <FilterField label="page size">
              <Input type="text" inputMode="numeric" className="w-20" value={filters.limit} onChange={setFilter("limit")} />
            </FilterField>
            <FilterField label="page">
              <Input type="text" inputMode="numeric" className="w-20" value={filters.page} onChange={setFilter("page")} />
            </FilterField>
          </FilterGroup>
          <div className="ml-auto flex items-center gap-2">
            {filtersChanged ? (
              <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                Clear
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              Query
            </Button>
          </div>
        </form>
      </FiltersPanel>

      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
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

      {sortIsPageLocal ? (
        <p className="text-xs text-muted-foreground" role="status">
          Sorting reorders the {data?.count ?? 0} rows on this page, not all {data?.totalCount ?? 0}{" "}
          matching transactions.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copyPermalink} disabled={!hasAppliedFilters}>
          Copy link
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => goToPage((data?.page ?? toPositiveInteger(applied.page, 1)) - 1)}
          disabled={!data?.hasPreviousPage || loading}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => goToPage((data?.page ?? toPositiveInteger(applied.page, 1)) + 1)}
          disabled={!data?.hasNextPage || loading}
        >
          Next
        </Button>
        {copyStatus ? <span className="text-xs text-muted-foreground">{copyStatus}</span> : null}
      </div>

      <div className="relative mt-6">
        <CedricOnTimer />
        <div className="relative z-10 overflow-x-auto border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((column) => (
                  <TableHead key={column.key} className={column.className}>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex w-full items-center gap-1 text-left font-medium hover:text-accent",
                        column.className?.includes("text-right") && "justify-end",
                      )}
                      onClick={() => setSortKey(column.key)}
                      title={
                        sortIsPageLocal
                          ? `Sort the rows on this page by ${column.label}`
                          : `Sort by ${column.label}`
                      }
                    >
                      <span>{renderTableHeader(column.label)}</span>
                      <SortIcon active={sort?.key === column.key} direction={sort?.key === column.key ? sort.direction : "asc"} />
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.blockNumberDecimal}:${row.position}:${row.hash}`}>
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

function shortHash(value: string | null | undefined): string {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
