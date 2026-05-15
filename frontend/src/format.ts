const MAX_DISPLAY_FRACTION_DIGITS = 4;
const GWEI_IN_WEI = 1_000_000_000n;
const ETH_IN_WEI = 1_000_000_000_000_000_000n;

export function fmtGwei(weiStr: string | null | undefined): string {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    return formatBigIntDecimal(BigInt(weiStr), GWEI_IN_WEI, MAX_DISPLAY_FRACTION_DIGITS);
  } catch {
    return String(weiStr);
  }
}

export function fmtEth(weiStr: string | null | undefined): string {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    return formatBigIntDecimal(BigInt(weiStr), ETH_IN_WEI, MAX_DISPLAY_FRACTION_DIGITS);
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

function formatBigIntDecimal(value: bigint, divisor: bigint, maxFractionDigits: number): string {
  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? -value : value;
  const whole = absoluteValue / divisor;
  const remainder = absoluteValue % divisor;

  if (remainder === 0n || maxFractionDigits === 0) {
    return `${sign}${whole.toString()}`;
  }

  const scale = 10n ** BigInt(maxFractionDigits);
  const fraction = (remainder * scale) / divisor;
  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  const fractionStr = fraction.toString().padStart(maxFractionDigits, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fractionStr}`;
}

export function fmtInteger(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  try {
    return BigInt(value).toString();
  } catch {
    return String(value);
  }
}

export function fmtDate(value: string | null | undefined, timeZone = "UTC"): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return new Intl.DateTimeFormat("en-CA", {
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
  } catch {
    return value;
  }
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
