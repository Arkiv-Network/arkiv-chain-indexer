import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchBlockInspect,
  fetchLatestBlockInspect,
  type BlockInspectResponse,
  type InspectedTransaction,
} from "./api";
import { fmtBytes, fmtDate, fmtGasPrice, fmtInteger, fmtRatio, fmtTokenAmount } from "./format";
import { PageBreadcrumbs } from "./PageBreadcrumbs";
import { buildPermalinkHref, writePermalink } from "./permalinks";
import { AddressCell } from "./TransactionsView";
import { TransactionHashLink } from "./TransactionView";
import { renderTableHeader } from "./tableHeader";

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
  const loadRequestId = useRef(0);

  const load = useCallback((value: string) => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    const trimmed = value.trim();
    setLoading(true);
    setError(null);
    const request = trimmed ? fetchBlockInspect(trimmed) : fetchLatestBlockInspect();
    request
      .then((body) => {
        if (requestId !== loadRequestId.current) return;
        setData(body);
        if (!trimmed) {
          setBlockNumber((current) => (current.trim() ? current : body.block.blockNumberDecimal));
        }
      })
      .catch((err: Error) => {
        if (requestId !== loadRequestId.current) return;
        setData(null);
        setError(err.message);
      })
      .finally(() => {
        if (requestId === loadRequestId.current) {
          setLoading(false);
        }
      });
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
    const href = buildPermalinkHref("block", { block: displayedBlockNumber });
    try {
      await navigator.clipboard.writeText(href);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus(href);
    }
  };

  const block = data?.block;
  // Show the requested number already while loading: the status label and the
  // adjacent-block buttons then keep the exact same width when the response
  // lands, instead of shifting the lookup panel.
  const displayedBlockNumber = block?.blockNumberDecimal ?? appliedBlockNumber;
  const adjacentBlocks = useMemo(() => adjacentBlockNumbers(displayedBlockNumber), [displayedBlockNumber]);
  const columns = useMemo(
    () => transactionColumns(tokenSymbol, onLocationChange),
    [tokenSymbol, onLocationChange],
  );

  const navigateToBlock = (nextBlock: string) => {
    setCopyStatus("");
    setBlockNumber(nextBlock);
    if (writePermalink("block", { block: nextBlock })) {
      onLocationChange();
    } else {
      setAppliedBlockNumber(nextBlock);
    }
  };

  return (
    <section className="view block-view">
      <div className="page-heading">
        <PageBreadcrumbs
          items={[
            { view: "home", label: "Home" },
            { view: "blocks", label: "Block list" },
            { view: "block", label: "Block details" },
          ]}
          onLocationChange={onLocationChange}
        />
        <h2>Block info</h2>
      </div>
      <div className="block-lookup">
        <form onSubmit={onSubmit} className="block-lookup-form">
          <div className="block-lookup-field">
            <label htmlFor="block-number-input">Block number</label>
            <div className="block-lookup-input">
              <span className="block-lookup-hash" aria-hidden="true">
                #
              </span>
              <input
                id="block-number-input"
                type="text"
                inputMode="numeric"
                placeholder="e.g. 29668"
                value={blockNumber}
                onChange={(event) => setBlockNumber(event.target.value)}
              />
            </div>
          </div>
          <button type="submit" className="block-lookup-load" disabled={loading}>
            {loading ? "Loading…" : "Load"}
          </button>
        </form>

        <div className="block-lookup-meta">
          <p className={`block-lookup-status${error ? " error" : ""}`}>
            <span className="block-lookup-status-label">
              Block <strong>{displayedBlockNumber.trim() || "—"}</strong>
            </span>
            {loading ? (
              <span className="block-lookup-txcount">Loading…</span>
            ) : error ? (
              <span className="block-lookup-txcount">Failed to load block: {error}</span>
            ) : block ? (
              <span className="block-lookup-txcount">{block.transactionCount} txns</span>
            ) : (
              <span className="block-lookup-txcount">Enter a block number to inspect stored block details.</span>
            )}
          </p>

          <div className="block-lookup-actions">
            <div className="block-adjacent-nav" aria-label="Adjacent blocks">
              <button
                type="button"
                className="block-adjacent-button"
                onClick={() => adjacentBlocks.previous && navigateToBlock(adjacentBlocks.previous)}
                disabled={loading || !adjacentBlocks.previous}
                aria-label="Previous block"
                title="Previous block"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{adjacentBlocks.previous ?? "Prev"}</span>
              </button>
              <button
                type="button"
                className="block-adjacent-button"
                onClick={() => adjacentBlocks.next && navigateToBlock(adjacentBlocks.next)}
                disabled={loading || !adjacentBlocks.next}
                aria-label="Next block"
                title="Next block"
              >
                <span>{adjacentBlocks.next ?? "Next"}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className="block-lookup-copy"
              onClick={copyPermalink}
              disabled={!displayedBlockNumber.trim()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Copy link
            </button>
            {copyStatus ? <span className="block-lookup-copied">{copyStatus}</span> : null}
          </div>
        </div>
      </div>

      {block ? (
        <>
          <dl className="block-summary">
            <Metric label="Block" value={block.blockNumberDecimal} />
            <Metric label="Date" value={fmtDate(block.blockDate, timeZone)} />
            <Metric label="Block time" value={`${fmtInteger(block.blockTimeSeconds)}s`} />
            <Metric label="Transactions" value={fmtInteger(block.transactionCount)} />
            <Metric label="Base fee" value={fmtGasPrice(block.baseBlockFeeWei)} />
            <Metric label="Gas used / limit" value={fmtRatio(block.totalGasUsed, block.maxGasInBlock)} />
            <Metric label="Input data" value={fmtBytes(block.totalInputDataSizeBytes)} />
            <Metric label="Input data zstd" value={fmtBytes(block.totalInputDataCompressedSizeBytes)} />
            <Metric label="Block reward" value={fmtTokenAmount(block.blockRewardWei, tokenSymbol)} />
            <Metric label="Burnt fees" value={fmtTokenAmount(block.burntFeesWei, tokenSymbol)} />
            <Metric label="Total tx fees" value={fmtTokenAmount(block.totalTransactionFeeWei, tokenSymbol)} />
            <Metric label="Avg fee price" value={fmtGasPrice(block.averageFeePriceWei)} />
            <Metric label="Avg tx fee" value={fmtTokenAmount(block.averageTransactionFeeWei, tokenSymbol)} />
            <Metric label="Avg tx gas" value={fmtInteger(block.averageTransactionGasUsed)} />
            <Metric label="Avg tx input data" value={fmtBytes(block.averageTransactionInputDataSizeBytes)} />
            <Metric
              label="Avg tx input zstd"
              value={fmtBytes(block.averageTransactionInputDataCompressedSizeBytes)}
            />
            <Metric label="Avg priority fee" value={fmtGasPrice(block.averagePriorityFeeWei)} />
            <Metric
              label="Gas-weighted priority"
              value={fmtGasPrice(block.averagePriorityFeeWeightedWei)}
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
            <table className="data-table tx-table block-transactions-table">
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
      ) : loading ? (
        <BlockDetailSkeleton rows={noBatcher ? 18 : 24} />
      ) : null}
    </section>
  );
}

