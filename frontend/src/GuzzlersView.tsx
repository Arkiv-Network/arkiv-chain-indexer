import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AddressFace } from "./AddressFace";
import { Cedric } from "./Cedric";
import { fetchGuzzlers, type GuzzlerStat, type GuzzlersResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { CopyButton } from "@/components/copy-cell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fmtDurationSeconds, fmtInteger, fmtTokenAmount } from "./format";
import { GuzzlerActivityView } from "./GuzzlerActivityView";
import {
  activityWindowForMs,
  normalizeActivityWindowKey,
  normalizeAddressInput,
  type GuzzlerActivityWindowKey,
} from "./guzzlerActivity";
import { buildPermalinkHref, shouldHandleClientNavigation, writePermalink } from "./permalinks";

interface GuzzlersViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}

/** The drill-in address from the URL (`/activity?address=0x...`), if valid. */
function readSelectedAddress(search: string): string | null {
  return normalizeAddressInput(new URLSearchParams(search).get("address"));
}

/** The activity window from the URL (`&window=6h`), if it's a known key. */
function readSelectedWindow(search: string): GuzzlerActivityWindowKey | null {
  return normalizeActivityWindowKey(new URLSearchParams(search).get("window"));
}

/**
 * The list can hold many addresses, so we mount the cards in batches and reveal
 * more as the user scrolls. Every returned address is still reachable — we just
 * never build the whole DOM in one frame.
 */
const BATCH = 150;

/** Top-N senders requested per window. */
const LIMIT = 250;

