import { useCallback, useEffect, useState } from "react";
import { fetchRanges, type RangesResponse } from "./api";
import { fmtDate, fmtGwei, fmtRatio } from "./format";

interface Filters {
  rangeSize: string;
  rangeStartGt: string;
  rangeStartLt: string;
  dateGt: string;
  dateLt: string;
}

const RANGE_SIZES = ["2", "5", "10", "20", "50", "100", "200", "500", "1000"];
const EMPTY: Filters = {
  rangeSize: "100",
  rangeStartGt: "",
  rangeStartLt: "",
  dateGt: "",
  dateLt: "",
};

function buildParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    const trimmed = v.trim();
    if (trimmed) params.set(k, trimmed);
  }
  return params;
}

export function RangesView() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [data, setData] = useState<RangesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setApplied(filters);
  };

  const onTextChange = (key: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const onSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilters((prev) => ({ ...prev, rangeSize: e.target.value }));
  };

  const sorted = data
    ? data.ranges.slice().sort((a, b) => b.rangeStart - a.rangeStart)
    : [];

  return (
    <section className="view">
      <h2>Aggregated ranges</h2>
      <form onSubmit={onSubmit}>
        <label>
          rangeSize
          <select value={filters.rangeSize} onChange={onSelectChange}>
            {RANGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          rangeStartGt
          <input
            type="text"
            inputMode="numeric"
            value={filters.rangeStartGt}
            onChange={onTextChange("rangeStartGt")}
          />
        </label>
        <label>
          rangeStartLt
          <input
            type="text"
            inputMode="numeric"
            value={filters.rangeStartLt}
            onChange={onTextChange("rangeStartLt")}
          />
        </label>
        <label>
          dateGt (ISO)
          <input
            type="text"
            placeholder="2024-01-01T00:00:00Z"
            value={filters.dateGt}
            onChange={onTextChange("dateGt")}
          />
        </label>
        <label>
          dateLt (ISO)
          <input
            type="text"
            placeholder="2024-12-31T00:00:00Z"
            value={filters.dateLt}
            onChange={onTextChange("dateLt")}
          />
        </label>
        <button type="submit">Search</button>
      </form>
      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading…"
          : error
            ? `Failed to load ranges: ${error}`
            : data
              ? `${data.count} ranges${data.truncated ? " (truncated to 10 000)" : ""}`
              : ""}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Range size</th>
              <th>Start</th>
              <th>End</th>
              <th>Min date</th>
              <th>Max date</th>
              <th>Avg base fee (gwei)</th>
              <th>Avg priority fee (gwei)</th>
              <th>Weighted avg priority (gwei)</th>
              <th>Tx count</th>
              <th>Gas used / total max</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={`${row.rangeSize}-${row.rangeStart}`}>
                <td className="num">{row.rangeSize}</td>
                <td className="num">{row.rangeStart}</td>
                <td className="num">{row.rangeEnd}</td>
                <td>{fmtDate(row.minBlockDate)}</td>
                <td>{fmtDate(row.maxBlockDate)}</td>
                <td className="num">{fmtGwei(row.averageBaseFeeWei)}</td>
                <td className="num">{fmtGwei(row.averagePriorityFeeWei)}</td>
                <td className="num">{fmtGwei(row.averagePriorityFeeWeightedWei)}</td>
                <td className="num">{row.transactionCount}</td>
                <td className="num">{fmtRatio(row.totalGasUsed, row.totalMaxGas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
