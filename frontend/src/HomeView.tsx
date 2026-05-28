import { useCallback, useEffect, useMemo, useState } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import {
  fetchBlockByNumber,
  fetchBlocks,
  type BlockRequestDebugSample,
  type BlocksResponse,
  type StoredBlock,
} from "./api";
import { BlockNumberLink } from "./blockLinks";
import { fmtBytes, fmtDate, fmtEth, fmtGwei, fmtInteger } from "./format";
import { InfoTooltip } from "./InfoTooltip";
import { buildPermalinkHref, writePermalink } from "./permalinks";
import { BlockEmpty, BlockFilled, BlockList } from "./icons";
import type { PageSettings } from "./pageSettings";
import {
  HOME_LATEST_BLOCK_LIMIT,
  homeHistogramMinuteRange,
  normalizeHomeBlocksResponse,
  recentHomeBlocksParams,
} from "./homeBlocks";

const Plot = createPlotlyComponent(Plotly);

type BlockSlot =
  | { kind: "real"; block: StoredBlock }
  | { kind: "stub"; blockNumber: number; estimatedDate: string; pinging: boolean };

interface HomeViewProps {
  onLocationChange: () => void;
  settings: PageSettings;
  timeZone: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const REFRESH_INTERVAL_MS = 12_000;
const SIMULATE_OFFLINE_STORAGE_KEY = "home.simulateOffline";

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

export function HomeView({ onLocationChange, settings, timeZone }: HomeViewProps) {
  const [blocksData, setBlocksData] = useState<BlocksResponse | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [debugStats, setDebugStats] = useState<HomeDebugStats>(EMPTY_HOME_DEBUG_STATS);
  const [simulateOffline, setSimulateOffline] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIMULATE_OFFLINE_STORAGE_KEY) === "true";
  });

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
        setLastUpdatedAt(new Date());
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
  const feedBlocks = useMemo(() => blocks.slice(0, HOME_LATEST_BLOCK_LIMIT), [blocks]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lastMinuteStats = useMemo(
    () => aggregateBlocksWindow(blocks, nowMs, MINUTE_MS),
    [blocks, nowMs],
  );
  const lastHourStats = useMemo(
    () => aggregateBlocksWindow(blocks, nowMs, HOUR_MS),
    [blocks, nowMs],
  );

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

  const blockSlots = useMemo<BlockSlot[]>(
    () => [...stubSlots, ...feedBlocks.map((block) => ({ kind: "real" as const, block }))],
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
        setLastUpdatedAt(new Date());
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
    return nowMs - latestTimeMs >= settings.scannerDelayWarningAgeMs;
  }, [latestBlock, nowMs, blocksError, settings.scannerDelayWarningAgeMs]);

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
          <p className="home-kicker">{settings.chainName} chain explorer</p>
          <h2>Explore the {settings.chainName} chain.</h2>
          <p className="home-lede">
            Newest indexed blocks and transactions on the {settings.chainName} data layer — searchable, time‑scoped,
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
        <div className="home-stat-groups">
          <StatGroup label="Last block">
            <MetricCard
              label="Block"
              value={latestBlock ? `#${latestBlock.blockNumber}` : "—"}
            />
            <MetricCard
              label="Base fee"
              value={latestBlock ? `${fmtGwei(latestBlock.baseBlockFeeWei)} gwei` : "—"}
            />
            <MetricCard
              label="Transactions"
              value={latestBlock ? fmtInteger(latestBlock.transactionCount) : "—"}
            />
            <MetricCard
              label="Gas used"
              value={latestBlock ? fmtGasBillions(latestBlock.totalGasUsed) : "—"}
            />
            <MetricCard
              label="Fees"
              value={
                latestBlock && latestBlock.totalTransactionFeeWei
                  ? `${fmtEth(latestBlock.totalTransactionFeeWei)} ETH`
                  : "—"
              }
            />
          </StatGroup>
          <StatGroup label="Last minute">
            <MetricCard
              label="Blocks"
              value={lastMinuteStats ? fmtInteger(lastMinuteStats.count) : "—"}
            />
            <MetricCard
              label="Transactions"
              value={lastMinuteStats ? fmtInteger(lastMinuteStats.transactions) : "—"}
            />
            <MetricCard
              label="Gas used"
              value={lastMinuteStats ? fmtGasBillions(lastMinuteStats.gasUsed) : "—"}
            />
            <MetricCard
              label="Fees"
              value={lastMinuteStats ? `${fmtEth(lastMinuteStats.feesWei)} ETH` : "—"}
            />
          </StatGroup>
          <StatGroup label="Last hour">
            <MetricCard
              label="Blocks"
              value={lastHourStats ? fmtInteger(lastHourStats.count) : "—"}
            />
            <MetricCard
              label="Transactions"
              value={lastHourStats ? fmtInteger(lastHourStats.transactions) : "—"}
            />
            <MetricCard
              label="Gas used"
              value={lastHourStats ? fmtGasBillions(lastHourStats.gasUsed) : "—"}
            />
            <MetricCard
              label="Fees"
              value={lastHourStats ? `${fmtEth(lastHourStats.feesWei)} ETH` : "—"}
            />
          </StatGroup>
        </div>
      </div>

      <div>
        <div className="home-section-head">
          <div>
            <p className="home-kicker">live feed</p>
            <h3>Latest blocks &amp; last {settings.histogramWindowMinutes} minutes</h3>
          </div>
        </div>
        <div className="home-feed-grid">
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
                <span>{blocksData ? `${feedBlocks.length} shown` : blocksLoading ? "Loading" : "No data"}</span>
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

          <LiveHistograms
            blocks={blocks}
            error={blocksError}
            loaded={blocksData !== null}
            settings={settings}
            timeZone={timeZone}
          />
        </div>
      </div>

      <HomeDebugSummary localBlockCount={blocks.length} stats={debugStats} />
    </section>
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
    <aside className="home-debug-summary" aria-label="Home request debug summary">
      <div className="home-debug-summary__head">
        <span>debug summary</span>
        <strong>{fmtInteger(localBlockCount)} local blocks</strong>
      </div>
      <div className="home-debug-summary__grid">
        <HomeDebugRequestSummary label="Range requests" stats={stats.range} />
        <HomeDebugRequestSummary label="Block requests" stats={stats.block} />
      </div>
    </aside>
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
    <section className="home-debug-request">
      <h4>{label}</h4>
      <dl>
        <div>
          <dt>Requests</dt>
          <dd>{fmtInteger(stats.requests)}</dd>
        </div>
        <div>
          <dt>Successful</dt>
          <dd>{fmtInteger(stats.successful)}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{fmtInteger(stats.failed)}</dd>
        </div>
        <div>
          <dt>Transferred</dt>
          <dd>{fmtBytes(stats.transferredBytes)}</dd>
        </div>
        <div>
          <dt>Avg response</dt>
          <dd>{averageMs === null ? "—" : `${Math.round(averageMs)} ms`}</dd>
        </div>
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
    <div className="home-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="home-stat-group">
      <p className="home-stat-group-label">{label}</p>
      <div className="home-stats">{children}</div>
    </div>
  );
}

