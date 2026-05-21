import { useCallback, useEffect, useState } from "react";
import { fetchSenders, type SendersResponse } from "./api";
import { BlockNumberLink } from "./blockLinks";
import { fmtDate, fmtEth, fmtInteger } from "./format";
import { buildPermalinkHref, filtersEqual, readFiltersFromSearch, writePermalink } from "./permalinks";
import { readStoredStringRecord, writeStoredStringRecord } from "./localStorage";
import { AddressCell } from "./TransactionsView";

interface SendersViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
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

export function SendersView({ locationSearch, onLocationChange, timeZone }: SendersViewProps) {
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
            <col style={{ width: "13rem" }} />
            <col style={{ width: "8rem" }} />
            <col style={{ width: "8rem" }} />
            <col style={{ width: "10rem" }} />
            <col style={{ width: "11rem" }} />
            <col style={{ width: "11rem" }} />
            <col style={{ width: "10rem" }} />
            <col style={{ width: "10rem" }} />
            <col style={{ width: "9rem" }} />
            <col style={{ width: "13rem" }} />
            <col style={{ width: "9rem" }} />
            <col style={{ width: "13rem" }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col" className="num">Tx found</th>
              <th scope="col" className="num">Latest nonce</th>
              <th scope="col" className="num">Gas used</th>
              <th scope="col" className="num">Fees spent (ETH)</th>
              <th scope="col" className="num">Value sent (ETH)</th>
              <th scope="col" className="num">Avg gas</th>
              <th scope="col" className="num">Avg fee (ETH)</th>
              <th scope="col" className="num">First tx block</th>
              <th scope="col">First tx date</th>
              <th scope="col" className="num">Last tx block</th>
              <th scope="col">Last tx date</th>
            </tr>
          </thead>
          <tbody>
            {(data?.senders ?? []).map((row) => (
              <tr key={row.address}>
                <td data-label="Address">
                  <AddressCell address={row.address} />
                </td>
                <td className="num" data-label="Tx found">{fmtInteger(row.transactionCount)}</td>
                <td className="num" data-label="Latest nonce">{fmtInteger(row.latestNonce)}</td>
                <td className="num" data-label="Gas used">{fmtInteger(row.totalGasUsed)}</td>
                <td className="num" data-label="Fees spent (ETH)">{fmtEth(row.totalTransactionFeeWei)}</td>
                <td className="num" data-label="Value sent (ETH)">{fmtEth(row.totalValueWei)}</td>
                <td className="num" data-label="Avg gas">{fmtInteger(row.averageGasUsed)}</td>
                <td className="num" data-label="Avg fee (ETH)">{fmtEth(row.averageTransactionFeeWei)}</td>
                <td className="num" data-label="First tx block">
                  <BlockNumberLink
                    blockNumber={row.firstBlockNumberDecimal}
                    onLocationChange={onLocationChange}
                  />
                </td>
                <td data-label="First tx date">
                  <BlockNumberLink
                    blockNumber={row.firstBlockNumberDecimal}
                    label={fmtDate(row.firstBlockDate, timeZone)}
                    onLocationChange={onLocationChange}
                  />
                </td>
                <td className="num" data-label="Last tx block">
                  <BlockNumberLink
                    blockNumber={row.lastBlockNumberDecimal}
                    onLocationChange={onLocationChange}
                  />
                </td>
                <td data-label="Last tx date">
                  <BlockNumberLink
                    blockNumber={row.lastBlockNumberDecimal}
                    label={fmtDate(row.lastBlockDate, timeZone)}
                    onLocationChange={onLocationChange}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
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
