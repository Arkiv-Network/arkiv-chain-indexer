import { AlertTriangle, ArrowRightLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cedric } from "./Cedric";
import {
  fetchBlockByNumber,
  fetchBlocks,
  fetchTransactions,
  type BlockRequestDebugSample,
  type BlocksResponse,
  type StoredBlock,
  type StoredTransaction,
} from "./api";
import { addressDisplay } from "./addressAliases";
import { BlockNumberLink } from "./blockLinks";
import { fmtBytes, fmtDate, fmtGasPrice, fmtInteger, fmtTokenAmount } from "./format";
import { OmniSearch } from "./OmniSearch";
import {
  buildPermalinkHref,
  shouldHandleClientNavigation,
  transactionDetailHref,
  writePermalink,
  writeTransactionPermalink,
} from "./permalinks";
import { BlockEmpty, BlockFilled, BlockList } from "./icons";
import type { PageSettings } from "./pageSettings";
import {
  HOME_LATEST_BLOCK_LIMIT,
  normalizeHomeBlocksResponse,
  recentHomeBlocksParams,
} from "./homeBlocks";
import { addressSearchHref } from "./transactionLinks";
import { OpBadgeList } from "@/components/op-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type BlockSlot =
  | { kind: "real"; block: StoredBlock }
  | { kind: "stub"; blockNumber: number; estimatedDate: string; pinging: boolean };

interface HomeViewProps {
  onLocationChange: () => void;
  onNavigate: (href: string) => void;
  settings: PageSettings;
  timeZone: string;
  adminModeActive: boolean;
  transactionDataEnabled: boolean | null;
}

const REFRESH_INTERVAL_MS = 12_000;

/**
 * How many of the newest transactions to preview on the home page. The query is
 * bounded to the last HOME_TRANSACTION_BLOCK_WINDOW blocks so its page total is
 * an index range count rather than a COUNT(*) over every stored transaction.
 */
const HOME_TRANSACTION_LIMIT = 10;
const HOME_TRANSACTION_BLOCK_WINDOW = 1_000;

type HomeDebugRequestKind = "range" | "block";

interface HomeDebugRequestStats {
  requests: number;
  successful: number;
  failed: number;
  transferredBytes: number;
  totalDurationMs: number;
}

type HomeDebugStats = Record<HomeDebugRequestKind, HomeDebugRequestStats>;

const EMPTY_HOME_DEBUG_STATS: HomeDebugStats = {
  range: {
    requests: 0,
    successful: 0,
    failed: 0,
    transferredBytes: 0,
    totalDurationMs: 0,
  },
  block: {
    requests: 0,
    successful: 0,
    failed: 0,
    transferredBytes: 0,
    totalDurationMs: 0,
  },
};

