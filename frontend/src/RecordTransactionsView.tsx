import { useEffect, useState } from "react";
import {
  fetchTransactionRecords,
  type StoredTransactionRecord,
  type TransactionRecordCategory,
  type TransactionRecordsResponse,
} from "./api";
import { addressDisplay } from "./addressAliases";
import { BlockNumberLink } from "./blockLinks";
import { fmtDate, fmtEth, fmtGwei, fmtInteger } from "./format";
import { transactionExplorerHref } from "./transactionLinks";

interface RecordTransactionsViewProps {
  onLocationChange: () => void;
  timeZone: string;
}

const CATEGORIES: Array<{
  key: TransactionRecordCategory;
  title: string;
  valueLabel: string;
  renderValue: (row: StoredTransactionRecord) => string;
}> = [
  {
    key: "gas_used",
    title: "Maximum gas used",
    valueLabel: "Gas used",
    renderValue: (row) => fmtInteger(row.recordValue),
  },
  {
    key: "transaction_fee",
    title: "Maximum fee paid",
    valueLabel: "Fee paid (ETH)",
    renderValue: (row) => fmtEth(row.recordValue),
  },
  {
    key: "effective_fee",
    title: "Highest effective fee",
    valueLabel: "Effective fee (gwei)",
    renderValue: (row) => fmtGwei(row.recordValue),
  },
];

export function RecordTransactionsView({ onLocationChange, timeZone }: RecordTransactionsViewProps) {
  const [data, setData] = useState<TransactionRecordsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ limit: "20" });
    setLoading(true);
    setError(null);
    fetchTransactionRecords(params)
      .then((body) => setData(body))
      .catch((err: Error) => {
        setData(null);
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="view record-transactions-view">
      <h2>Record transactions</h2>
      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to query record transactions: ${error}`
            : data
              ? `Showing up to ${data.limit} transactions per record category.`
              : "No record transactions loaded."}
      </p>

      <div className="record-category-stack">
        {CATEGORIES.map((category) => (
          <RecordCategoryTable
            key={category.key}
            category={category}
            rows={data?.records[category.key] ?? []}
            onLocationChange={onLocationChange}
            timeZone={timeZone}
          />
        ))}
      </div>
    </section>
  );
}

function RecordCategoryTable({
  category,
  rows,
  onLocationChange,
  timeZone,
}: {
  category: (typeof CATEGORIES)[number];
  rows: StoredTransactionRecord[];
  onLocationChange: () => void;
  timeZone: string;
}) {
  return (
    <section className="record-category">
      <div className="record-category-heading">
        <h3>{category.title}</h3>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-wrap">
        <table className="data-table record-table">
          <thead>
            <tr>
              <th scope="col" className="num">Rank</th>
              <th scope="col" className="num">{category.valueLabel}</th>
              <th scope="col" className="num">Block</th>
              <th scope="col">Date</th>
              <th scope="col">Hash</th>
              <th scope="col">From</th>
              <th scope="col">To / contract</th>
              <th scope="col" className="num">Gas used</th>
              <th scope="col" className="num">Effective fee</th>
              <th scope="col" className="num">Tx fee</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10}>No records stored yet.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.category}:${row.blockNumberDecimal}:${row.position}`}>
                  <td className="num" data-label="Rank">{row.rank}</td>
                  <td className="num" data-label={category.valueLabel}>{category.renderValue(row)}</td>
                  <td className="num" data-label="Block">
                    <BlockNumberLink
                      blockNumber={row.blockNumberDecimal}
                      onLocationChange={onLocationChange}
                    />
                  </td>
                  <td data-label="Date">{fmtDate(row.blockDate, timeZone)}</td>
                  <td data-label="Hash">
                    <a
                      className="mono truncate"
                      href={transactionExplorerHref(row.hash) ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={row.hash}
                    >
                      {shortHash(row.hash)}
                    </a>
                  </td>
                  <td data-label="From">
                    <AddressText address={row.from} />
                  </td>
                  <td data-label="To / contract">
                    <AddressText address={row.to ?? row.contractAddress} />
                  </td>
                  <td className="num" data-label="Gas used">{fmtInteger(row.gasUsed)}</td>
                  <td className="num" data-label="Effective fee">{fmtGwei(row.effectiveGasPriceWei)}</td>
                  <td className="num" data-label="Tx fee">{fmtEth(row.transactionFeeWei)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AddressText({ address }: { address: string | null | undefined }) {
  const display = addressDisplay(address);
  return (
    <span className="mono truncate" title={display.title}>
      {display.label}
    </span>
  );
}

function shortHash(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}
