import type { Hex } from "./types";

export function hexToBigInt(value: Hex | undefined | null): bigint {
  if (!value) {
    return 0n;
  }

  return BigInt(value);
}

export function blockNumberToHex(blockNumber: bigint): Hex {
  if (blockNumber < 0n) {
    throw new Error("Block number cannot be negative");
  }

  return `0x${blockNumber.toString(16)}`;
}

export function average(values: bigint[]): bigint {
  if (values.length === 0) {
    return 0n;
  }

  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}
