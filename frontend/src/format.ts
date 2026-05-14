export function fmtGwei(weiStr: string | null | undefined): string {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    const wei = BigInt(weiStr);
    const whole = wei / 1_000_000_000n;
    const frac = wei % 1_000_000_000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return String(weiStr);
  }
}

export function fmtEth(weiStr: string | null | undefined): string {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    const wei = BigInt(weiStr);
    const whole = wei / 1_000_000_000_000_000_000n;
    const frac = wei % 1_000_000_000_000_000_000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
    return `${whole.toString()}.${fracStr}`;
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

export function fmtInteger(value: string | number | null | undefined): string {
  if (value === undefined || value === null) return "—";
  try {
    return BigInt(value).toString();
  } catch {
    return String(value);
  }
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return value;
  }
}
