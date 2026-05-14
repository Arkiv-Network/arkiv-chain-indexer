import { useCallback, useEffect, useState } from "react";
import { fetchBlocks, type BlocksResponse } from "./api";
import { fmtDate, fmtGwei, fmtRatio } from "./format";

interface Filters {
  blockGt: string;
  blockLt: string;
  dateGt: string;
  dateLt: string;
}

const EMPTY: Filters = { blockGt: "", blockLt: "", dateGt: "", dateLt: "" };

function buildParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    const trimmed = v.trim();
    if (trimmed) params.set(k, trimmed);
  }
  return params;
}

export function BlocksView() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [data, setData] = useState<BlocksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setApplied(filters);
  };

  const onChange = (key: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

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
        <button type="submit">Search</button>
      </form>
      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading…"
          : error
            ? `Failed to load blocks: ${error}`
            : data
              ? `${data.count} blocks${data.truncated ? " (truncated to 10 000)" : ""}`
              : ""}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Block</th>
              <th>Date</th>
              <th>Tx count</th>
              <th>Base fee (gwei)</th>
              <th>Avg priority fee (gwei)</th>
              <th>Weighted avg priority (gwei)</th>
              <th>Avg tx fee (gwei)</th>
              <th>Gas used / limit</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.blockNumber}>
                <td className="num">{row.blockNumber}</td>
                <td>{fmtDate(row.blockDate)}</td>
                <td className="num">{row.transactionCount}</td>
                <td className="num">{fmtGwei(row.baseBlockFeeWei)}</td>
                <td className="num">{fmtGwei(row.averagePriorityFeeWei)}</td>
                <td className="num">{fmtGwei(row.averagePriorityFeeWeightedWei)}</td>
                <td className="num">{fmtGwei(row.averageTransactionFeeWei)}</td>
                <td className="num">{fmtRatio(row.totalGasUsed, row.maxGasInBlock)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
