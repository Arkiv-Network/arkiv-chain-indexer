import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-basic-dist-min";
import { AddressFace } from "./AddressFace";
import { Cedric } from "./Cedric";
import {
  fetchBlockByNumber,
  fetchBlocks,
  fetchGuzzlers,
  type BlockRequestDebugSample,
  type BlocksResponse,
  type GuzzlerStat,
  type StoredBlock,
} from "./api";
import { addressDisplay } from "./addressAliases";
import { BlockNumberLink } from "./blockLinks";
import {
  fmtBytes,
  fmtDate,
  fmtGasPrice,
  fmtInteger,
  fmtTokenAmount,
  pickGasPriceUnit,
  weiToGasPriceNumber,
} from "./format";
import { InfoTooltip } from "./InfoTooltip";
import { buildPermalinkHref, shouldHandleClientNavigation, writePermalink } from "./permalinks";
import { BlockEmpty, BlockFilled, BlockList } from "./icons";
import type { PageSettings } from "./pageSettings";
import {
  HOME_LATEST_BLOCK_LIMIT,
  buildHomeMinAvgMaxSeries,
  homeHistogramMinuteRange,
  normalizeHomeBlocksResponse,
  recentHomeBlocksParams,
} from "./homeBlocks";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ChartCard } from "@/components/chart-card";
import { cn } from "@/lib/utils";

const Plot = createPlotlyComponent(Plotly);

type BlockSlot =
  | { kind: "real"; block: StoredBlock }
  | { kind: "stub"; blockNumber: number; estimatedDate: string; pinging: boolean };

interface HomeViewProps {
  onLocationChange: () => void;
  settings: PageSettings;
  timeZone: string;
  adminModeActive: boolean;
}

const MINUTE_MS = 60_000;
const REFRESH_INTERVAL_MS = 12_000;

/** How many top wallets to preview on the home page, and over which window. */
const HOME_GUZZLER_LIMIT = 10;
const HOME_GUZZLER_WINDOW = "1h";

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

