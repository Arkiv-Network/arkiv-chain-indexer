const GWEI_IN_WEI = 1_000_000_000n;
const ETH_IN_WEI = 1_000_000_000_000_000_000n;
const SIG_DIGITS = 4;
const MAX_DECIMALS = 9;
const ZERO_THRESHOLD = 1e-8;
const LARGE_THRESHOLD = 1000;
const PRECISION_SCALE = 1_000_000_000_000n; // 1e12 — enough headroom for MAX_DECIMALS
const TIME_ZONE_LABELS: Record<string, string> = {
  "Europe/Berlin": "CET",
  "Europe/Warsaw": "CET",
};

export function fmtGwei(weiStr: string | null | undefined): string {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    return fmtSig(weiToScaledNumber(BigInt(weiStr), GWEI_IN_WEI));
  } catch {
    return String(weiStr);
  }
}

export function fmtEth(
  weiStr: string | null | undefined,
  options: FmtSigOptions = {},
): string {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    return fmtSig(weiToScaledNumber(BigInt(weiStr), ETH_IN_WEI), options);
  } catch {
    return String(weiStr);
  }
}

export function fmtRatio(usedStr: string | null | undefined, limitStr: string | null | undefined): string {
  if (!usedStr || !limitStr) return "—";
  try {
    const used = BigInt(usedStr);
    const limit = BigInt(limitStr);
    if (limit === 0n) return `${used.toString()} / 0`;
    const pct = Number((used * 10_000n) / limit) / 100;
    return `${used.toString()} / ${limit.toString()} (${pct.toFixed(2)}%)`;
  } catch {
    return `${usedStr} / ${limitStr}`;
  }
}

export interface FmtSigOptions {
  /** Trim trailing zeros from the fractional part (default true). Set false to keep
   *  the full significant-digit width, e.g. "9.380" instead of "9.38". */
  trimZeros?: boolean;
}

/**
 * Renders a number with up to 4 significant digits, picking a sensible width:
 *   - |x| < 1e-8       → "0"
 *   - |x| >= 1000      → fixed 1 decimal place ("1234.5")
 *   - otherwise        → 4 significant digits, capped at 9 decimals, trailing
 *                        zeros trimmed ("0.0001345", "1.234", "999.9")
 */
export function fmtSig(
  value: number | string | null | undefined,
  options: FmtSigOptions = {},
): string {
  const { trimZeros = true } = options;
  if (value === undefined || value === null) return "—";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (num === 0) return "0";

  const abs = Math.abs(num);
  if (abs < ZERO_THRESHOLD) return "0";

  if (abs >= LARGE_THRESHOLD) {
    return num.toFixed(1);
  }

  const exp = Math.floor(Math.log10(abs));
  const decimals = Math.min(MAX_DECIMALS, Math.max(0, SIG_DIGITS - 1 - exp));
  let result = num.toFixed(decimals);

  if (trimZeros && result.includes(".")) {
    result = result.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  return result;
}

function weiToScaledNumber(value: bigint, divisor: bigint): number {
  const negative = value < 0n;
  const absValue = negative ? -value : value;
  const scaled = (absValue * PRECISION_SCALE) / divisor;
  const result = Number(scaled) / Number(PRECISION_SCALE);
  return negative ? -result : result;
}

export function fmtInteger(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  try {
    return BigInt(value).toString();
  } catch {
    return String(value);
  }
}

/** Render a raw count in millions with two decimals and an "M" suffix (e.g. 53431992 → "53.43M"). */
export function fmtMillions(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${(num / 1_000_000).toFixed(2)}M`;
}

/** Render a raw count in thousands with two decimals and a "K" suffix (e.g. 2025329 → "2025.33K"). */
export function fmtThousands(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${(num / 1_000).toFixed(2)}K`;
}

export function fmtBytes(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return String(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = parsed;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.floor(size)} ${units[unitIndex]}`;
  return `${size.toFixed(size < 10 ? 2 : 1)} ${units[unitIndex]}`;
}

export function fmtDate(value: string | null | undefined, timeZone = "UTC"): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).format(d);
    return normalizeTimeZoneLabel(formatted, timeZone);
  } catch {
    return value;
  }
}

function normalizeTimeZoneLabel(formatted: string, timeZone: string): string {
  const label = TIME_ZONE_LABELS[timeZone];
  if (!label) return formatted;
  return formatted.replace(/\sGMT[+-]\d{1,2}(?::\d{2})?$/, ` ${label}`);
}

export function fmtUtcDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return value;
  }
}

export function fmtDurationSeconds(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
