import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchBlockInspect, type BlockInspectResponse, type InspectedTransaction } from "./api";
import { fmtDate, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import {
  buildPermalinkHref,
  filtersEqual,
  hasAnyFilterParam,
  readFiltersFromSearch,
  writePermalink,
} from "./permalinks";
import { loadFromStorage, usePersistentState } from "./persistentState";

interface BlockViewProps {
  locationSearch: string;
  onLocationChange: () => void;
}

interface BlockFilters extends Record<string, string> {
  block: string;
}

type SortDirection = "asc" | "desc";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

type SortKey =
  | "position"
  | "hash"
  | "from"
  | "to"
  | "type"
  | "status"
  | "valueWei"
  | "gasLimit"
  | "gasUsed"
  | "effectiveGasPriceWei"
  | "priorityFeeWei"
  | "maxPriorityFeePerGasWei"
  | "transactionFeeWei";

interface Column {
  key: SortKey;
  label: string;
  className?: string;
  width: string;
  render: (row: InspectedTransaction) => ReactNode;
}

const STORAGE_KEY = "gas-tracker.filters.block";
const FILTER_KEYS = ["block"] as const;
const EMPTY: BlockFilters = { block: "" };

const TX_COLUMNS: Column[] = [
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
    render: (row) => <span className="mono truncate">{shortHash(row.hash)}</span>,
  },
  {
    key: "from",
    label: "From",
    width: "12rem",
    render: (row) => <span className="mono truncate">{shortHash(row.from)}</span>,
  },
  {
    key: "to",
    label: "To / contract",
    width: "12rem",
    render: (row) => <span className="mono truncate">{shortHash(row.to ?? row.contractAddress)}</span>,
  },
  {
    key: "type",
    label: "Type",
    className: "num",
    width: "5rem",
    render: (row) => row.type ?? "-",
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

function loadFilters(locationSearch: string): BlockFilters {
  const stored = loadFromStorage<BlockFilters>(STORAGE_KEY, EMPTY);
  const fallback = hasAnyFilterParam(locationSearch, FILTER_KEYS) ? EMPTY : stored;
  return readFiltersFromSearch(locationSearch, FILTER_KEYS, fallback);
}

export function BlockView({ locationSearch, onLocationChange }: BlockViewProps) {
  const [filters, setFilters] = usePersistentState<BlockFilters>(STORAGE_KEY, loadFilters(locationSearch));
  const [applied, setApplied] = useState<BlockFilters>(filters);
  const [data, setData] = useState<BlockInspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "position", direction: "asc" });

  const load = useCallback((f: BlockFilters) => {
    const block = f.block.trim();
    if (!block) {
      setData(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fetchBlockInspect(block)
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
    const next = loadFilters(locationSearch);
    setFilters((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setApplied((current) => (filtersEqual(current, next, FILTER_KEYS) ? current : next));
    setCopyStatus("");
  }, [locationSearch, setFilters]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (writePermalink("block", filters)) {
      onLocationChange();
    } else {
      setApplied(filters);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("block", applied);
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const rows = useMemo(() => {
    const transactions = data?.block.transactions ?? [];
    return transactions.slice().sort((a, b) => compareRows(a, b, sort));
  }, [data, sort]);

  const setSortKey = (key: SortKey) => {
    setSort((current) => {
      if (current.key === key) {
        return { key, direction: current.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: defaultDirection(key) };
    });
  };

  const onBlockChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFilters({ block: e.target.value });
  };

  return (
    <section className="view block-view">
      <h2>Block inspector</h2>
      <form onSubmit={onSubmit} className="block-inspector-form">
        <label>
          block
          <input type="text" inputMode="numeric" value={filters.block} onChange={onBlockChange} />
        </label>
        <button type="submit">Inspect</button>
      </form>

      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to inspect block: ${error}`
            : data
              ? `${data.block.transactionCount} transactions${data.cached ? " - memory cache hit" : " - loaded from RPC"}`
              : "Enter a block number to inspect its transactions."}
      </p>

      <div className="permalink-row">
        <button type="button" className="secondary" onClick={copyPermalink} disabled={!applied.block.trim()}>
          Copy link
        </button>
        {copyStatus ? <span>{copyStatus}</span> : null}
      </div>

      {data ? <BlockSummary data={data} /> : null}

      <div className="table-wrap">
        <table className="data-table tx-table">
          <colgroup>
            {TX_COLUMNS.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {TX_COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  <button type="button" className="sort-header" onClick={() => setSortKey(column.key)}>
                    <span>{column.label}</span>
                    <span aria-hidden="true">{sort.key === column.key ? sortIcon(sort.direction) : ""}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.position}:${row.hash}`}>
                {TX_COLUMNS.map((column) => (
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

function BlockSummary({ data }: { data: BlockInspectResponse }) {
  const block = data.block;
  return (
    <dl className="block-summary">
      <div>
        <dt>Block</dt>
        <dd>{block.blockNumberDecimal}</dd>
      </div>
      <div>
        <dt>Date</dt>
        <dd>{fmtDate(block.blockDate)}</dd>
      </div>
      <div>
        <dt>Base fee</dt>
        <dd>{fmtGwei(block.baseBlockFeeWei)} gwei</dd>
      </div>
      <div>
        <dt>Gas used / limit</dt>
        <dd>{fmtRatio(block.totalGasUsed, block.maxGasInBlock)}</dd>
      </div>
      <div>
        <dt>Transactions</dt>
        <dd>{block.transactionCount}</dd>
      </div>
    </dl>
  );
}

function compareRows(a: InspectedTransaction, b: InspectedTransaction, sort: SortState): number {
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

function sortValue(row: InspectedTransaction, key: SortKey): string | bigint {
  if (
    key === "position" ||
    key === "type" ||
    key === "status" ||
    key === "valueWei" ||
    key === "gasLimit" ||
    key === "gasUsed" ||
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

function defaultDirection(key: SortKey): SortDirection {
  return key === "position" || key === "hash" || key === "from" || key === "to" ? "asc" : "desc";
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