export function HomeView({ onLocationChange, settings, timeZone, adminModeActive }: HomeViewProps) {
  const [blocksData, setBlocksData] = useState<BlocksResponse | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [debugStats, setDebugStats] = useState<HomeDebugStats>(EMPTY_HOME_DEBUG_STATS);
  const [topGuzzlers, setTopGuzzlers] = useState<GuzzlerStat[] | null>(null);
  const [guzzlersUnavailable, setGuzzlersUnavailable] = useState(false);

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

  // Most-active-wallets preview (top guzzlers over the last hour). Independent of
  // the blocks feed — if the guzzlers feature is disabled the section just hides.
  useEffect(() => {
    let cancelled = false;
    const loadGuzzlers = async () => {
      try {
        const board = await fetchGuzzlers(HOME_GUZZLER_LIMIT, HOME_GUZZLER_WINDOW);
        if (cancelled) return;
        const hourly = board.windows.find((w) => w.label === HOME_GUZZLER_WINDOW);
        setTopGuzzlers((hourly?.guzzlers ?? []).slice(0, HOME_GUZZLER_LIMIT));
        setGuzzlersUnavailable(false);
      } catch {
        if (cancelled) return;
        setTopGuzzlers([]);
        setGuzzlersUnavailable(true);
      }
    };
    void loadGuzzlers();
    const interval = window.setInterval(loadGuzzlers, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const blocks = blocksData?.blocks ?? [];
  const latestBlock = blocks[0] ?? null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastMinuteAvgGas = useMemo(() => {
    const cutoffMs = nowMs - MINUTE_MS;
    let total = 0n;
    let count = 0;
    for (const block of blocks) {
      const ts = Date.parse(block.blockDate);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      try {
        total += BigInt(block.totalGasUsed);
      } catch {
        continue;
      }
      count += 1;
    }
    if (count === 0) return null;
    return (total / BigInt(count)).toString();
  }, [blocks, nowMs]);

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

  const guzzlersHref = buildPermalinkHref("guzzlers", {});
  const blocksHref = buildPermalinkHref("blocks", {});
  const latestBlockBehindLabel = useMemo(() => {
    if (!latestBlock) return null;
    const latestTimeMs = new Date(latestBlock.blockDate).getTime();
    if (!Number.isFinite(latestTimeMs)) return null;
    return `${formatBehind(Math.max(0, nowMs - latestTimeMs))} behind`;
  }, [latestBlock, nowMs]);

  const openGuzzlersView = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writePermalink("guzzlers", {})) {
      onLocationChange();
    }
  };

  const openBlocksView = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writePermalink("blocks", {})) {
      onLocationChange();
    }
  };

  const openGuzzler = (event: React.MouseEvent<HTMLAnchorElement>, address: string) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    if (writePermalink("guzzlers", { address })) {
      onLocationChange();
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-8 px-3 py-6 md:px-6">
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

      <div className="flex flex-col gap-3">
        <h3 className="font-heading text-lg font-black tracking-tight">
          {settings.chainName} live statistics
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricCard
            label="Current base fee"
            value={latestBlock ? fmtGasPrice(latestBlock.baseBlockFeeWei) : "—"}
          />
          <MetricCard
            label="Average gas / block · last minute"
            value={lastMinuteAvgGas !== null ? fmtGasBillions(lastMinuteAvgGas) : "—"}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Machine-readable API and data notes are available at{" "}
          <a className="text-primary hover:underline" href="/llms.txt">
            llms.txt
          </a>
          .
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-heading text-lg font-black tracking-tight">
          Latest blocks &amp; most active wallets
        </h3>
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
                  <a className="text-primary hover:underline" href={blocksHref} onClick={openBlocksView}>
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

          <HomeWalletActivityPanel
            topGuzzlers={topGuzzlers}
            guzzlersUnavailable={guzzlersUnavailable}
            guzzlersHref={guzzlersHref}
            onOpenGuzzlersView={openGuzzlersView}
            onOpenGuzzler={openGuzzler}
            tokenSymbol={settings.tokenSymbol}
          />
        </div>
      </div>

      <LiveHistograms blocks={blocks} error={blocksError} loaded={blocksData !== null} settings={settings} />

      {adminModeActive ? <HomeDebugSummary localBlockCount={blocks.length} stats={debugStats} /> : null}
    </section>
  );
}

