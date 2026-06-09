import { useCallback, useEffect, useState } from "react";
import { fetchSenders, type SendersResponse } from "./api";
import { BlockNumberLink } from "./blockLinks";
import { fmtDate, fmtEth, fmtMillions, fmtThousands } from "./format";
import { buildPermalinkHref, filtersEqual, readFiltersFromSearch, writePermalink } from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { AddressCell } from "./TransactionsView";

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
    <section className="view senders-view">
      <h2>Sender activity</h2>
      <form onSubmit={onSubmit} className="senders-form">
        <label>
          rows
          <input type="text" inputMode="numeric" value={filters.limit} onChange={setFilter("limit")} />
        </label>
        <button type="submit">Query</button>
      </form>

      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to query sender stats: ${error}`
            : data
              ? `${data.count} sender addresses shown${data.truncated ? " (limited)" : ""}`
              : "No sender stats loaded."}
      </p>

      <div className="permalink-row">
        <button type="button" className="secondary" onClick={copyPermalink}>
          Copy link
        </button>
        {copyStatus ? <span>{copyStatus}</span> : null}
      </div>

      <div className="table-wrap">
        <table className="data-table sender-table">
          <colgroup>
            <col style={{ width: "13rem" }} />{/* Address */}
            <col style={{ width: "7.5rem" }} />{/* Tx count */}
            <col style={{ width: "7.5rem" }} />{/* Gas used */}
            <col style={{ width: "8.5rem" }} />{/* Fees spent */}
            <col style={{ width: "7rem" }} />{/* Avg gas */}
            <col style={{ width: "8rem" }} />{/* Avg fee */}
            <col style={{ width: "13rem" }} />{/* First tx */}
            <col style={{ width: "13rem" }} />{/* Last tx */}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col" className="num">Tx count</th>
              <th scope="col" className="num">Gas used</th>
              <th scope="col" className="num">Fees spent ({tokenSymbol})</th>
              <th scope="col" className="num">Avg gas</th>
              <th scope="col" className="num">Avg fee ({tokenSymbol})</th>
              <th scope="col">First tx</th>
              <th scope="col">Last tx</th>
            </tr>
          </thead>
          <tbody>
            {(data?.senders ?? []).map((row) => (
              <tr key={row.address}>
                <td data-label="Address">
                  <AddressCell address={row.address} />
                </td>
                <td className="num" data-label="Tx count">{txCountFromNonce(row.latestNonce)}</td>
                <td className="num" data-label="Gas used">{fmtMillions(row.totalGasUsed)}</td>
                <td className="num" data-label={`Fees spent (${tokenSymbol})`}>{fmtEth(row.totalTransactionFeeWei, { trimZeros: false })}</td>
                <td className="num" data-label="Avg gas">{fmtThousands(row.averageGasUsed)}</td>
                <td className="num" data-label={`Avg fee (${tokenSymbol})`}>{fmtEth(row.averageTransactionFeeWei)}</td>
                <td data-label="First tx">
                  <div className="block-meta">
                    <BlockNumberLink
                      blockNumber={row.firstBlockNumberDecimal}
                      onLocationChange={onLocationChange}
                    />
                    <span className="block-meta-date">{fmtDate(row.firstBlockDate, timeZone)}</span>
                  </div>
                </td>
                <td data-label="Last tx">
                  <div className="block-meta">
                    <BlockNumberLink
                      blockNumber={row.lastBlockNumberDecimal}
                      onLocationChange={onLocationChange}
                    />
                    <span className="block-meta-date">{fmtDate(row.lastBlockDate, timeZone)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