/**
 * Window tabs. The backend ranks senders independently for each of these spans
 * and returns the top-N per window, keyed by `label`; the tab just picks which
 * window's leaderboard to render.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WINDOWS = [
  { key: "5m", label: "5 min", ms: 5 * MINUTE_MS },
  { key: "20m", label: "20 min", ms: 20 * MINUTE_MS },
  { key: "1h", label: "1 hour", ms: HOUR_MS },
  { key: "6h", label: "6 hours", ms: 6 * HOUR_MS },
  { key: "24h", label: "24 hours", ms: 24 * HOUR_MS },
] as const;

type WindowKey = (typeof WINDOWS)[number]["key"];

export function GuzzlersView({
  locationSearch,
  onLocationChange,
  timeZone,
  tokenSymbol,
}: GuzzlersViewProps) {
  const selectedAddress = readSelectedAddress(locationSearch);
  const selectedWindow = readSelectedWindow(locationSearch);

  // Navigate by rewriting the `address`/`window` permalink params; App re-reads
  // the URL. The window is kept so a drill-in (and reloads/links) preserve it.
  const navigate = useCallback(
    (address: string, windowKey?: GuzzlerActivityWindowKey) => {
      const filters: Record<string, string> = { address };
      if (windowKey) filters.window = windowKey;
      if (writePermalink("guzzlers", filters)) onLocationChange();
    },
    [onLocationChange],
  );
  const clearAddress = useCallback(() => {
    if (writePermalink("guzzlers", {})) onLocationChange();
  }, [onLocationChange]);

  if (selectedAddress) {
    return (
      <GuzzlerActivityView
        address={selectedAddress}
        windowKey={selectedWindow ?? "24h"}
        timeZone={timeZone}
        tokenSymbol={tokenSymbol}
        onBack={clearAddress}
        // Switching address keeps the current window selection.
        onSelectAddress={(address) => navigate(address, selectedWindow ?? undefined)}
        onWindowChange={(windowKey) => navigate(selectedAddress, windowKey)}
      />
    );
  }

  return (
    <GuzzlerLeaderboard
      tokenSymbol={tokenSymbol}
      onSelectAddress={navigate}
    />
  );
}

function GuzzlerLeaderboard({
  tokenSymbol,
  onSelectAddress,
}: {
  tokenSymbol: string;
  onSelectAddress: (address: string, windowKey: GuzzlerActivityWindowKey) => void;
}) {
  const [data, setData] = useState<GuzzlersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [windowKey, setWindowKey] = useState<WindowKey>("1h");
  // Monotonic counter bumped on every successful refresh — drives Cedric's
  // reappearance the way new blocks do on the home feed.
  const [refreshTick, setRefreshTick] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGuzzlers(LIMIT)
      .then((body) => {
        setData(body);
        setNow(Date.now());
        setRefreshTick((tick) => tick + 1);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const refresh = window.setInterval(load, 15_000);
    return () => window.clearInterval(refresh);
  }, [load]);

  // Restart the reveal window whenever the time filter changes.
  useEffect(() => {
    setVisibleCount(BATCH);
  }, [windowKey]);

  const selectedWindow = WINDOWS.find((w) => w.key === windowKey) ?? WINDOWS[2];
  const selectedBoard = useMemo(
    () => data?.windows.find((w) => w.label === windowKey) ?? null,
    [data, windowKey],
  );
  const guzzlers = selectedBoard?.guzzlers ?? [];

  // The backend already ranked and cut to the top-N for this window; `total` is
  // how many we received, `activeCount` how many were active before the cut.
  const total = guzzlers.length;
  const activeCount = selectedBoard?.count ?? 0;
  const maxGas = total > 0 ? toBigInt(guzzlers[0]!.totalGasUsed) : 0n;
  const shown = Math.min(visibleCount, total);

  // Grow the visible window when the sentinel scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || shown >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => current + BATCH);
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [shown, total]);

  return (
    <section className="mx-auto flex w-full max-w-415 flex-col gap-4 px-3 py-6 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-black tracking-tight">Most Active Wallets (1h)</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs value={windowKey} onValueChange={(value) => setWindowKey(value as WindowKey)}>
            <TabsList aria-label="Active window">
              {WINDOWS.map((w) => (
                <TabsTrigger key={w.key} value={w.key}>
                  {w.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        These are the network's most active wallets — the senders submitting the
        most transactions over the selected window, ranked by total gas used.
      </p>

      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error
          ? `Failed to load guzzlers: ${error}`
          : data
            ? `${fmtInteger(total)} of ${fmtInteger(activeCount)} addresses active in the last ${
                selectedWindow.label
              }, ranked by gas used.`
            : loading
              ? "Loading guzzlers…"
              : "No guzzlers loaded."}
      </p>

      <div className="relative">
        <Cedric progress={refreshTick} />
        <ol className="relative z-10 flex flex-col gap-2">
          {guzzlers.slice(0, shown).map((g, index) => (
            <GuzzlerCard
              key={g.address}
              rank={index + 1}
              guzzler={g}
              maxGas={maxGas}
              nowMs={now}
              tokenSymbol={tokenSymbol}
              // Carry the leaderboard's window selection into the activity view.
              activityWindowKey={activityWindowForMs(selectedWindow.ms)}
              onSelect={onSelectAddress}
            />
          ))}
        </ol>
      </div>

      {shown < total ? (
        <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
          Showing {fmtInteger(shown)} of {fmtInteger(total)} — scroll for more…
        </div>
      ) : null}
    </section>
  );
}

function GuzzlerCard({
  rank,
  guzzler,
  maxGas,
  nowMs,
  tokenSymbol,
  activityWindowKey,
  onSelect,
}: {
  rank: number;
  guzzler: GuzzlerStat;
  maxGas: bigint;
  nowMs: number;
  tokenSymbol: string;
  activityWindowKey: GuzzlerActivityWindowKey;
  onSelect: (address: string, windowKey: GuzzlerActivityWindowKey) => void;
}) {
  const display = addressDisplay(guzzler.address);
  const gas = toBigInt(guzzler.totalGasUsed);
  const barPct = maxGas > 0n ? Number((gas * 1000n) / maxGas) / 10 : 0;
  const lastSeenAgo = secondsSince(nowMs, guzzler.lastSeen);
  const href = buildPermalinkHref("guzzlers", { address: guzzler.address, window: activityWindowKey });
  const label = `View activity for ${display.label}`;
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!shouldHandleClientNavigation(event)) return;
    event.preventDefault();
    onSelect(guzzler.address, activityWindowKey);
  };

  return (
    <li className="relative grid grid-cols-[2.25rem_40px_minmax(0,1fr)_auto] items-center gap-3 border border-border bg-card px-3 py-2.5">
      <a className="absolute inset-0 z-[1]" href={href} onClick={open} aria-label={label} />
      <span className={cn("text-right font-mono text-sm font-semibold tabular-nums text-muted-foreground", rank <= 3 && "text-accent")}>
        {rank}
      </span>
      <AddressFace address={guzzler.address} loading="lazy" className="size-10 border border-border" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <AddressLabel address={guzzler.address} label={display.label} title={display.title} />
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span
            className="absolute inset-y-0 left-0 min-w-0.5 rounded-full bg-gradient-to-r from-accent to-primary"
            style={{ width: `${barPct}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          last seen {lastSeenAgo === null ? "—" : `${fmtDurationSeconds(lastSeenAgo)} ago`}
        </span>
      </div>
      <dl className="flex gap-4">
        <div className="flex flex-col items-end gap-0.5">
          <dt className="order-2 text-[10px] tracking-wider text-muted-foreground uppercase">Gas used</dt>
          <dd className="order-1 font-mono text-sm font-semibold tabular-nums">{fmtInteger(guzzler.totalGasUsed)}</dd>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <dt className="order-2 text-[10px] tracking-wider text-muted-foreground uppercase">Txs</dt>
          <dd className="order-1 font-mono text-sm font-semibold tabular-nums">{fmtInteger(guzzler.transactionCount)}</dd>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <dt className="order-2 text-[10px] tracking-wider text-muted-foreground uppercase">Fees</dt>
          <dd className="order-1 font-mono text-sm font-semibold tabular-nums">{fmtTokenAmount(guzzler.totalFeeWei, tokenSymbol)}</dd>
        </div>
      </dl>
    </li>
  );
}

function AddressLabel({
  address,
  label,
  title,
}: {
  address: string;
  label: string;
  title?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono text-sm" title={title ?? address}>
        {label}
      </span>
      <CopyButton value={address} label="address" className="relative z-[2]" />
    </span>
  );
}

function toBigInt(value: string | null | undefined): bigint {
  try {
    return BigInt(value ?? "0");
  } catch {
    return 0n;
  }
}

function secondsSince(nowMs: number, iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, (nowMs - then) / 1000);
}