function HomeWalletActivityPanel({
  topGuzzlers,
  guzzlersUnavailable,
  guzzlersHref,
  onOpenGuzzlersView,
  onOpenGuzzler,
  tokenSymbol,
}: {
  topGuzzlers: GuzzlerStat[] | null;
  guzzlersUnavailable: boolean;
  guzzlersHref: string;
  onOpenGuzzlersView: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  onOpenGuzzler: (event: React.MouseEvent<HTMLAnchorElement>, address: string) => void;
  tokenSymbol: string;
}) {
  return (
    <Card
      className="flex min-w-0 flex-col gap-0 overflow-hidden py-0"
      aria-labelledby="home-active-wallets"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div>
          <h3 id="home-active-wallets" className="font-heading text-sm">
            Most active wallets
          </h3>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Last hour, ranked by total gas used.</p>
        </div>
        <a className="text-[10px] text-primary hover:underline" href={guzzlersHref} onClick={onOpenGuzzlersView}>
          Explore activity
        </a>
      </div>
      {guzzlersUnavailable ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Wallet activity tracking is not enabled.</p>
      ) : topGuzzlers === null ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Loading most active wallets…</p>
      ) : topGuzzlers.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">No wallet activity in the last hour.</p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto">
          {topGuzzlers.map((guzzler, index) => {
            const display = addressDisplay(guzzler.address);
            return (
              <a
                key={guzzler.address}
                className="flex items-center gap-3 border-b border-border px-4 py-2 text-left transition-colors last:border-b-0 hover:bg-accent"
                href={buildPermalinkHref("guzzlers", { address: guzzler.address })}
                onClick={(event) => onOpenGuzzler(event, guzzler.address)}
                title={`View activity for ${display.title ?? guzzler.address}`}
              >
                <AddressFace address={guzzler.address} loading="lazy" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs">
                    {index + 1}. {display.label}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span>
                      <b className="font-medium text-foreground">{fmtInteger(guzzler.transactionCount)}</b> txns
                    </span>
                    <span>
                      <b className="font-medium text-foreground">{fmtGasBillions(guzzler.totalGasUsed)}</b> gas
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums">
                  <strong className="text-xs font-medium text-foreground">#{index + 1}</strong>
                  <span className="text-muted-foreground">
                    {fmtTokenAmount(guzzler.totalFeeWei, tokenSymbol)} fees
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </Card>
  );
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

function fmtGasBillions(gasStr: string): string {
  try {
    const billions = Number(BigInt(gasStr)) / 1e9;
    if (!Number.isFinite(billions)) return "—";
    let decimals: number;
    if (billions >= 100) decimals = 1;
    else if (billions >= 10) decimals = 2;
    else if (billions >= 1) decimals = 3;
    else if (billions >= 0.1) decimals = 4;
    else if (billions >= 0.01) decimals = 5;
    else decimals = 6;
    return `${billions.toFixed(decimals)} B`;
  } catch {
    return "—";
  }
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="gap-1 py-3">
      <CardContent className="flex flex-col gap-1 px-4">
        <span className="text-xs text-muted-foreground">{label}</span>
        <strong className="font-mono text-2xl font-medium tabular-nums text-foreground">{value}</strong>
      </CardContent>
    </Card>
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

function LiveHistograms({
  blocks,
  error,
  loaded,
  settings,
}: {
  blocks: StoredBlock[];
  error: string | null;
  loaded: boolean;
  settings: PageSettings;
}) {
  const [currentMinuteMs, setCurrentMinuteMs] = useState(
    () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS,
  );

  // Arkiv chains price gas in single-digit wei, where a gwei axis flattens the
  // whole series onto zero — pick the unit from the data instead.
  const baseFeeUnit = useMemo(
    () => pickGasPriceUnit(blocks.map((block) => block.baseBlockFeeWei)),
    [blocks],
  );

  // Re-render every second so the window shifts when the wall clock crosses
  // into a new minute.
  useEffect(() => {
    const tick = () => {
      const next = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
      setCurrentMinuteMs((prev) => (prev !== next ? next : prev));
    };
    const interval = window.setInterval(tick, settings.histogramClockTickMs);
    return () => window.clearInterval(interval);
  }, [settings.histogramClockTickMs]);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <MinAvgMaxPanel
        title="Network usage"
        unitLabel="gas"
        blocks={blocks}
        currentMinuteMs={currentMinuteMs}
        histogramWindowMinutes={settings.histogramWindowMinutes}
        colorVar="--chart-1"
        colorFallback="#181ea9"
        extractValue={(block) => {
          const gas = Number(block.totalGasUsed);
          return Number.isFinite(gas) ? gas : null;
        }}
        hoverLabel="Block gas"
        yTickformat=".2s"
        yTicksuffix=""
        hoverFormat=".3s"
        infoLabel="What is network usage?"
        infoTitle="Network usage"
        infoBody={
          <>
            <p>
              How much gas the network is consuming per block. Each value is the
              total gas used in a single block; the solid line is the per‑minute
              average across blocks, and the band shows the per‑minute min/max
              range.
            </p>
            <p>
              Higher values mean blocks are fuller and the network is more
              congested, which in turn pushes the base block fee up.
            </p>
          </>
        }
        error={error}
        loaded={loaded}
      />
      {settings.noBatcher ? null : (
        <MinAvgMaxPanel
          title="Batcher Operation"
          unitLabel="queue size"
          blocks={blocks}
          currentMinuteMs={currentMinuteMs}
          histogramWindowMinutes={settings.histogramWindowMinutes}
          colorVar="--chart-3"
          colorFallback="#4b52c7"
          extractValue={(block) => {
            if (block.batcherQueueSize === undefined || block.batcherQueueSize === null) return null;
            try {
              const queueSize = Number(BigInt(block.batcherQueueSize));
              return Number.isFinite(queueSize) ? queueSize : null;
            } catch {
              return null;
            }
          }}
          hoverLabel="Batcher queue"
          yTickformat=".2s"
          yTicksuffix=""
          hoverFormat=".3s"
          infoLabel="What is batcher operation?"
          infoTitle="Batcher Operation"
          infoBody={
            <>
              <p>
                The batcher queue size reported by the collector for each block. The
                solid line is the per-minute average queue size, and the band shows
                the per-minute min/max range.
              </p>
              <p>
                Missing collector readings are left out of the calculation so gaps
                show where operation metrics were not available.
              </p>
            </>
          }
          emptyLabel="No batcher queue data in this window."
          error={error}
          loaded={loaded}
        />
      )}
      <MinAvgMaxPanel
        title="Base block fee"
        unitLabel={baseFeeUnit}
        blocks={blocks}
        currentMinuteMs={currentMinuteMs}
        histogramWindowMinutes={settings.histogramWindowMinutes}
        colorVar="--chart-2"
        colorFallback="#fe7446"
        extractValue={(block) => weiToGasPriceNumber(block.baseBlockFeeWei, baseFeeUnit)}
        hoverLabel="Base fee"
        yTicksuffix={` ${baseFeeUnit}`}
        hoverFormat={baseFeeUnit === "wei" ? ",.0f" : ",.3f"}
        infoLabel="What is base block fee?"
        infoTitle="Base block fee (EIP‑1559)"
        infoBody={
          <>
            <p>
              The minimum gas price required for a transaction to be included in
              a block. Set algorithmically by the protocol — it rises when blocks
              are full and falls when they are empty, targeting ~50% utilization.
              The base fee is burnt rather than paid to miners.
            </p>
            <p>
              Shown in {baseFeeUnit}
              {baseFeeUnit === "gwei"
                ? ` (1 gwei = 10^-9 ${settings.tokenSymbol})`
                : ` (1 ${settings.tokenSymbol} = 10^18 wei)`}
              , the smallest unit that keeps this chain's fees readable. The solid
              line is the per-minute average; the band shows the per‑minute min/max
              range.
            </p>
          </>
        }
        error={error}
        loaded={loaded}
      />
    </div>
  );
}

interface MinAvgMaxPanelProps {
  title: string;
  unitLabel: string;
  blocks: StoredBlock[];
  currentMinuteMs: number;
  histogramWindowMinutes: number;
  colorVar: string;
  colorFallback: string;
  extractValue: (block: StoredBlock) => number | null;
  hoverLabel: string;
  hoverFormat: string;
  yTickformat?: string;
  yTicksuffix?: string;
  infoLabel: string;
  infoTitle: string;
  infoBody: React.ReactNode;
  emptyLabel?: string;
  error: string | null;
  loaded: boolean;
}

function MinAvgMaxPanel({
  title,
  unitLabel,
  blocks,
  currentMinuteMs,
  histogramWindowMinutes,
  colorVar,
  colorFallback,
  extractValue,
  hoverLabel,
  hoverFormat,
  yTickformat,
  yTicksuffix,
  infoLabel,
  infoTitle,
  infoBody,
  emptyLabel,
  error,
  loaded,
}: MinAvgMaxPanelProps) {
  const baseColor = getCssColor(colorVar, colorFallback);
  const gridColor = getCssColor("--border", "#e9e6de");
  const textColor = getCssColor("--muted-foreground", "#64625d");

  const { traces, layout, hasData } = useMemo<{
    traces: Partial<Plotly.PlotData>[];
    layout: Partial<Plotly.Layout>;
    hasData: boolean;
  }>(() => {
    const { minMs, maxMs } = homeHistogramMinuteRange(currentMinuteMs, {
      histogramWindowMinutes,
    });
    const xMaxMs = maxMs + MINUTE_MS;

    const series = buildHomeMinAvgMaxSeries(
      blocks,
      currentMinuteMs,
      { histogramWindowMinutes },
      extractValue,
    );
    const hasData = series.some((p) => p.avg !== null);

    const xs = series.map((p) => new Date(p.ts).toISOString());
    const ysAvg = series.map((p) => p.avg);
    const ysMin = series.map((p) => p.min);
    const ysMax = series.map((p) => p.max);
    const bandFill = withAlpha(baseColor, 0.18);
    const bandLine = withAlpha(baseColor, 0.5);
    const valueSuffix = yTicksuffix?.trim() ? yTicksuffix : ` ${unitLabel}`;

    const maxTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines+markers",
      x: xs,
      y: ysMax as unknown as Plotly.Datum[],
      connectgaps: true,
      line: { color: bandLine, width: 1, shape: "linear" },
      marker: { color: bandLine, size: 3, line: { width: 0 } },
      hovertemplate: `max %{y:${hoverFormat}}${valueSuffix}<extra></extra>`,
      showlegend: false,
    };
    const minTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines+markers",
      x: xs,
      y: ysMin as unknown as Plotly.Datum[],
      connectgaps: true,
      fill: "tonexty",
      fillcolor: bandFill,
      line: { color: bandLine, width: 1, shape: "linear" },
      marker: { color: bandLine, size: 3, line: { width: 0 } },
      hovertemplate: `min %{y:${hoverFormat}}${valueSuffix}<extra></extra>`,
      showlegend: false,
    };
    const avgTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines+markers",
      x: xs,
      y: ysAvg as unknown as Plotly.Datum[],
      connectgaps: true,
      line: { color: baseColor, width: 1.5, shape: "linear" },
      marker: { color: baseColor, size: 4, line: { width: 0 } },
      hovertemplate: `<b>${hoverLabel}</b><br>%{x|%H:%M}<br>%{y:${hoverFormat}}${valueSuffix} avg<extra></extra>`,
    };

    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 56, r: 16, t: 8, b: 28 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: textColor, size: 11 },
      showlegend: false,
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: getCssColor("--card", "#ffffff"),
        bordercolor: gridColor,
        font: { color: getCssColor("--foreground", "#111111"), size: 12 },
      },
      xaxis: {
        type: "date",
        range: [new Date(minMs).toISOString(), new Date(xMaxMs).toISOString()],
        gridcolor: "rgba(0,0,0,0)",
        zerolinecolor: "rgba(0,0,0,0)",
        tickfont: { size: 10, color: textColor },
        nticks: 6,
        fixedrange: true,
      },
      yaxis: {
        gridcolor: gridColor,
        zerolinecolor: gridColor,
        tickfont: { size: 10, color: textColor },
        rangemode: "normal",
        fixedrange: true,
        ...(yTickformat ? { tickformat: yTickformat } : {}),
        ...(yTicksuffix !== undefined ? { ticksuffix: yTicksuffix } : {}),
      },
    };

    return { traces: [maxTrace, minTrace, avgTrace], layout, hasData };
  }, [
    blocks,
    currentMinuteMs,
    histogramWindowMinutes,
    baseColor,
    gridColor,
    textColor,
    extractValue,
    hoverFormat,
    hoverLabel,
    unitLabel,
    yTickformat,
    yTicksuffix,
  ]);

  return (
    <ChartCard
      title={
        <>
          <span className="size-2.5 shrink-0 rounded-sm" aria-hidden="true" style={{ background: baseColor }} />
          {title}
          <InfoTooltip label={infoLabel}>
            <strong>{infoTitle}</strong>
            {infoBody}
          </InfoTooltip>
        </>
      }
      meta={`${unitLabel} · last ${histogramWindowMinutes} min`}
      contentClassName="h-[260px]"
    >
      {error && !loaded ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs">
          <strong className="font-medium text-foreground">Unable to load chart.</strong>
          <span className="text-muted-foreground">{error}</span>
        </div>
      ) : loaded && !hasData ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs">
          <strong className="font-medium text-foreground">No chart data.</strong>
          <span className="text-muted-foreground">{emptyLabel ?? "No values are available in this window."}</span>
        </div>
      ) : (
        <Plot
          data={traces}
          layout={layout}
          useResizeHandler
          style={{ width: "100%", height: "100%" }}
          config={{ displayModeBar: false, responsive: true, staticPlot: false }}
        />
      )}
    </ChartCard>
  );
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length !== 6) return color;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if ([r, g, b].some((c) => Number.isNaN(c))) return color;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((s) => s.trim());
    if (parts.length >= 3) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
  }
  return color;
}

function getCssColor(varName: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
