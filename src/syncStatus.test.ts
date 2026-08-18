import { describe, expect, test } from "bun:test";
import { computeSyncStatus, formatDuration, measureRates, type ScanSample } from "./syncStatus";

const BLOCK_TIME_SECONDS = 2;

/**
 * Build a forward-scan run ending at `tipBlock`, where the scanner stored
 * `blocksPerSecond` blocks per wall-clock second and the chain produces one
 * block every {@link BLOCK_TIME_SECONDS}.
 */
function forwardRun(options: {
  tipBlock: bigint;
  count: number;
  blocksPerSecond: number;
  tipScannedAt: Date;
  tipBlockDate: Date;
}): ScanSample[] {
  const samples: ScanSample[] = [];
  for (let index = options.count - 1; index >= 0; index -= 1) {
    const blockNumber = options.tipBlock - BigInt(index);
    samples.push({
      blockNumber,
      blockDate: new Date(
        options.tipBlockDate.getTime() - index * BLOCK_TIME_SECONDS * 1000,
      ).toISOString(),
      scannedAtUtc: new Date(
        options.tipScannedAt.getTime() - (index / options.blocksPerSecond) * 1000,
      ).toISOString(),
    });
  }
  return samples;
}

describe("measureRates", () => {
  test("derives scan speed and chain block time from a forward run", () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const samples = forwardRun({
      tipBlock: 1000n,
      count: 101,
      blocksPerSecond: 10,
      tipScannedAt: now,
      tipBlockDate: now,
    });

    const rates = measureRates(samples, 1000n);

    expect(rates.measuredBlocks).toBe(100);
    expect(rates.measuredWindowSeconds).toBeCloseTo(10, 6);
    expect(rates.scanBlocksPerSecond).toBeCloseTo(10, 6);
    expect(rates.chainBlockTimeSeconds).toBeCloseTo(BLOCK_TIME_SECONDS, 6);
    expect(rates.chainBlocksPerSecond).toBeCloseTo(0.5, 6);
  });

  test("ignores backfilled blocks written below the forward run", () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const forward = forwardRun({
      tipBlock: 1000n,
      count: 11,
      blocksPerSecond: 1,
      tipScannedAt: now,
      tipBlockDate: now,
    });
    // A backfill pass stored block 989 seconds ago in chain time but only a
    // moment ago in wall-clock time; counting it would invent forward progress.
    const backfilled: ScanSample = {
      blockNumber: 989n,
      blockDate: new Date(now.getTime() - 22_000).toISOString(),
      scannedAtUtc: now.toISOString(),
    };

    const rates = measureRates([backfilled, ...forward], 1000n);

    expect(rates.measuredBlocks).toBe(10);
    expect(rates.scanBlocksPerSecond).toBeCloseTo(1, 6);
  });

  test("decays the scan rate while nothing new is stored", () => {
    const now = new Date("2026-08-18T12:00:00.000Z");
    const samples = forwardRun({
      tipBlock: 1000n,
      count: 11,
      blocksPerSecond: 1,
      // Last stored ten seconds after the run started, but that was 30s ago.
      tipScannedAt: new Date(now.getTime() - 30_000),
      tipBlockDate: now,
    });

    const rates = measureRates(samples, 1000n, now.getTime());

    expect(rates.measuredWindowSeconds).toBeCloseTo(40, 6);
    expect(rates.scanBlocksPerSecond).toBeCloseTo(0.25, 6);
  });

  test("returns nulls without samples", () => {
    expect(measureRates([], 10n).scanBlocksPerSecond).toBeNull();
  });
});

