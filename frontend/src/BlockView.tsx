import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchBlockInspect, type BlockInspectResponse, type InspectedTransaction } from "./api";
import { fmtDate, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import { buildPermalinkHref, writePermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { transactionExplorerHref } from "./transactionLinks";

interface BlockViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
  noBatcher: boolean;
}

interface Column {
  key: string;
  label: string;
  className?: string;
  width: string;
  render: (row: InspectedTransaction) => ReactNode;
}

const EMPTY_BLOCK = "";

export function BlockView({ locationSearch, onLocationChange, timeZone, tokenSymbol, noBatcher }: BlockViewProps) {
  const [blockNumber, setBlockNumber] = useState(() => readBlockFromSearch(locationSearch));
  const [appliedBlockNumber, setAppliedBlockNumber] = useState(blockNumber);
  const [data, setData] = useState<BlockInspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const load = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    fetchBlockInspect(trimmed)
      .then((body) => setData(body))
      .catch((err: Error) => {
        setData(null);
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(appliedBlockNumber);
  }, [appliedBlockNumber, load]);

  useEffect(() => {
    const next = readBlockFromSearch(locationSearch);
    setBlockNumber(next);
    setAppliedBlockNumber(next);
    setCopyStatus("");
  }, [locationSearch]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = blockNumber.trim();
    if (writePermalink("block", { block: next })) {
      onLocationChange();
    } else {
      setAppliedBlockNumber(next);
    }
  };

  const copyPermalink = async () => {
    const href = buildPermalinkHref("block", { block: appliedBlockNumber });
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const block = data?.block;
  const columns = useMemo(() => transactionColumns(tokenSymbol), [tokenSymbol]);

  return (
    <section className="view block-view">
      <h2>Block info</h2>
      <form onSubmit={onSubmit} className="block-inspector-form">
        <label>
          block
          <input
            type="text"
            inputMode="numeric"
            value={blockNumber}
            onChange={(event) => setBlockNumber(event.target.value)}
          />
        </label>
        <button type="submit">Load</button>
      </form>

      <p className={`summary${error ? " error" : ""}`}>
        {loading
          ? "Loading..."
          : error
            ? `Failed to load block: ${error}`
            : block
              ? `Block ${block.blockNumberDecimal} with ${block.transactionCount} transactions`
              : "Enter a block number to inspect stored block details."}
      </p>

      <div className="permalink-row">
        <button type="button" className="secondary" onClick={copyPermalink} disabled={!appliedBlockNumber.trim()}>
          Copy link
        </button>
        {copyStatus ? <span>{copyStatus}</span> : null}
      </div>

      {block ? (
        <>
          <dl className="block-summary">
            <Metric label="Block" value={block.blockNumberDecimal} />
            <Metric label="Date" value={fmtDate(block.blockDate, timeZone)} />
            <Metric label="Transactions" value={fmtInteger(block.transactionCount)} />
            <Metric label="Base fee" value={`${fmtGwei(block.baseBlockFeeWei)} gwei`} />
            <Metric label="Gas used / limit" value={fmtRatio(block.totalGasUsed, block.maxGasInBlock)} />
            <Metric label="Block reward" value={`${fmtEth(block.blockRewardWei)} ${tokenSymbol}`} />
            <Metric label="Burnt fees" value={`${fmtEth(block.burntFeesWei)} ${tokenSymbol}`} />
            <Metric label="Total tx fees" value={`${fmtEth(block.totalTransactionFeeWei)} ${tokenSymbol}`} />
            <Metric label="Avg fee price" value={`${fmtGwei(block.averageFeePriceWei)} gwei`} />
            <Metric label="Avg tx fee" value={`${fmtEth(block.averageTransactionFeeWei)} ${tokenSymbol}`} />
            <Metric label="Avg tx gas" value={fmtInteger(block.averageTransactionGasUsed)} />
            <Metric label="Avg priority fee" value={`${fmtGwei(block.averagePriorityFeeWei)} gwei`} />
            <Metric
              label="Gas-weighted priority"
              value={`${fmtGwei(block.averagePriorityFeeWeightedWei)} gwei`}
            />
            {noBatcher ? null : (
              <>
                <Metric label="Batcher queue" value={fmtInteger(block.batcherQueueSize)} />
                <Metric label="Batcher intensity" value={fmtInteger(block.batcherIntensity)} />
                <Metric label="Batcher lower" value={fmtInteger(block.batcherLowerThreshold)} />
                <Metric label="Batcher upper" value={fmtInteger(block.batcherUpperThreshold)} />
                <Metric label="Batcher max block" value={fmtInteger(block.batcherMaxBlockSize)} />
                <Metric label="Batcher max tx" value={fmtInteger(block.batcherMaxTxSize)} />
              </>
            )}
          </dl>

          {data.transactionLoadError ? (
            <p className="summary error">Transactions unavailable: {data.transactionLoadError}</p>
          ) : null}

          <div className="table-wrap">
            <table className="data-table block-transactions-table">
              <colgroup>
                {columns.map((column) => (
                  <col key={column.key} style={{ width: column.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key} scope="col" className={column.className}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.transactions.map((row) => (
                  <tr key={`${row.position}:${row.hash}`}>
                    {columns.map((column) => (
                      <td key={column.key} className={column.className} data-label={column.label}>
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function transactionColumns(tokenSymbol: string): Column[] {
  return [
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
      render: (row) => <TransactionHashLink hash={row.hash} />,
    },
    {
      key: "from",
      label: "From",
      width: "12rem",
      render: (row) => <AddressCell address={row.from} />,
    },
    {
      key: "to",
      label: "To / contract",
      width: "12rem",
      render: (row) => <AddressCell address={row.to ?? row.contractAddress} />,
    },
    {
      key: "nonce",
      label: "Nonce",
      className: "num",
      width: "7rem",
      render: (row) => row.nonce ?? "-",
    },
    {
      key: "status",
      label: "Status",
      width: "6rem",
      render: (row) => statusLabel(row.status),
    },
    {
      key: "valueWei",
      label: `Value (${tokenSymbol})`,
      className: "num",
      width: "9rem",
      render: (row) => fmtEth(row.valueWei),
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
      key: "transactionFeeWei",
      label: `Tx fee (${tokenSymbol})`,
      className: "num",
      width: "10rem",
      render: (row) => fmtEth(row.transactionFeeWei),
    },
  ];
}

function readBlockFromSearch(search: string): string {
  const value = new URLSearchParams(search).get("block");
  return value?.trim() ?? EMPTY_BLOCK;
}

function TransactionHashLink({ hash }: { hash: string | null | undefined }) {
  const href = transactionExplorerHref(hash);
  if (!href) {
    return (
      <span className="mono truncate" title={hash ?? undefined}>
        {shortHash(hash)}
      </span>
    );
  }

  return (
    <a className="mono truncate block-link" href={href} target="_blank" rel="noreferrer" title={hash ?? undefined}>
      {shortHash(hash)}
    </a>
  );
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
