import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchBlockByNumber,
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
import { BlockEmpty, BlockFilled, BlockList, TxBracketed } from "./icons";

const BLOCK_TIME_MS = 2_000;
const STUB_TICK_MS = 500;
const MAX_STUB_BLOCKS = 3;
const STUB_VISIBLE_AGE_MS = 6000;
const PING_START_AGE_MS = 9000;
const LOADING_METADATA_LEAD_MS = 1_000;
const NEXT_BLOCK_PING_MS = 100;
const PING_MIN_INTERVAL_MS = 1_500;
const SCANNER_DELAY_WARNING_AGE_MS = 60_000;

type BlockSlot =
  | { kind: "real"; block: StoredBlock }
  | { kind: "stub"; blockNumber: number; estimatedDate: string; pinging: boolean };

interface HomeViewProps {
  transactionDataEnabled: boolean | null;
  onLocationChange: () => void;
  timeZone: string;
}

const LATEST_BLOCK_LIMIT = "20";
const LATEST_TRANSACTION_LIMIT = "10";
const REFRESH_INTERVAL_MS = 12_000;
const SIMULATE_OFFLINE_STORAGE_KEY = "home.simulateOffline";

export function HomeView({ transactionDataEnabled, onLocationChange, timeZone }: HomeViewProps) {
  const [blocksData, setBlocksData] = useState<BlocksResponse | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [transactionsData, setTransactionsData] = useState<TransactionsResponse | null>(null);
  const [transactionsUnavailable, setTransactionsUnavailable] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [simulateOffline, setSimulateOffline] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIMULATE_OFFLINE_STORAGE_KEY) === "true";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SIMULATE_OFFLINE_STORAGE_KEY, String(simulateOffline));
  }, [simulateOffline]);

  // Debug only: when the simulate-offline toggle is on, fail all /api/blocks*
  // requests at the fetch boundary. The rest of the component is unaware of
  // the toggle and just sees a real connection failure.
  useEffect(() => {
    if (typeof window === "undefined" || !simulateOffline) return;
    const originalFetch = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (url.includes("/api/blocks")) {
        throw new Error("Simulated offline (debug)");
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    return () => {
      window.fetch = originalFetch;
    };
  }, [simulateOffline]);

  const loadLatest = useCallback(async () => {
    setBlocksLoading(true);

    try {
      const nextBlocks = await fetchBlocks(latestBlocksParams());
      setBlocksData(nextBlocks);
      setBlocksError(null);
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
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!latestBlock) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const interval = window.setInterval(tick, STUB_TICK_MS);
    return () => window.clearInterval(interval);
  }, [latestBlock?.blockNumber]);

  const stubSlots = useMemo<BlockSlot[]>(() => {
    if (!latestBlock) return [];
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return [];
    const elapsed = nowMs - latestTimeMs;
    const slotCount = Math.min(
      MAX_STUB_BLOCKS,
      Math.max(0, Math.floor((elapsed - STUB_VISIBLE_AGE_MS) / BLOCK_TIME_MS)),
    );
    const loadingLabelElapsed = BLOCK_TIME_MS + PING_START_AGE_MS - LOADING_METADATA_LEAD_MS;
    return Array.from({ length: slotCount }, (_, idx) => {
      const offset = slotCount - idx;
      return {
        kind: "stub" as const,
        blockNumber: latestBlock.blockNumber + offset,
        estimatedDate: new Date(latestTimeMs + offset * BLOCK_TIME_MS).toISOString(),
        pinging: offset === 1 && elapsed >= loadingLabelElapsed,
      };
    });
  }, [latestBlock, nowMs]);

  const blockSlots = useMemo<BlockSlot[]>(
    () => [...stubSlots, ...blocks.map((block) => ({ kind: "real" as const, block }))],
    [stubSlots, blocks],
  );

  const nextExpectedBlockNumber = latestBlock ? latestBlock.blockNumber + 1 : null;

  useEffect(() => {
    if (nextExpectedBlockNumber === null || !latestBlock) return;
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return;

    const predictedNextTimeMs = latestTimeMs + BLOCK_TIME_MS;
    const startAtMs = predictedNextTimeMs + PING_START_AGE_MS;
    const initialDelayMs = Math.max(0, startAtMs - Date.now());

    let cancelled = false;
    let intervalId: number | undefined;
    let lastPingAtMs = 0;

    const ping = async () => {
      const now = Date.now();
      if (now - lastPingAtMs < PING_MIN_INTERVAL_MS) return;
      lastPingAtMs = now;
      try {
        const block = await fetchBlockByNumber(nextExpectedBlockNumber);
        if (cancelled) return;
        setBlocksError(null);
        if (!block) return;
        setBlocksData((previous) => {
          if (!previous) return previous;
          if (previous.blocks.some((existing) => existing.blockNumber === block.blockNumber)) {
            return previous;
          }
          const merged = [block, ...previous.blocks].slice(0, previous.limit);
          return { ...previous, blocks: merged, count: merged.length };
        });
        setLastUpdatedAt(new Date());
      } catch (error) {
        if (cancelled) return;
        setBlocksError(error instanceof Error ? error.message : String(error));
      }
    };

    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      void ping();
      intervalId = window.setInterval(ping, NEXT_BLOCK_PING_MS);
    }, initialDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [nextExpectedBlockNumber, latestBlock?.blockDate]);

  const transactions = transactionsData?.transactions ?? [];
  const showTransactions = transactionDataEnabled === true && !transactionsUnavailable && transactions.length > 0;
  const blocksHref = buildPermalinkHref("blocks", { limit: "100" });
  const lastUpdatedLabel = useMemo(() => {
    if (!lastUpdatedAt) return "Waiting for data";
    return `Updated ${lastUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }, [lastUpdatedAt]);
  const latestBlockBehindLabel = useMemo(() => {
    if (!latestBlock) return null;
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return null;
    return `${formatBehind(Math.max(0, nowMs - latestTimeMs))} behind`;
  }, [latestBlock, nowMs]);
  const scannerDelayed = useMemo(() => {
    if (blocksError || !latestBlock) return false;
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return false;
    return nowMs - latestTimeMs >= SCANNER_DELAY_WARNING_AGE_MS;
  }, [latestBlock, nowMs, blocksError]);

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
          <p className="home-kicker">arkiv chain explorer</p>
          <h2>Explore the Arkiv chain.</h2>
          <p className="home-lede">
            Newest indexed blocks and transactions on the Arkiv data layer — searchable, time‑scoped,
            verifiable.
          </p>
        </div>
        <div className="home-status" aria-live="polite">
          <span
            className={blocksError ? "home-status-indicator offline" : "home-status-indicator"}
            title={blocksError ?? undefined}
          >
            {blocksError
              ? "No connection to scanner"
              : blocksLoading
                ? "Refreshing…"
                : lastUpdatedLabel}
          </span>
          <a href={blocksHref} onClick={openBlocksView}>
            View all blocks
          </a>
          <button
            type="button"
            className={`home-debug-toggle${simulateOffline ? " active" : ""}`}
            onClick={() => setSimulateOffline((value) => !value)}
            title="Debug: pretend the backend is unreachable"
          >
            {simulateOffline ? "● simulated offline (debug)" : "○ simulate offline (debug)"}
          </button>
        </div>
      </div>

      {blocksError ? (
        <div className="home-connection-alert" role="alert" aria-live="polite">
          <span className="home-connection-alert__icon" aria-hidden="true">
            ⚠
          </span>
          <div className="home-connection-alert__body">
            <strong>No connection to the scanner</strong>
            <span>Showing the last received data — automatic retry in progress.</span>
          </div>
        </div>
      ) : scannerDelayed ? (
        <div
          className="home-connection-alert home-connection-alert--warn"
          role="alert"
          aria-live="polite"
        >
          <span className="home-connection-alert__icon" aria-hidden="true">
            ⚠
          </span>
          <div className="home-connection-alert__body">
            <strong>Scanner is delayed</strong>
            <span>
              The latest indexed block is more than a minute old — the data shown may not
              represent the current state of the network.
            </span>
          </div>
        </div>
      ) : null}

      <div>
        <div className="home-section-head">
          <div>
            <p className="home-kicker">network at a glance</p>
            <h3>Live statistics</h3>
          </div>
        </div>
        <div className="home-stats">
          <MetricCard label="Latest block" value={latestBlock ? latestBlock.blockNumber.toString() : "—"} />
          <MetricCard label="Base fee" value={latestBlock ? `${fmtGwei(latestBlock.baseBlockFeeWei)} gwei` : "—"} />
          <MetricCard label="Transactions" value={latestBlock ? fmtInteger(latestBlock.transactionCount) : "—"} />
          <MetricCard
            label="Gas used"
            value={latestBlock ? fmtRatio(latestBlock.totalGasUsed, latestBlock.maxGasInBlock) : "—"}
          />
        </div>
      </div>

      <div>
        <div className="home-section-head">
          <div>
            <p className="home-kicker">live feed</p>
            <h3>Latest blocks &amp; transactions</h3>
          </div>
        </div>
        <div className={`home-feed-grid${showTransactions ? "" : " single"}`}>
          <section className="home-feed-panel" aria-labelledby="home-latest-blocks">
            <div className="home-panel-heading">
              <h3 id="home-latest-blocks" className="home-panel-heading-title">
                <span className="home-panel-heading-icon" aria-hidden="true">
                  <BlockList size={40} />
                </span>
                Latest blocks
              </h3>
              <div className="home-panel-heading-meta">
                {latestBlockBehindLabel ? (
                  <span className="home-panel-latest-time">{latestBlockBehindLabel}</span>
                ) : null}
                <span>{blocksData ? `${blocksData.count} shown` : blocksLoading ? "Loading" : "No data"}</span>
              </div>
            </div>
            {blocksError && blocks.length === 0 ? (
              <div className="home-feed-empty-state">
                <strong>Unable to load blocks right now.</strong>
                <span>
                  We can't reach the scanner. The page will refresh automatically once the
                  connection is restored.
                </span>
              </div>
            ) : (
              <div className="home-feed-list">
                {blockSlots.map((slot) => (
                  <BlockFeedItem
                    key={slot.kind === "real" ? slot.block.blockNumber : slot.blockNumber}
                    slot={slot}
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
  slot,
  onLocationChange,
  timeZone,
}: {
  slot: BlockSlot;
  onLocationChange: () => void;
  timeZone: string;
}) {
  if (slot.kind === "stub") {
    return (
      <article className="home-feed-item home-feed-item--stub" aria-busy="true">
        <div className="home-feed-icon" aria-hidden="true">
          <BlockEmpty size={40} />
        </div>
        <div className="home-feed-main">
          <div className="home-feed-title">
            <span className="mono">{slot.blockNumber}</span>
            <span>~{fmtDate(slot.estimatedDate, timeZone)}</span>
          </div>
          <div className="home-feed-meta">
            <span>{slot.pinging ? "Loading metadata" : "Next block"}</span>
          </div>
        </div>
        <div className="home-feed-side">
          <span className="home-stub-tag">{slot.pinging ? "loading" : "next"}</span>
        </div>
      </article>
    );
  }

  const { block } = slot;
  return (
    <article className="home-feed-item">
      <div className="home-feed-icon" aria-hidden="true">
        <BlockFilled size={40} />
      </div>
      <div className="home-feed-main">
        <div className="home-feed-title">
          <BlockNumberLink blockNumber={block.blockNumber} onLocationChange={onLocationChange} />
          <span>{fmtDate(block.blockDate, timeZone)}</span>
        </div>
        <div className="home-feed-meta">
          <span>
            <b>{fmtInteger(block.transactionCount)}</b> txns
          </span>
          <span>
            <b>{fmtGwei(block.averageFeePriceWei)}</b> gwei avg fee
          </span>
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
      <div className="home-feed-icon tx" aria-hidden="true">
        <TxBracketed size={22} />
      </div>
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

function formatBehind(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} ${totalSeconds === 1 ? "second" : "seconds"}`;
  }
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
