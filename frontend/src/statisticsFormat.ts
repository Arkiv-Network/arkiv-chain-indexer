export type StatisticsByteUnit = "bytes" | "decimal" | "binary";

export function isStatisticsByteUnit(value: string): value is StatisticsByteUnit {
  return value === "bytes" || value === "decimal" || value === "binary";
}

/** Format totals or per-transaction means without converting large byte counts to Number. */
export function formatStatisticsBytes(
  value: string | null,
  unit: StatisticsByteUnit,
  count = "1",
): string {
  if (value === null) return "Unavailable";
  const divisor = BigInt(count);
  if (divisor === 0n) return "—";
  const bytes = BigInt(value);
  if (unit === "bytes" && divisor === 1n) return `${bytes.toLocaleString("en-US")} B`;
  const base = unit === "binary" ? 1024n : 1000n;
  const units = unit === "bytes" ? ["B"] : unit === "binary"
    ? ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"]
    : ["B", "kB", "MB", "GB", "TB", "PB", "EB"];
  let scale = 1n;
  let index = 0;
  while (index < units.length - 1 && bytes >= divisor * scale * base) {
    scale *= base;
    index++;
  }
  const rounded = () => (bytes * 100n + divisor * scale / 2n) / (divisor * scale);
  // Promote values that would otherwise round to 1000 kB or 1024 KiB.
  if (index < units.length - 1 && rounded() >= base * 100n) {
    scale *= base;
    index++;
  }
  const hundredths = rounded();
  const fraction = (hundredths % 100n).toString().padStart(2, "0");
  const decimals = index === 0 && fraction === "00" ? "" : `.${fraction}`;
  return `${(hundredths / 100n).toLocaleString("en-US")}${decimals} ${units[index]}`;
}