interface BlocksWindowStats {
  count: number;
  transactions: string;
  gasUsed: string;
  feesWei: string;
}

function aggregateBlocksWindow(
  blocks: StoredBlock[],
  nowMs: number,
  windowMs: number,
): BlocksWindowStats | null {
  const cutoffMs = nowMs - windowMs;
  let count = 0;
  let transactions = 0n;
  let gasUsed = 0n;
  let feesWei = 0n;
  for (const block of blocks) {
    const ts = Date.parse(block.blockDate);
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    count += 1;
    transactions += BigInt(block.transactionCount);
    try {
      gasUsed += BigInt(block.totalGasUsed);
    } catch {
      // ignore unparseable values
    }
    if (block.totalTransactionFeeWei) {
      try {
        feesWei += BigInt(block.totalTransactionFeeWei);
      } catch {
        // ignore unparseable values
      }
    }
  }
  if (count === 0) return null;
  return {
    count,
    transactions: transactions.toString(),
    gasUsed: gasUsed.toString(),
    feesWei: feesWei.toString(),
  };
}

function BlockMorphIcon({ filled }: { filled: boolean }) {
  return (
    <div
      className={`home-feed-icon home-feed-icon--block${filled ? " is-filled" : ""}`}
      aria-hidden="true"
    >
      <span className="home-feed-icon__layer home-feed-icon__layer--empty">
        <BlockEmpty size={40} />
      </span>
      <span className="home-feed-icon__layer home-feed-icon__layer--filled">
        <BlockFilled size={40} />
      </span>
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
        <BlockMorphIcon filled={false} />
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
      <BlockMorphIcon filled={true} />
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

interface MinuteBucket {
  minuteMs: number;
  gasUsed: number;
  transactionCount: number;
}

type HistogramMetric = "gasUsed" | "transactionCount";

function LiveHistograms({
  blocks,
  error,
  loaded,
  settings,
  timeZone,
}: {
  blocks: StoredBlock[];
  error: string | null;
  loaded: boolean;
  settings: PageSettings;
  timeZone: string;
}) {
  const [currentMinuteMs, setCurrentMinuteMs] = useState(
    () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS,
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

  const buckets = useMemo<MinuteBucket[]>(() => {
    const map = new Map<number, MinuteBucket>();
    for (let i = 0; i < settings.histogramWindowMinutes; i++) {
      const ms = currentMinuteMs - (settings.histogramWindowMinutes - 1 - i) * MINUTE_MS;
      map.set(ms, { minuteMs: ms, gasUsed: 0, transactionCount: 0 });
    }
    for (const block of blocks) {
      const ts = Date.parse(block.blockDate);
      if (!Number.isFinite(ts)) continue;
      const minute = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
      const bucket = map.get(minute);
      if (!bucket) continue;
      const gas = Number(block.totalGasUsed);
      if (Number.isFinite(gas)) bucket.gasUsed += gas;
      bucket.transactionCount += block.transactionCount;
    }
    return Array.from(map.values()).sort((a, b) => a.minuteMs - b.minuteMs);
  }, [blocks, currentMinuteMs, settings.histogramWindowMinutes]);

  return (
    <div className="home-histograms">
      <HistogramPanel
        title="Gas used"
        subtitle={`per minute · last ${settings.histogramWindowMinutes} min`}
        buckets={buckets}
        currentMinuteMs={currentMinuteMs}
        histogramWindowMinutes={settings.histogramWindowMinutes}
        colorVar="--ark-blue"
        colorFallback="#181ea9"
        metric="gasUsed"
        unitLabel="gas"
        timeZone={timeZone}
        error={error}
        loaded={loaded}
      />
      <BaseFeePanel
        blocks={blocks}
        currentMinuteMs={currentMinuteMs}
        histogramWindowMinutes={settings.histogramWindowMinutes}
        error={error}
        loaded={loaded}
      />
    </div>
  );
}

function HistogramPanel({
  title,
  subtitle,
  buckets,
  currentMinuteMs,
  histogramWindowMinutes,
  colorVar,
  colorFallback,
  metric,
  unitLabel,
  timeZone,
  error,
  loaded,
}: {
  title: string;
  subtitle: string;
  buckets: MinuteBucket[];
  currentMinuteMs: number;
  histogramWindowMinutes: number;
  colorVar: string;
  colorFallback: string;
  metric: HistogramMetric;
  unitLabel: string;
  timeZone: string;
  error: string | null;
  loaded: boolean;
}) {
  const baseColor = getCssColor(colorVar, colorFallback);
  const gridColor = getCssColor("--line-strong", "#1111111a");
  const textColor = getCssColor("--ink-muted", "#6b6b6b");

  const { traces, layout } = useMemo<{
    traces: Partial<Plotly.PlotData>[];
    layout: Partial<Plotly.Layout>;
  }>(() => {
    const xs = buckets.map((b) => new Date(b.minuteMs).toISOString());
    const ys = buckets.map((b) => b[metric]);
    const opacities = buckets.map((b) => (b.minuteMs === currentMinuteMs ? 0.55 : 0.95));
    const labels = buckets.map((b) =>
      new Date(b.minuteMs).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }),
    );
    const customdata = buckets.map((b, i) =>
      [labels[i], b.minuteMs === currentMinuteMs ? "in progress" : "complete"] as [string, string],
    );

    const { minMs, maxMs } = homeHistogramMinuteRange(currentMinuteMs, {
      histogramWindowMinutes,
    });

    const trace: Partial<Plotly.PlotData> = {
      type: "bar",
      x: xs,
      y: ys,
      marker: {
        color: baseColor,
        opacity: opacities as unknown as number,
        line: { width: 0 },
      },
      customdata: customdata as unknown as Plotly.Datum[],
      hovertemplate:
        `<b>${title}</b><br>` +
        "%{customdata[0]} %{customdata[1]}<br>" +
        `%{y:,.0f} ${unitLabel}<extra></extra>`,
    };

    const layout: Partial<Plotly.Layout> = {
      autosize: true,
      margin: { l: 48, r: 16, t: 8, b: 28 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: textColor, size: 11 },
      bargap: 0.15,
      showlegend: false,
      hovermode: "x unified",
      hoverlabel: {
        bgcolor: getCssColor("--sand", "#f6f4ef"),
        bordercolor: gridColor,
        font: { color: getCssColor("--ink", "#111111"), size: 12 },
      },
      xaxis: {
        type: "date",
        range: [
          new Date(minMs).toISOString(),
          new Date(maxMs).toISOString(),
        ],
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
        rangemode: "tozero",
        fixedrange: true,
      },
    };

    return { traces: [trace], layout };
  }, [
    buckets,
    currentMinuteMs,
    baseColor,
    gridColor,
    textColor,
    histogramWindowMinutes,
    metric,
    title,
    unitLabel,
    timeZone,
  ]);

  return (
    <section className="home-feed-panel home-histogram-panel">
      <div className="home-panel-heading">
        <h3 className="home-panel-heading-title home-histogram-title">
          <span
            className="home-histogram-swatch"
            aria-hidden="true"
            style={{ background: baseColor }}
          />
          {title}
        </h3>
        <span>{subtitle}</span>
      </div>
      <div className="home-histogram-chart">
        {error && !loaded ? (
          <div className="home-feed-empty-state">
            <strong>Unable to load histogram.</strong>
            <span>{error}</span>
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
      </div>
    </section>
  );
}

function BaseFeePanel({
  blocks,
  currentMinuteMs,
  histogramWindowMinutes,
  error,
  loaded,
}: {
  blocks: StoredBlock[];
  currentMinuteMs: number;
  histogramWindowMinutes: number;
  error: string | null;
  loaded: boolean;
}) {
  const baseColor = getCssColor("--ark-orange", "#fe7446");
  const gridColor = getCssColor("--line-strong", "#1111111a");
  const textColor = getCssColor("--ink-muted", "#6b6b6b");

  const { traces, layout } = useMemo<{
    traces: Partial<Plotly.PlotData>[];
    layout: Partial<Plotly.Layout>;
  }>(() => {
    const { minMs, maxMs } = homeHistogramMinuteRange(currentMinuteMs, {
      histogramWindowMinutes,
    });
    const xMaxMs = maxMs + MINUTE_MS;

    interface MinuteAgg {
      total: number;
      count: number;
      min: number;
      max: number;
    }
    const sums = new Map<number, MinuteAgg>();
    for (let i = 0; i < histogramWindowMinutes; i++) {
      sums.set(minMs + i * MINUTE_MS, {
        total: 0,
        count: 0,
        min: Infinity,
        max: -Infinity,
      });
    }
    for (const block of blocks) {
      const ts = Date.parse(block.blockDate);
      if (!Number.isFinite(ts)) continue;
      const minute = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
      const bucket = sums.get(minute);
      if (!bucket) continue;
      let gwei: number;
      try {
        gwei = Number(BigInt(block.baseBlockFeeWei)) / 1e9;
      } catch {
        continue;
      }
      if (!Number.isFinite(gwei)) continue;
      bucket.total += gwei;
      bucket.count += 1;
      if (gwei < bucket.min) bucket.min = gwei;
      if (gwei > bucket.max) bucket.max = gwei;
    }
    const series = Array.from(sums.entries())
      .map(([minuteMs, { total, count, min, max }]) => ({
        ts: minuteMs,
        avg: count > 0 ? total / count : null,
        min: count > 0 ? min : null,
        max: count > 0 ? max : null,
      }))
      .sort((a, b) => a.ts - b.ts);

    const xs = series.map((p) => new Date(p.ts).toISOString());
    const ysAvg = series.map((p) => p.avg);
    const ysMin = series.map((p) => p.min);
    const ysMax = series.map((p) => p.max);
    const bandFill = withAlpha(baseColor, 0.18);
    const bandLine = withAlpha(baseColor, 0.5);

    const maxTrace: Partial<Plotly.PlotData> = {
      type: "scatter",
      mode: "lines+markers",
      x: xs,
      y: ysMax as unknown as Plotly.Datum[],
      connectgaps: true,
      line: { color: bandLine, width: 1, shape: "linear" },
      marker: { color: bandLine, size: 3, line: { width: 0 } },
      hovertemplate: "max %{y:,.3f} gwei<extra></extra>",
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
      hovertemplate: "min %{y:,.3f} gwei<extra></extra>",
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
      hovertemplate: "<b>Base fee</b><br>%{x|%H:%M}<br>%{y:,.3f} gwei avg<extra></extra>",
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
        bgcolor: getCssColor("--sand", "#f6f4ef"),
        bordercolor: gridColor,
        font: { color: getCssColor("--ink", "#111111"), size: 12 },
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
        ticksuffix: " gwei",
      },
    };

    return { traces: [maxTrace, minTrace, avgTrace], layout };
  }, [blocks, currentMinuteMs, histogramWindowMinutes, baseColor, gridColor, textColor]);

  return (
    <section className="home-feed-panel home-histogram-panel">
      <div className="home-panel-heading">
        <h3 className="home-panel-heading-title home-histogram-title">
          <span
            className="home-histogram-swatch"
            aria-hidden="true"
            style={{ background: baseColor }}
          />
          Base block fee
          <InfoTooltip label="What is base block fee?">
            <strong>Base block fee (EIP‑1559)</strong>
            <p>
              The minimum gas price required for a transaction to be included in a
              block. Set algorithmically by the protocol — it rises when blocks are
              full and falls when they are empty, targeting ~50% utilization. The
              base fee is burnt rather than paid to miners.
            </p>
            <p>
              Shown in gwei (1 gwei = 10⁻⁹ ETH). The solid line is the per‑minute
              average; the band shows the per‑minute min/max range.
            </p>
          </InfoTooltip>
        </h3>
        <span>{`gwei · last ${histogramWindowMinutes} min`}</span>
      </div>
      <div className="home-histogram-chart">
        {error && !loaded ? (
          <div className="home-feed-empty-state">
            <strong>Unable to load chart.</strong>
            <span>{error}</span>
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
      </div>
    </section>
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
