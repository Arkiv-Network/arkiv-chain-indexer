const GWEI_IN_WEI = 1_000_000_000n;
const GAS_IN_KGAS = 1_000n;
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
const MAX_DISPLAY_FRACTION_DIGITS = 4;

export function formatGwei(wei: string | bigint): string {
  return `${formatBigIntDecimal(BigInt(wei), GWEI_IN_WEI, MAX_DISPLAY_FRACTION_DIGITS)} Gwei`;
}

export function formatKGas(gas: string | bigint): string {
  return `${formatBigIntDecimal(BigInt(gas), GAS_IN_KGAS, MAX_DISPLAY_FRACTION_DIGITS)} kGas`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error("Byte count must be a non-negative finite number");
  }

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = BYTE_UNITS[unitIndex] ?? BYTE_UNITS[BYTE_UNITS.length - 1];
  return `${formatNumberDecimal(value, unitIndex === 0 ? 0 : 2)} ${unit}`;
}

export function formatDurationMs(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error("Duration must be a non-negative finite number");
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  return `${formatNumberDecimal(milliseconds / 1000, 2)}s`;
}

function formatBigIntDecimal(value: bigint, divisor: bigint, maxFractionDigits: number): string {
  if (divisor <= 0n) {
    throw new Error("Divisor must be positive");
  }

  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? -value : value;
  const integer = absoluteValue / divisor;
  const remainder = absoluteValue % divisor;

  if (remainder === 0n || maxFractionDigits === 0) {
    return `${sign}${integer.toString()}`;
  }

  const scale = 10n ** BigInt(maxFractionDigits);
  const fraction = (remainder * scale) / divisor;
  if (fraction === 0n) {
    return `${sign}${integer.toString()}`;
  }

  const fractionText = fraction.toString().padStart(maxFractionDigits, "0").replace(/0+$/, "");
  return `${sign}${integer.toString()}.${fractionText}`;
}

function formatNumberDecimal(value: number, maxFractionDigits: number): string {
  const text = value.toFixed(maxFractionDigits);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}