/**
 * Placeholder matching the loaded layout (summary grid plus transactions
 * table) so the first data render replaces it in place instead of pushing
 * everything below the lookup panel down.
 */
function BlockDetailSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-label="Loading block details">
      <dl className="block-summary" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index}>
            <dt>
              <span className="skeleton-bar skeleton-label" />
            </dt>
            <dd>
              <span className="skeleton-bar skeleton-value" />
            </dd>
          </div>
        ))}
      </dl>
      <div className="table-wrap" aria-hidden="true">
        <div className="skeleton-table" />
      </div>
    </div>
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

function transactionColumns(tokenSymbol: string, onLocationChange: () => void): Column[] {
  return [
    {
      key: "position",
      label: "Pos",
      className: "num",
      render: (row) => row.position,
    },
    {
      key: "hash",
      label: "Hash",
      render: (row) => <TransactionHashLink hash={row.hash} onLocationChange={onLocationChange} />,
    },
    {
      key: "arkivOps",
      label: "Arkiv ops",
      render: (row) =>
        row.operationsSummary?.length ? (
          <span className="op-badge-list">
            {row.operationsSummary.map((entry) => (
              <span key={entry.operationType} className={`op-badge op-${entry.operation}`}>
                {entry.count > 1 ? `${entry.operation} ×${entry.count}` : entry.operation}
              </span>
            ))}
          </span>
        ) : (
          <span className="tx-muted">—</span>
        ),
    },
    {
      key: "from",
      label: "From",
      render: (row) => <AddressCell address={row.from} />,
    },
    {
      key: "nonce",
      label: "Nonce",
      className: "num",
      render: (row) => row.nonce ?? "-",
    },
    {
      key: "gasUsed",
      label: "Gas (used / limit)",
      className: "num",
      render: (row) => `${fmtInteger(row.gasUsed)} / ${fmtInteger(row.gasLimit)}`,
    },
    {
      key: "inputDataSizeBytes",
      label: "Input data",
      className: "num",
      render: (row) => fmtBytes(row.inputDataSizeBytes),
    },
    {
      key: "inputDataCompressedSizeBytes",
      label: "Input zstd",
      className: "num",
      render: (row) => fmtBytes(row.inputDataCompressedSizeBytes),
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
}

function readBlockFromSearch(search: string): string {
  const value = new URLSearchParams(search).get("block");
  return value?.trim() ?? EMPTY_BLOCK;
}

export function adjacentBlockNumbers(value: string): { previous: string | null; next: string | null } {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { previous: null, next: null };

  const current = BigInt(trimmed);
  return {
    previous: current > 0n ? String(current - 1n) : null,
    next: String(current + 1n),
  };
}