describe("computeSyncStatus", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  test("reports a caught-up scanner as synced", () => {
    const status = computeSyncStatus({
      now,
      lastSuccessfulBlock: 1000n,
      lastSuccessfulBlockDate: new Date(now.getTime() - 2000).toISOString(),
      lastSuccessfulScannedAt: new Date(now.getTime() - 1000).toISOString(),
      latestObservedBlock: 1001n,
      latestObservedAt: new Date(now.getTime() - 1000).toISOString(),
      samples: forwardRun({
        tipBlock: 1000n,
        count: 51,
        blocksPerSecond: 0.5,
        tipScannedAt: now,
        tipBlockDate: now,
      }),
    });

    expect(status.state).toBe("synced");
    expect(status.lagBlocks).toBe("1");
    expect(status.etaSeconds).toBeNull();
  });

  test("estimates lag and ETA while catching up", () => {
    // Chain head observed 100s ago at block 6000; at a 2s block time the chain
    // has since produced 50 more blocks.
    const status = computeSyncStatus({
      now,
      lastSuccessfulBlock: 1000n,
      lastSuccessfulBlockDate: new Date(now.getTime() - 10_100 * 1000).toISOString(),
      lastSuccessfulScannedAt: new Date(now.getTime() - 1000).toISOString(),
      latestObservedBlock: 6000n,
      latestObservedAt: new Date(now.getTime() - 100_000).toISOString(),
      samples: forwardRun({
        tipBlock: 1000n,
        count: 101,
        blocksPerSecond: 10,
        tipScannedAt: now,
        tipBlockDate: new Date(now.getTime() - 10_100 * 1000),
      }),
    });

    expect(status.state).toBe("catching-up");
    expect(status.estimatedHeadBlock).toBe("6050");
    expect(status.observedLagBlocks).toBe("5000");
    expect(status.lagBlocks).toBe("5050");
    expect(status.headObservationStale).toBe(true);
    expect(status.speedupFactor).toBeCloseTo(20, 6);
    expect(status.netCatchUpBlocksPerSecond).toBeCloseTo(9.5, 6);
    // 5050 blocks of lag closed at 9.5 blocks/s.
    expect(status.etaSeconds).toBeCloseTo(5050 / 9.5, 3);
    expect(status.etaUtc).toBe(new Date(now.getTime() + (5050 / 9.5) * 1000).toISOString());
    expect(status.summary).toContain("catching up");
  });

  test("flags a scanner that loses ground", () => {
    const status = computeSyncStatus({
      now,
      lastSuccessfulBlock: 1000n,
      lastSuccessfulBlockDate: new Date(now.getTime() - 600_000).toISOString(),
      lastSuccessfulScannedAt: new Date(now.getTime() - 1000).toISOString(),
      latestObservedBlock: 1300n,
      latestObservedAt: new Date(now.getTime() - 1000).toISOString(),
      samples: forwardRun({
        tipBlock: 1000n,
        count: 61,
        blocksPerSecond: 0.25,
        tipScannedAt: now,
        tipBlockDate: new Date(now.getTime() - 600_000),
      }),
    });

    expect(status.state).toBe("falling-behind");
    expect(status.netCatchUpBlocksPerSecond).toBeCloseTo(-0.25, 6);
    expect(status.etaSeconds).toBeNull();
    expect(status.summary).toContain("falling further behind");
  });

  test("calls a behind-but-steady scanner holding", () => {
    const status = computeSyncStatus({
      now,
      lastSuccessfulBlock: 1000n,
      lastSuccessfulBlockDate: new Date(now.getTime() - 600_000).toISOString(),
      lastSuccessfulScannedAt: new Date(now.getTime() - 1000).toISOString(),
      latestObservedBlock: 1300n,
      latestObservedAt: new Date(now.getTime() - 1000).toISOString(),
      samples: forwardRun({
        tipBlock: 1000n,
        count: 61,
        blocksPerSecond: 1 / BLOCK_TIME_SECONDS,
        tipScannedAt: now,
        tipBlockDate: new Date(now.getTime() - 600_000),
      }),
    });

    expect(status.state).toBe("holding");
  });

  test("reports a stalled scanner when nothing has been stored recently", () => {
    const stalledSince = new Date(now.getTime() - 600_000);
    const status = computeSyncStatus({
      now,
      lastSuccessfulBlock: 1000n,
      lastSuccessfulBlockDate: stalledSince.toISOString(),
      lastSuccessfulScannedAt: stalledSince.toISOString(),
      latestObservedBlock: 1300n,
      latestObservedAt: new Date(now.getTime() - 1000).toISOString(),
      samples: forwardRun({
        tipBlock: 1000n,
        count: 61,
        blocksPerSecond: 10,
        tipScannedAt: stalledSince,
        tipBlockDate: stalledSince,
      }),
    });

    expect(status.state).toBe("stalled");
    expect(status.lagSeconds).toBeCloseTo(600, 3);
    expect(status.summary).toContain("stopped making progress");
  });

  test("is unknown on an empty database", () => {
    const status = computeSyncStatus({ now, samples: [] });

    expect(status.state).toBe("unknown");
    expect(status.lagBlocks).toBeNull();
    expect(status.summary).toContain("not known yet");
  });
});

describe("formatDuration", () => {
  test("scales the unit to the magnitude", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45.4)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3_720)).toBe("1h 2m");
    expect(formatDuration(90_000)).toBe("1d 1h");
  });
});
