import { Activity } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchSenders, type SendersResponse } from "./api";
import { BlockCell } from "@/components/block-cell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterField } from "@/components/filters-panel";
import { cn } from "@/lib/utils";
import { fmtMillions, fmtThousands, fmtTokenAmount } from "./format";
import { buildPermalinkHref, buildRouteHref, filtersEqual, readFiltersFromSearch, writePermalink } from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { AddressCell } from "./TransactionsView";
import { renderTableHeader } from "./tableHeader";

interface SendersViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}

interface SenderFilters extends Record<string, string> {
  limit: string;
}

const FILTER_KEYS = ["limit"] as const;
const STORAGE_KEY = "senders.filters";
const EMPTY: SenderFilters = {
  limit: "100",
};

function loadFilters(locationSearch: string): SenderFilters {
  const stored = readStoredStringRecord(STORAGE_KEY, EMPTY, FILTER_KEYS);
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, stored);
}

export function SendersView({ locationSearch, onLocationChange, timeZone, tokenSymbol }: SendersViewProps) {
  const [filters, setFilters] = useState<SenderFilters>(() => loadFilters(locationSearch));
  const [applied, setApplied] = useState<SenderFilters>(filters);
  const [data, setData] = useState<SendersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const load = useCallback((f: SenderFilters) => {
    const params = filtersToParams(f);
    setLoading(true);
    setError(null);
    fetchSenders(params)
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
  }, [locationSearch]);

  const setFilter = (key: keyof SenderFilters) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setFilters({ ...filters, [key]: event.target.value });
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (writePermalink("senders", permalinkFilters(filters))) {
      onLocationChange();
    } else {
      setApplied(filters);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("senders", permalinkFilters(applied));
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-black tracking-tight">Sender activity</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">{filters.limit} rows</span>
          <Button type="button" variant="outline" size="sm" onClick={copyPermalink}>
            Copy link
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 border border-border bg-card p-3">
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <FilterField label="Rows">
            <Input type="text" inputMode="numeric" className="w-24" value={filters.limit} onChange={setFilter("limit")} />
          </FilterField>
          <Button type="submit" size="sm">
            Query
          </Button>
        </form>
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {loading
            ? "Loading..."
            : error
              ? `Failed to query sender stats: ${error}`
              : data
                ? `${data.count} sender addresses shown${data.truncated ? " (limited)" : ""}`
                : "No sender stats loaded."}
        </p>
        {copyStatus ? <p className="text-xs text-muted-foreground">{copyStatus}</p> : null}
      </div>

      <div className="overflow-x-auto border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{renderTableHeader("Address")}</TableHead>
              <TableHead className="text-right">{renderTableHeader("Tx count")}</TableHead>
              <TableHead className="text-right">{renderTableHeader("Gas used")}</TableHead>
              <TableHead className="text-right">{renderTableHeader(`Fees spent (${tokenSymbol})`)}</TableHead>
              <TableHead className="text-right">{renderTableHeader("Avg gas per tx")}</TableHead>
              <TableHead className="text-right">{renderTableHeader(`Avg fee (${tokenSymbol})`)}</TableHead>
              <TableHead>{renderTableHeader("First tx (block/date)")}</TableHead>
              <TableHead>{renderTableHeader("Last tx (block/date)")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.senders ?? []).map((row) => (
              <TableRow key={row.address}>
                <TableCell data-label="Address">
                  <div className="flex items-center gap-1.5">
                    <AddressCell address={row.address} />
                    <ActivityLink address={row.address} onLocationChange={onLocationChange} />
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" data-label="Tx count">
                  {txCountFromNonce(row.latestNonce)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" data-label="Gas used">
                  {fmtMillions(row.totalGasUsed)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" data-label="Fees spent">
                  {fmtTokenAmount(row.totalTransactionFeeWei, tokenSymbol, { trimZeros: false })}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" data-label="Avg gas">
                  {fmtThousands(row.averageGasUsed)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums" data-label="Avg fee">
                  {fmtTokenAmount(row.averageTransactionFeeWei, tokenSymbol)}
                </TableCell>
                <TableCell data-label="First tx">
                  <BlockCell
                    blockNumber={row.firstBlockNumberDecimal}
                    date={row.firstBlockDate}
                    timeZone={timeZone}
                    onLocationChange={onLocationChange}
                  />
                </TableCell>
                <TableCell data-label="Last tx">
                  <BlockCell
                    blockNumber={row.lastBlockNumberDecimal}
                    date={row.lastBlockDate}
                    timeZone={timeZone}
                    onLocationChange={onLocationChange}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** Per-row link to the address's activity view (`/activity?address=0x…`). */
function ActivityLink({ address, onLocationChange }: { address: string; onLocationChange: () => void }) {
  const filters = { address, window: "24h" };
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (writePermalink("guzzlers", filters)) {
      onLocationChange();
    }
  };
  return (
    <a
      className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground opacity-70 transition-colors hover:text-accent hover:opacity-100"
      href={buildRouteHref("guzzlers", filters)}
      onClick={onClick}
      title="View activity"
      aria-label={`View activity for ${address}`}
    >
      <Activity className="size-3.5" />
    </a>
  );
}

/** An account's transaction count is its latest nonce + 1 (nonces start at 0). */
function txCountFromNonce(latestNonce: string | null): string {
  if (latestNonce === null) return "—";
  try {
    return (BigInt(latestNonce) + 1n).toString();
  } catch {
    return latestNonce;
  }
}

function filtersToParams(filters: SenderFilters): URLSearchParams {
  const normalized = permalinkFilters(filters);
  const params = new URLSearchParams();
  addParam(params, "limit", normalized.limit);
  params.set("order", "desc");
  return params;
}

function permalinkFilters(filters: SenderFilters): SenderFilters {
  return {
    limit: filters.limit.trim(),
  };
}

function addParam(params: URLSearchParams, key: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed) params.set(key, trimmed);
}