export function HomeView({
  onLocationChange,
  onNavigate,
  settings,
  timeZone,
  adminModeActive,
  transactionDataEnabled,
}: HomeViewProps) {
  const [blocksData, setBlocksData] = useState<BlocksResponse | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [debugStats, setDebugStats] = useState<HomeDebugStats>(EMPTY_HOME_DEBUG_STATS);
  const [latestTransactions, setLatestTransactions] = useState<StoredTransaction[] | null>(null);
  const [transactionsError, setTransactionsError] = useState<string | null>(null);

  const recordDebugRequest = useCallback(
    (kind: HomeDebugRequestKind, sample: BlockRequestDebugSample) => {
      setDebugStats((previous) => ({
        ...previous,
        [kind]: {
          requests: previous[kind].requests + 1,
          successful: previous[kind].successful + (sample.ok ? 1 : 0),
          failed: previous[kind].failed + (sample.ok ? 0 : 1),
          transferredBytes: previous[kind].transferredBytes + sample.transferredBytes,
          totalDurationMs: previous[kind].totalDurationMs + sample.durationMs,
        },
      }));
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let intervalId: number | undefined;

    const loadInitialBlocks = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      setBlocksLoading(true);

      try {
        const nextBlocks = await fetchBlocks(recentHomeBlocksParams(settings), (sample) => {
          if (!cancelled) recordDebugRequest("range", sample);
        });
        if (cancelled) return;
        setBlocksData(normalizeHomeBlocksResponse(nextBlocks, settings));
        setBlocksError(null);
        if (intervalId !== undefined) window.clearInterval(intervalId);
      } catch (error) {
        if (cancelled) return;
        setBlocksError(error instanceof Error ? error.message : String(error));
      } finally {
        inFlight = false;
        if (!cancelled) setBlocksLoading(false);
      }
    };

    void loadInitialBlocks();
    intervalId = window.setInterval(loadInitialBlocks, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [settings, recordDebugRequest]);

  const blocks = blocksData?.blocks ?? [];
  const latestBlock = blocks[0] ?? null;
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The transaction preview follows the block feed's head, read through a ref
  // so a new block does not restart the polling interval.
  const latestBlockNumberRef = useRef<number | null>(null);
  latestBlockNumberRef.current = latestBlock?.blockNumber ?? null;
  const hasLatestBlock = latestBlock !== null;

  useEffect(() => {
    if (transactionDataEnabled !== true || !hasLatestBlock) return;
    let cancelled = false;
    const loadTransactions = async () => {
      const head = latestBlockNumberRef.current;
      if (head === null) return;
      const params = new URLSearchParams({
        blockGt: String(Math.max(0, head - HOME_TRANSACTION_BLOCK_WINDOW)),
        limit: String(HOME_TRANSACTION_LIMIT),
      });
      try {
        const body = await fetchTransactions(params);
        if (cancelled) return;
        setLatestTransactions(body.transactions);
        setTransactionsError(null);
      } catch (error) {
        if (cancelled) return;
        setTransactionsError(error instanceof Error ? error.message : String(error));
      }
    };
    void loadTransactions();
    const interval = window.setInterval(loadTransactions, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [transactionDataEnabled, hasLatestBlock]);

  useEffect(() => {
    if (!latestBlock) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const interval = window.setInterval(tick, settings.stubTickMs);
    return () => window.clearInterval(interval);
  }, [latestBlock?.blockNumber, settings.stubTickMs]);

  const stubSlots = useMemo<BlockSlot[]>(() => {
    if (!latestBlock) return [];
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return [];
    const elapsed = nowMs - latestTimeMs;
    const slotCount = Math.min(
      settings.maxStubBlocks,
      HOME_LATEST_BLOCK_LIMIT,
      Math.max(0, Math.floor((elapsed - settings.stubVisibleAgeMs) / settings.blockTimeMs)),
    );
    const loadingLabelElapsed =
      settings.blockTimeMs + settings.pingStartAgeMs - settings.loadingMetadataLeadMs;
    return Array.from({ length: slotCount }, (_, idx) => {
      const offset = slotCount - idx;
      return {
        kind: "stub" as const,
        blockNumber: latestBlock.blockNumber + offset,
        estimatedDate: new Date(latestTimeMs + offset * settings.blockTimeMs).toISOString(),
        pinging: offset === 1 && elapsed >= loadingLabelElapsed,
      };
    });
  }, [latestBlock, nowMs, settings]);

  const feedBlocks = useMemo(
    () => blocks.slice(0, Math.max(0, HOME_LATEST_BLOCK_LIMIT - stubSlots.length)),
    [blocks, stubSlots.length],
  );

  const blockSlots = useMemo<BlockSlot[]>(
    () =>
      [...stubSlots, ...feedBlocks.map((block) => ({ kind: "real" as const, block }))].slice(
        0,
        HOME_LATEST_BLOCK_LIMIT,
      ),
    [stubSlots, feedBlocks],
  );

  const nextExpectedBlockNumber = latestBlock ? latestBlock.blockNumber + 1 : null;

  useEffect(() => {
    if (nextExpectedBlockNumber === null || !latestBlock) return;
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return;

    const predictedNextTimeMs = latestTimeMs + settings.blockTimeMs;
    const startAtMs = predictedNextTimeMs + settings.pingStartAgeMs;
    const initialDelayMs = Math.max(0, startAtMs - Date.now());

    let cancelled = false;
    let intervalId: number | undefined;
    let lastPingAtMs = 0;
    let inFlight = false;

    const ping = async () => {
      if (inFlight) return;
      const now = Date.now();
      if (now - lastPingAtMs < settings.pingMinIntervalMs) return;
      lastPingAtMs = now;
      inFlight = true;
      try {
        const block = await fetchBlockByNumber(nextExpectedBlockNumber, (sample) => {
          if (!cancelled) recordDebugRequest("block", sample);
        });
        if (cancelled) return;
        setBlocksError(null);
        if (!block) return;
        setBlocksData((previous) => {
          if (!previous) return previous;
          if (previous.blocks.some((existing) => existing.blockNumber === block.blockNumber)) {
            return previous;
          }
          return normalizeHomeBlocksResponse(
            { ...previous, blocks: [block, ...previous.blocks] },
            settings,
          );
        });
      } catch (error) {
        if (cancelled) return;
        setBlocksError(error instanceof Error ? error.message : String(error));
      } finally {
        inFlight = false;
      }
    };

    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      void ping();
      intervalId = window.setInterval(ping, settings.nextBlockPingMs);
    }, initialDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [
    nextExpectedBlockNumber,
    latestBlock?.blockDate,
    settings.blockTimeMs,
    settings.nextBlockPingMs,
    settings.pingMinIntervalMs,
    settings.pingStartAgeMs,
    settings.histogramWindowMinutes,
    recordDebugRequest,
  ]);

  useEffect(() => {
    const prune = () => {
      setBlocksData((previous) => {
        if (!previous) return previous;
        const next = normalizeHomeBlocksResponse(previous, settings);
        return next.blocks.length === previous.blocks.length ? previous : next;
      });
    };

    prune();
    const interval = window.setInterval(prune, settings.histogramClockTickMs);
    return () => window.clearInterval(interval);
  }, [settings]);

  const blocksHref = buildPermalinkHref("blocks", {});
  const transactionsHref = buildPermalinkHref("transactions", {});
  const latestBlockBehindLabel = useMemo(() => {
    if (!latestBlock) return null;
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return null;
    return `${formatBehind(Math.max(0, nowMs - latestTimeMs))} behind`;
  }, [latestBlock, nowMs]);

  const openView = (event: React.MouseEvent<HTMLAnchorElement>, view: "blocks" | "transactions") => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writePermalink(view, {})) {
      onLocationChange();
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-8 px-3 md:px-6">
      <div className="home-hero flex flex-col items-center gap-3 pt-8 pb-8 text-center md:pt-14 md:pb-14">
        <h1 className="font-heading text-3xl font-black tracking-tight md:text-5xl">
          Explore [ ARKIV ]
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Search for a block number, address, transaction or block hash, or entity key.
        </p>
        <div className="mt-3 w-full max-w-3xl text-left">
          <OmniSearch onNavigate={onNavigate} />
        </div>
      </div>

      {blocksError ? (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div className="flex flex-col gap-0.5 text-xs">
            <strong className="font-medium text-destructive">No connection to the scanner</strong>
            <span className="text-muted-foreground">
              Showing the last received data — automatic retry in progress.
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid items-stretch gap-3 lg:grid-cols-2">
        <div className="relative flex min-w-0">
          <Cedric progress={latestBlock?.blockNumber ?? null} />
          <Card
            className="relative z-10 flex min-w-0 flex-1 flex-col gap-0 overflow-hidden py-0"
            aria-labelledby="home-latest-blocks"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <h3 id="home-latest-blocks" className="flex items-center gap-2 font-heading text-sm">
                <BlockList size={18} className="text-primary" />
                Latest blocks
              </h3>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                {latestBlockBehindLabel ? <span>{latestBlockBehindLabel}</span> : null}
                <span>
                  {blocksData ? `${blockSlots.length} shown` : blocksLoading ? "Loading" : "No data"}
                </span>
                <a className="text-primary hover:underline" href={blocksHref} onClick={(event) => openView(event, "blocks")}>
                  All blocks
                </a>
              </div>
            </div>
            {blocksError && blocks.length === 0 ? (
              <div className="flex flex-col gap-1 px-4 py-6 text-xs">
                <strong className="font-medium text-foreground">Unable to load blocks right now.</strong>
                <span className="text-muted-foreground">
                  We can't reach the scanner. The page will refresh automatically once the connection
                  is restored.
                </span>
              </div>
            ) : (
              <div className="max-h-[26rem] overflow-y-auto">
                {blockSlots.map((slot, idx) => (
                  <BlockFeedItem
                    key={`slot-${idx}`}
                    slot={slot}
                    onLocationChange={onLocationChange}
                    timeZone={timeZone}
                    tokenSymbol={settings.tokenSymbol}
                  />
                ))}
                {!blocksLoading && blocks.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">No stored blocks yet.</p>
                ) : null}
              </div>
            )}
          </Card>
        </div>

        <HomeLatestTransactionsPanel
          transactions={latestTransactions}
          error={transactionsError}
          transactionDataEnabled={transactionDataEnabled}
          transactionsHref={transactionsHref}
          onOpenTransactionsView={(event) => openView(event, "transactions")}
          onLocationChange={onLocationChange}
          timeZone={timeZone}
          tokenSymbol={settings.tokenSymbol}
        />
      </div>

      {adminModeActive ? <HomeDebugSummary localBlockCount={blocks.length} stats={debugStats} /> : null}
    </section>
  );
}

function HomeLatestTransactionsPanel({
  transactions,
  error,
  transactionDataEnabled,
  transactionsHref,
  onOpenTransactionsView,
  onLocationChange,
  timeZone,
  tokenSymbol,
}: {
  transactions: StoredTransaction[] | null;
  error: string | null;
  transactionDataEnabled: boolean | null;
  transactionsHref: string;
  onOpenTransactionsView: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}) {
  return (
    <Card
      className="flex min-w-0 flex-col gap-0 overflow-hidden py-0"
      aria-labelledby="home-latest-transactions"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 id="home-latest-transactions" className="flex items-center gap-2 font-heading text-sm">
          <ArrowRightLeft className="size-4 text-primary" aria-hidden="true" />
          Latest transactions
        </h3>
        {transactionDataEnabled === true ? (
          <a className="text-[10px] text-primary hover:underline" href={transactionsHref} onClick={onOpenTransactionsView}>
            All transactions
          </a>
        ) : null}
      </div>
      {transactionDataEnabled === false ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">This indexer does not store transactions.</p>
      ) : error && transactions === null ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Unable to load transactions right now.</p>
      ) : transactions === null ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Loading latest transactions…</p>
      ) : transactions.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          No transactions in the last {fmtInteger(HOME_TRANSACTION_BLOCK_WINDOW)} blocks.
        </p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          {transactions.map((transaction) => (
            <TransactionFeedItem
              key={transaction.hash}
              transaction={transaction}
              onLocationChange={onLocationChange}
              timeZone={timeZone}
              tokenSymbol={tokenSymbol}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function TransactionFeedItem({
  transaction,
  onLocationChange,
  timeZone,
  tokenSymbol,
}: {
  transaction: StoredTransaction;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}) {
  const openTransaction = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writeTransactionPermalink(transaction.hash)) onLocationChange();
  };

  return (
    <article className="flex items-center gap-3 border-b border-border px-4 py-2 transition-colors last:border-b-0 hover:bg-accent">
      <div className="flex size-8 shrink-0 items-center justify-center text-primary" aria-hidden="true">
        <ArrowRightLeft className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 font-mono text-xs">
          <a
            className="truncate hover:underline"
            href={transactionDetailHref(transaction.hash)}
            onClick={openTransaction}
            title={transaction.hash}
          >
            {shortHash(transaction.hash)}
          </a>
          <span className="shrink-0 text-[11px] text-muted-foreground">{fmtDate(transaction.blockDate, timeZone)}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <AddressLink address={transaction.from} />
          <span aria-hidden="true">→</span>
          {transaction.to ? <AddressLink address={transaction.to} /> : <span>Contract creation</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 font-mono text-[11px] tabular-nums">
        {transaction.operationsSummary?.length ? <OpBadgeList operations={transaction.operationsSummary} /> : null}
        <span className="text-muted-foreground">
          <BlockNumberLink blockNumber={transaction.blockNumberDecimal} onLocationChange={onLocationChange} /> ·{" "}
          {fmtTokenAmount(transaction.transactionFeeWei, tokenSymbol)} fee
        </span>
      </div>
    </article>
  );
}

function AddressLink({ address }: { address: string | null }) {
  const display = addressDisplay(address);
  const href = addressSearchHref(address);
  return href ? (
    <a className="truncate font-mono hover:text-foreground hover:underline" href={href} title={display.title ?? address ?? undefined}>
      {display.label}
    </a>
  ) : (
    <span className="truncate font-mono">{display.label}</span>
  );
}

function shortHash(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function HomeDebugSummary({
  localBlockCount,
  stats,
}: {
  localBlockCount: number;
  stats: HomeDebugStats;
}) {
  return (
    <Card aria-label="Home request debug summary">
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            debug summary
          </span>
          <strong className="font-mono text-xs font-medium text-foreground">
            {fmtInteger(localBlockCount)} local blocks
          </strong>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <HomeDebugRequestSummary label="Range requests" stats={stats.range} />
          <HomeDebugRequestSummary label="Block requests" stats={stats.block} />
        </div>
      </CardContent>
    </Card>
  );
}

function HomeDebugRequestSummary({
  label,
  stats,
}: {
  label: string;
  stats: HomeDebugRequestStats;
}) {
  const averageMs = stats.requests === 0 ? null : stats.totalDurationMs / stats.requests;
  return (
    <section className="border border-border p-3">
      <h4 className="text-xs font-medium text-foreground">{label}</h4>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">Requests</dt>
        <dd className="text-right font-mono tabular-nums">{fmtInteger(stats.requests)}</dd>
        <dt className="text-muted-foreground">Successful</dt>
        <dd className="text-right font-mono tabular-nums">{fmtInteger(stats.successful)}</dd>
        <dt className="text-muted-foreground">Failed</dt>
        <dd className="text-right font-mono tabular-nums">{fmtInteger(stats.failed)}</dd>
        <dt className="text-muted-foreground">Transferred</dt>
        <dd className="text-right font-mono tabular-nums">{fmtBytes(stats.transferredBytes)}</dd>
        <dt className="text-muted-foreground">Avg response</dt>
        <dd className="text-right font-mono tabular-nums">
          {averageMs === null ? "—" : `${Math.round(averageMs)} ms`}
        </dd>
      </dl>
    </section>
  );
}

function BlockMorphIcon({ filled }: { filled: boolean }) {
  return (
    <div className="relative flex size-8 shrink-0 items-center justify-center text-primary" aria-hidden="true">
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity duration-500",
          filled ? "opacity-0" : "opacity-100",
        )}
      >
        <BlockEmpty size={28} />
      </span>
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center transition-opacity duration-500",
          filled ? "opacity-100" : "opacity-0",
        )}
      >
        <BlockFilled size={28} />
      </span>
    </div>
  );
}

function BlockFeedItem({
  slot,
  onLocationChange,
  timeZone,
  tokenSymbol,
}: {
  slot: BlockSlot;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}) {
  if (slot.kind === "stub") {
    return (
      <article
        className="flex items-center gap-3 border-b border-border px-4 py-2 opacity-70 last:border-b-0"
        aria-busy="true"
      >
        <BlockMorphIcon filled={false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 font-mono text-xs">
            <span className="tabular-nums">{slot.blockNumber}</span>
            <span className="text-[11px] text-muted-foreground">~{fmtDate(slot.estimatedDate, timeZone)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            <span>{slot.pinging ? "Loading metadata" : "Next block"}</span>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 font-mono text-[10px] tracking-wider uppercase">
          {slot.pinging ? "loading" : "next"}
        </Badge>
      </article>
    );
  }

  const { block } = slot;
  return (
    <article className="flex items-center gap-3 border-b border-border px-4 py-2 transition-colors last:border-b-0 hover:bg-accent">
      <BlockMorphIcon filled={true} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 font-mono text-xs">
          <BlockNumberLink blockNumber={block.blockNumber} onLocationChange={onLocationChange} />
          <span className="text-[11px] text-muted-foreground">{fmtDate(block.blockDate, timeZone)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
          <span>
            <b className="font-medium text-foreground">{fmtInteger(block.transactionCount)}</b> txns
          </span>
          <span>
            <b className="font-medium text-foreground">{fmtGasPrice(block.averageFeePriceWei)}</b> avg fee
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums">
        <strong className="text-xs font-medium text-foreground">{fmtGasPrice(block.baseBlockFeeWei)}</strong>
        <span className="text-muted-foreground">{fmtTokenAmount(block.burntFeesWei ?? "0", tokenSymbol)} burnt</span>
      </div>
    </article>
  );
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

