import { assertSupportedRangeSize, rangeStartFor } from "./ranges";
import type { ScannerStorage } from "./storage";

export interface AggregateRangesOptions {
  rangeSize: bigint;
  fromBlock?: bigint;
  toBlock?: bigint;
  skipCompleted?: boolean;
  stopAfterIncomplete?: boolean;
  onWindow?: (rangeStart: bigint, status: "written" | "incomplete") => void;
}

export interface AggregateRangesResult {
  written: number;
  incomplete: number;
  skippedComplete: number;
  firstRangeStart?: bigint;
  lastRangeStart?: bigint;
  processedFirstRangeStart?: bigint;
  processedLastRangeStart?: bigint;
}

export async function aggregateRanges(
  storage: ScannerStorage,
  options: AggregateRangesOptions,
): Promise<AggregateRangesResult> {
  const { rangeSize, fromBlock, toBlock, skipCompleted = false, stopAfterIncomplete = false, onWindow } =
    options;
  assertSupportedRangeSize(rangeSize);

  const minBlock = await storage.getMinStoredBlock();
  const maxBlock = await storage.getMaxStoredBlock();
  if (minBlock === undefined || maxBlock === undefined) {
    return { written: 0, incomplete: 0, skippedComplete: 0 };
  }

  const lowerBound = fromBlock !== undefined && fromBlock > minBlock ? fromBlock : minBlock;
  const upperBound = toBlock !== undefined && toBlock < maxBlock ? toBlock : maxBlock;
  if (lowerBound > upperBound) {
    return { written: 0, incomplete: 0, skippedComplete: 0 };
  }

  const firstRangeStart = rangeStartFor(lowerBound, rangeSize);
  const lastRangeStart = rangeStartFor(upperBound, rangeSize);
  let processedFirstRangeStart = firstRangeStart;
  let skippedComplete = 0;

  if (skipCompleted) {
    const latestCompleteRangeStart = await storage.getLatestCompleteRangeStart(rangeSize);
    if (latestCompleteRangeStart !== undefined && latestCompleteRangeStart >= processedFirstRangeStart) {
      const latestSkippedRangeStart =
        latestCompleteRangeStart < lastRangeStart ? latestCompleteRangeStart : lastRangeStart;
      skippedComplete =
        Number((latestSkippedRangeStart - processedFirstRangeStart) / rangeSize) + 1;
      processedFirstRangeStart = latestCompleteRangeStart + rangeSize;
    }
  }

  let written = 0;
  let incomplete = 0;
  let processedLastRangeStart: bigint | undefined;

  for (
    let rangeStart = processedFirstRangeStart;
    rangeStart <= lastRangeStart;
    rangeStart += rangeSize
  ) {
    processedLastRangeStart = rangeStart;
    const result = await storage.aggregateRangeIfComplete(rangeStart, rangeSize);
    if (result) {
      written += 1;
      onWindow?.(rangeStart, "written");
    } else {
      incomplete += 1;
      onWindow?.(rangeStart, "incomplete");
      if (stopAfterIncomplete) break;
    }
  }

  return {
    written,
    incomplete,
    skippedComplete,
    firstRangeStart,
    lastRangeStart,
    ...(processedLastRangeStart !== undefined
      ? {
          processedFirstRangeStart,
          processedLastRangeStart,
        }
      : {}),
  };
}
