import { assertSupportedRangeSize, rangeStartFor } from "./ranges";
import type { ScannerStorage } from "./storage";

export interface AggregateRangesOptions {
  rangeSize: bigint;
  fromBlock?: bigint;
  toBlock?: bigint;
  onWindow?: (rangeStart: bigint, status: "written" | "incomplete") => void;
}

export interface AggregateRangesResult {
  written: number;
  incomplete: number;
  firstRangeStart?: bigint;
  lastRangeStart?: bigint;
}

export async function aggregateRanges(
  storage: ScannerStorage,
  options: AggregateRangesOptions,
): Promise<AggregateRangesResult> {
  const { rangeSize, fromBlock, toBlock, onWindow } = options;
  assertSupportedRangeSize(rangeSize);

  const minBlock = await storage.getMinStoredBlock();
  const maxBlock = await storage.getMaxStoredBlock();
  if (minBlock === undefined || maxBlock === undefined) {
    return { written: 0, incomplete: 0 };
  }

  const lowerBound = fromBlock !== undefined && fromBlock > minBlock ? fromBlock : minBlock;
  const upperBound = toBlock !== undefined && toBlock < maxBlock ? toBlock : maxBlock;
  if (lowerBound > upperBound) {
    return { written: 0, incomplete: 0 };
  }

  const firstRangeStart = rangeStartFor(lowerBound, rangeSize);
  const lastRangeStart = rangeStartFor(upperBound, rangeSize);

  let written = 0;
  let incomplete = 0;

  for (
    let rangeStart = firstRangeStart;
    rangeStart <= lastRangeStart;
    rangeStart += rangeSize
  ) {
    const result = await storage.aggregateRangeIfComplete(rangeStart, rangeSize);
    if (result) {
      written += 1;
      onWindow?.(rangeStart, "written");
    } else {
      incomplete += 1;
      onWindow?.(rangeStart, "incomplete");
    }
  }

  return {
    written,
    incomplete,
    firstRangeStart,
    lastRangeStart,
  };
}
