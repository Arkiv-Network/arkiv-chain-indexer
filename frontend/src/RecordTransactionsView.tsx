import { useEffect, useState, type ReactNode } from "react";
import {
  fetchTransactionRecords,
  type StoredTransactionRecord,
  type TransactionRecordCategory,
  type TransactionRecordsResponse,
} from "./api";
import { AddressCell } from "./TransactionsView";
import { BlockCell } from "@/components/block-cell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtGasPrice, fmtInteger, fmtTokenAmount } from "./format";
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
  const num = "text-right font-mono tabular-nums";
  const sharedColumns: Column[] = [
    {
      key: "rank",
      label: "Rank",
      className: num,
      render: (row) => row.rank,
    },
    {
      key: "recordValue",
      label: category.valueLabel,
      className: num,
      render: category.renderValue,
    },
    {
      key: "block",
      label: "Block",
      render: (row) => (
        <BlockCell blockNumber={row.blockNumberDecimal} date={row.blockDate} timeZone={timeZone} onLocationChange={onLocationChange} />
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
      className: num,
      render: (row) => fmtInteger(row.gasUsed),
    },
    {
      key: "effectiveGasPriceWei",
      label: "Effective fee",
      className: num,
      render: (row) => fmtGasPrice(row.effectiveGasPriceWei),
    },
    {
      key: "transactionFeeWei",
      label: "Tx fee",
      className: num,
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
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <h2 className="font-heading text-lg font-black tracking-tight">Record transactions</h2>
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to query record transactions: ${error}`
            : data
              ? `Showing up to ${data.limit} transactions per record category.`
              : "No record transactions loaded."}
      </p>

      <div className="flex flex-col gap-6">
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
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{category.title}</h3>
        <span className="font-mono text-xs text-muted-foreground">{rows.length} rows</span>
      </div>
      <div className="overflow-x-auto border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead key={column.key} className={column.className}>
                  {renderTableHeader(column.label)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-xs text-muted-foreground">
                  No records stored yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={`${row.category}:${row.blockNumberDecimal}:${row.position}`}>
                  {columns.map((column) => (
                    <TableCell key={column.key} className={column.className} data-label={column.label}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
