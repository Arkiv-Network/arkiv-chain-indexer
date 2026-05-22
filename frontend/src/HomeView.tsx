import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchBlocks,
  fetchTransactions,
  type BlocksResponse,
  type StoredBlock,
  type StoredTransaction,
  type TransactionsResponse,
} from "./api";
import { AddressCell } from "./TransactionsView";
import { BlockNumberLink } from "./blockLinks";
import { fmtDate, fmtEth, fmtGwei, fmtInteger, fmtRatio } from "./format";
import { transactionExplorerHref } from "./transactionLinks";
import { buildPermalinkHref, writePermalink } from "./permalinks";

interface HomeViewProps {
  transactionDataEnabled: boolean | null;
  onLocationChange: () => void;
  timeZone: string;
}

const LATEST_BLOCK_LIMIT = "10";
const LATEST_TRANSACTION_LIMIT = "10";
const REFRESH_INTERVAL_MS = 12_000;

export function HomeView({ transactionDataEnabled, onLocationChange, timeZone }: HomeViewProps) {
  const [blocksData, setBlocksData] = useState<BlocksResponse | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [transactionsData, setTransactionsData] = useState<TransactionsResponse | null>(null);
  const [transactionsUnavailable, setTransactionsUnavailable] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const loadLatest = useCallback(async () => {
    setBlocksLoading(true);
    setBlocksError(null);

    try {
      const nextBlocks = await fetchBlocks(latestBlocksParams());
      setBlocksData(nextBlocks);
      setLastUpdatedAt(new Date());
    } catch (error) {
      setBlocksError(error instanceof Error ? error.message : String(error));
    } finally {
      setBlocksLoading(false);
    }

    if (transactionDataEnabled !== true) {
      setTransactionsData(null);
      setTransactionsUnavailable(true);
      return;
    }

    try {
      const nextTransactions = await fetchTransactions(latestTransactionsParams());
      setTransactionsData(nextTransactions);
      setTransactionsUnavailable(nextTransactions.transactions.length === 0);
    } catch {
      setTransactionsData(null);
      setTransactionsUnavailable(true);
    }
  }, [transactionDataEnabled]);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      await loadLatest();
    };

    void refresh();
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadLatest]);

  const blocks = blocksData?.blocks ?? [];
  const latestBlock = blocks[0] ?? null;
  const transactions = transactionsData?.transactions ?? [];
  const showTransactions = transactionDataEnabled === true && !transactionsUnavailable && transactions.length > 0;
  const blocksHref = buildPermalinkHref("blocks", { limit: "100" });
  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdatedAt) return "Waiting for data";
    return `Updated ${lastUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }, [lastUpdatedAt]);

  const openBlocksView = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (writePermalink("blocks", { limit: "100" })) {
      onLocationChange();
    }
  };

  return (
    <section className="home-view">
      <div className="home-hero">
        <div>
          <p className="home-kicker">Arkiv chain explorer</p>
          <h2>Latest blocks</h2>
          <p className="home-lede">Newest indexed blocks and transactions.</p>
        </div>
        <div className="home-status" aria-live="polite">
          <span>{blocksLoading ? "Refreshing..." : lastUpdatedLabel}</span>
          <a href={blocksHref} onClick={openBlocksView}>
            View all blocks
          </a>
        </div>
      </div>

      <div className="home-stats">
        <MetricCard label="Latest block" value={latestBlock ? latestBlock.blockNumber.toString() : "-"} />
        <MetricCard label="Base fee" value={latestBlock ? `${fmtGwei(latestBlock.baseBlockFeeWei)} gwei` : "-"} />
        <MetricCard label="Transactions" value={latestBlock ? fmtInteger(latestBlock.transactionCount) : "-"} />
        <MetricCard
          label="Gas used"
          value={latestBlock ? fmtRatio(latestBlock.totalGasUsed, latestBlock.maxGasInBlock) : "-"}
        />
      </div>

      <div className={`home-feed-grid${showTransactions ? "" : " single"}`}>
        <section className="home-feed-panel" aria-labelledby="home-latest-blocks">
          <div className="home-panel-heading">
            <h3 id="home-latest-blocks">Latest blocks</h3>
            <span>{blocksData ? `${blocksData.count} shown` : blocksLoading ? "Loading" : "No data"}</span>
          </div>
          {blocksError ? (
            <p className="summary error">Failed to load blocks: {blocksError}</p>
          ) : (
            <div className="home-feed-list">
              {blocks.map((block) => (
                <BlockFeedItem
                  key={block.blockNumber}
                  block={block}
                  onLocationChange={onLocationChange}
                  timeZone={timeZone}
                />
              ))}
              {!blocksLoading && blocks.length === 0 ? <p className="home-empty">No stored blocks yet.</p> : null}
            </div>
          )}
        </section>

        {showTransactions ? (
          <section className="home-feed-panel" aria-labelledby="home-latest-transactions">
            <div className="home-panel-heading">
              <h3 id="home-latest-transactions">Latest transactions</h3>
              <span>{transactionsData ? `${transactionsData.count} shown` : "Loading"}</span>
            </div>
            <div className="home-feed-list">
              {transactions.map((transaction) => (
                <TransactionFeedItem
                  key={`${transaction.blockNumberDecimal}:${transaction.position}:${transaction.hash}`}
                  transaction={transaction}
                  onLocationChange={onLocationChange}
                  timeZone={timeZone}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="home-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BlockFeedItem({
  block,
  onLocationChange,
  timeZone,
}: {
  block: StoredBlock;
  onLocationChange: () => void;
  timeZone: string;
}) {
  return (
    <article className="home-feed-item">
      <div className="home-feed-icon" aria-hidden="true">Bk</div>
      <div className="home-feed-main">
        <div className="home-feed-title">
          <BlockNumberLink blockNumber={block.blockNumber} onLocationChange={onLocationChange} />
          <span>{fmtDate(block.blockDate, timeZone)}</span>
        </div>
        <div className="home-feed-meta">
          <span>{fmtInteger(block.transactionCount)} txns</span>
          <span>{fmtGwei(block.averageFeePriceWei)} gwei avg fee</span>
        </div>
      </div>
      <div className="home-feed-side">
        <strong>{fmtGwei(block.baseBlockFeeWei)} gwei</strong>
        <span>{fmtEth(block.burntFeesWei ?? "0")} ETH burnt</span>
      </div>
    </article>
  );
}

function TransactionFeedItem({
  transaction,
  onLocationChange,
  timeZone,
}: {
  transaction: StoredTransaction;
  onLocationChange: () => void;
  timeZone: string;
}) {
  const txHref = transactionExplorerHref(transaction.hash);

  return (
    <article className="home-feed-item">
      <div className="home-feed-icon tx" aria-hidden="true">Tx</div>
      <div className="home-feed-main">
        <div className="home-feed-title">
          {txHref ? (
            <a className="mono block-link" href={txHref} target="_blank" rel="noreferrer">
              {shortHash(transaction.hash)}
            </a>
          ) : (
            <span className="mono">{shortHash(transaction.hash)}</span>
          )}
          <span>{fmtDate(transaction.blockDate, timeZone)}</span>
        </div>
        <div className="home-feed-meta compact">
          <span>
            Block <BlockNumberLink blockNumber={transaction.blockNumberDecimal} onLocationChange={onLocationChange} />
          </span>
          <span>Fee {fmtEth(transaction.transactionFeeWei)} ETH</span>
        </div>
        <div className="home-address-row">
          <span>From</span>
          <AddressCell address={transaction.from} />
          <span>To</span>
          <AddressCell address={transaction.to ?? transaction.contractAddress} />
        </div>
      </div>
      <div className="home-feed-side">
        <strong>{fmtEth(transaction.valueWei)} ETH</strong>
        <span>{fmtInteger(transaction.gasUsed)} gas</span>
      </div>
    </article>
  );
}

function latestBlocksParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", LATEST_BLOCK_LIMIT);
  params.set("order", "desc");
  return params;
}

function latestTransactionsParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("limit", LATEST_TRANSACTION_LIMIT);
  params.set("order", "desc");
  return params;
}

function shortHash(value: string | null | undefined): string {
  if (!value) return "-";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}
