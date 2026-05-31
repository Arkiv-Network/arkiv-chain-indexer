import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddressFace } from "./AddressFace";
import { fetchGuzzlers, type GuzzlerStat, type GuzzlersResponse } from "./api";
import { addressDisplay } from "./addressAliases";
import { fmtDurationSeconds, fmtEth, fmtInteger } from "./format";
import { GuzzlerActivityView } from "./GuzzlerActivityView";
import {
  activityWindowForMs,
  normalizeActivityWindowKey,
  normalizeAddressInput,
  type GuzzlerActivityWindowKey,
} from "./guzzlerActivity";
import { writePermalink } from "./permalinks";

interface GuzzlersViewProps {
  locationSearch: string;
  onLocationChange: () => void;
  timeZone: string;
  tokenSymbol: string;
}

/** The drill-in address from the URL (`?view=guzzlers&address=0x…`), if valid. */
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
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGuzzlers(LIMIT)
      .then((body) => {
        setData(body);
        setNow(Date.now());
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
    <section className="view guzzlers-view">
      <div className="view-heading-row">
        <h2>Most Active Wallets (1h)</h2>
        <div className="guzzler-controls">
          <div className="segmented" role="group" aria-label="Active window">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                className={w.key === windowKey ? "active" : ""}
                aria-pressed={w.key === windowKey}
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" onClick={load} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      <p className="guzzler-intro summary">
        These are the network's most active wallets — the senders submitting the
        most transactions over the selected window, ranked by total gas used.
      </p>

      <p className={`summary${error ? " error" : ""}`}>
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

      <ol className="guzzler-list">
        {guzzlers.slice(0, shown).map((g, index) => (
          <GuzzlerCard
            key={g.address}
            rank={index + 1}
            guzzler={g}
            maxGas={maxGas}
            nowMs={now}
            tokenSymbol={tokenSymbol}
            // Carry the leaderboard's window selection into the activity view.
            onSelect={(address) => onSelectAddress(address, activityWindowForMs(selectedWindow.ms))}
          />
        ))}
      </ol>

      {shown < total ? (
        <div ref={sentinelRef} className="guzzler-sentinel">
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
  onSelect,
}: {
  rank: number;
  guzzler: GuzzlerStat;
  maxGas: bigint;
  nowMs: number;
  tokenSymbol: string;
  onSelect: (address: string) => void;
}) {
  const display = addressDisplay(guzzler.address);
  const gas = toBigInt(guzzler.totalGasUsed);
  const barPct = maxGas > 0n ? Number((gas * 1000n) / maxGas) / 10 : 0;
  const lastSeenAgo = secondsSince(nowMs, guzzler.lastSeen);
  const open = () => onSelect(guzzler.address);

  return (
    <li
      className="guzzler-card clickable"
      role="button"
      tabIndex={0}
      aria-label={`View activity for ${display.label}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      <span className={`guzzler-rank${rank <= 3 ? " top" : ""}`}>{rank}</span>
      <AddressFace address={guzzler.address} loading="lazy" />
      <div className="guzzler-main">
        <div className="guzzler-id">
          <AddressLabel address={guzzler.address} label={display.label} title={display.title} />
        </div>
        <div className="guzzler-bar" aria-hidden="true">
          <span style={{ width: `${barPct}%` }} />
        </div>
        <span className="guzzler-meta">
          last seen {lastSeenAgo === null ? "—" : `${fmtDurationSeconds(lastSeenAgo)} ago`}
        </span>
      </div>
      <dl className="guzzler-stats">
        <div>
          <dt>Gas used</dt>
          <dd>{fmtInteger(guzzler.totalGasUsed)}</dd>
        </div>
        <div>
          <dt>Txs</dt>
          <dd>{fmtInteger(guzzler.transactionCount)}</dd>
        </div>
        <div>
          <dt>Fees ({tokenSymbol})</dt>
          <dd>{fmtEth(guzzler.totalFeeWei)}</dd>
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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const onCopy = async (event: React.MouseEvent) => {
    // The card is clickable; copying must not also navigate into the address.
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <span className="guzzler-address">
      <span className="mono" title={title ?? address}>
        {label}
      </span>
      <button
        type="button"
        className="copy-cell-button"
        aria-label="Copy address"
        title={copied ? "Copied" : "Copy address"}
        onClick={onCopy}
      >
        <span aria-hidden="true" className="copy-cell-icon" />
      </button>
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
