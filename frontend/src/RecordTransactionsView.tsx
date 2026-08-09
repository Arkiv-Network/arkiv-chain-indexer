import { useEffect, useState, type ReactNode } from "react";
import {
  fetchTransactionRecords,
  type StoredTransactionRecord,
  type TransactionRecordCategory,
  type TransactionRecordsResponse,
} from "./api";
import { AddressCell } from "./TransactionsView";
import { BlockNumberLink } from "./blockLinks";
import { fmtDate, fmtGasPrice, fmtInteger, fmtTokenAmount } from "./format";
import { TransactionHashLink } from "./TransactionView";
import { renderTableHeader } from "./tableHeader";

interface RecordTransactionsViewProps {
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}

type RecordCategory = {
  key: TransactionRecordCategory;
  title: string;
  valueLabel: string;
  duplicateColumnKey: string;
  renderValue: (row: StoredTransactionRecord) => string;
};

interface Column {
  key: string;
  label: string;
  className?: string;
  render: (row: StoredTransactionRecord) => ReactNode;
}

function categories(tokenSymbol: string): RecordCategory[] {
  return [
    {
      key: "gas_used",
      title: "Maximum gas used",
      valueLabel: "Gas used",
      duplicateColumnKey: "gasUsed",
      renderValue: (row) => fmtInteger(row.recordValue),
    },
    {
      key: "transaction_fee",
      title: "Maximum fee paid",
      valueLabel: "Fee paid",
      duplicateColumnKey: "transactionFeeWei",
      renderValue: (row) => fmtTokenAmount(row.recordValue, tokenSymbol),
    },
    {
      key: "effective_fee",
      title: "Highest effective fee",
      valueLabel: "Effective fee",
      duplicateColumnKey: "effectiveGasPriceWei",
      renderValue: (row) => fmtGasPrice(row.recordValue),
    },
  ];
}

function recordColumns(
  category: RecordCategory,
  onLocationChange: () => void,
  timeZone: string,
  tokenSymbol: string,
): Column[] {
  const sharedColumns: Column[] = [
    {
      key: "rank",
      label: "Rank",
      className: "num",
      render: (row) => row.rank,
    },
    {
      key: "recordValue",
      label: category.valueLabel,
      className: "num",
      render: category.renderValue,
    },
    {
      key: "block",
      label: "Block",
      render: (row) => (
        <div className="block-meta">
          <BlockNumberLink blockNumber={row.blockNumberDecimal} onLocationChange={onLocationChange} />
          <span className="block-meta-date">{fmtDate(row.blockDate, timeZone)}</span>
        </div>
      ),
    },
    {
      key: "hash",
      label: "Hash",
      render: (row) => <TransactionHashLink hash={row.hash} onLocationChange={onLocationChange} />,
    },
    {
      key: "from",
      label: "From",
      render: (row) => <AddressCell address={row.from} />,
    },
  ];
  const metricColumns: Column[] = [
    {
      key: "gasUsed",
      label: "Gas Used",
      className: "num",
      render: (row) => fmtInteger(row.gasUsed),
    },
    {
      key: "effectiveGasPriceWei",
      label: "Effective fee",
      className: "num",
      render: (row) => fmtGasPrice(row.effectiveGasPriceWei),
    },
    {
      key: "transactionFeeWei",
      label: "Tx fee",
      className: "num",
      render: (row) => fmtTokenAmount(row.transactionFeeWei, tokenSymbol),
    },
  ];

  return sharedColumns.concat(metricColumns.filter((column) => column.key !== category.duplicateColumnKey));
}

export function recordColumnLabelsForCategory(
  categoryKey: TransactionRecordCategory,
  tokenSymbol: string,
): string[] {
  const category = categories(tokenSymbol).find((candidate) => candidate.key === categoryKey);
  if (!category) return [];

  return recordColumns(category, () => {}, "UTC", tokenSymbol).map((column) => column.label);
}

export function RecordTransactionsView({ onLocationChange, timeZone, tokenSymbol }: RecordTransactionsViewProps) {
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
        {categories(tokenSymbol).map((category) => (
          <RecordCategoryTable
            key={category.key}
            category={category}
            rows={data?.records[category.key] ?? []}
            onLocationChange={onLocationChange}
            timeZone={timeZone}
            tokenSymbol={tokenSymbol}
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
  tokenSymbol,
}: {
  category: RecordCategory;
  rows: StoredTransactionRecord[];
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}) {
  const columns = recordColumns(category, onLocationChange, timeZone, tokenSymbol);

  return (
    <section className="record-category">
      <div className="record-category-heading">
        <h3>{category.title}</h3>
        <span>{rows.length} rows</span>
      </div>
      <div className="table-wrap">
          <table className="data-table tx-table record-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" className={column.className}>
                  {renderTableHeader(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>No records stored yet.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={`${row.category}:${row.blockNumberDecimal}:${row.position}`}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className} data-label={column.label}>
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
