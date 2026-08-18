import { describe, expect, test } from "bun:test";
import type { SyncStatus } from "./src/api";
import { describeLag, describeSync, describeThroughput, fmtRate } from "./src/syncStatus";

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: "synced",
    summary: "",
    lastSuccessfulBlock: "1000",
    lastSuccessfulBlockDate: "2026-08-18T12:00:00.000Z",
    latestObservedBlock: "1001",
    latestObservedAtUtc: "2026-08-18T12:00:00.000Z",
    headObservationAgeSeconds: 1,
    headObservationStale: false,
    estimatedHeadBlock: "1001",
    observedLagBlocks: "1",
    lagBlocks: "1",
    lagSeconds: 2,
    chainBlockTimeSeconds: 2,
    chainBlocksPerSecond: 0.5,
    scanBlocksPerSecond: 0.5,
    speedupFactor: 1,
    netCatchUpBlocksPerSecond: 0,
    etaSeconds: null,
    etaUtc: null,
    measuredWindowSeconds: 120,
    measuredBlocks: 60,
    ...overrides,
  };
}

describe("describeSync", () => {
  test("stays quiet while the scanner is at the head", () => {
    const presentation = describeSync(syncStatus());

    expect(presentation.shouldWarn).toBe(false);
    expect(presentation.tone).toBe("ok");
    expect(presentation.headline).toContain("at the chain head");
  });

  test("reports lag, speed, and ETA while catching up", () => {
    const presentation = describeSync(
      syncStatus({
        state: "catching-up",
        lagBlocks: "5050",
        lagSeconds: 10_100,
        scanBlocksPerSecond: 10,
        speedupFactor: 20,
        netCatchUpBlocksPerSecond: 9.5,
        etaSeconds: 531,
      }),
    );

    expect(presentation.shouldWarn).toBe(true);
    expect(presentation.label).toBe("Catching up");
    expect(presentation.headline).toBe("Scanner is 5050 blocks (2h 48m of chain history) behind the chain head");
    expect(presentation.detail).toContain("20.0x the chain's block rate");
    expect(presentation.detail).toContain("570 blocks/min");
    expect(presentation.detail).toContain("Estimated to be in sync in 8m 51s.");
  });

  test("warns without an ETA while falling behind", () => {
    const presentation = describeSync(
      syncStatus({
        state: "falling-behind",
        lagBlocks: "300",
        lagSeconds: 600,
        scanBlocksPerSecond: 0.25,
        speedupFactor: 0.5,
        netCatchUpBlocksPerSecond: -0.25,
        etaSeconds: null,
      }),
    );

    expect(presentation.tone).toBe("danger");
    expect(presentation.headline).toContain("losing ground");
    expect(presentation.detail).toContain("growing by 15.0 blocks/min");
    expect(presentation.detail).toContain("No sync estimate");
  });

  test("explains a stalled scanner", () => {
    const presentation = describeSync(
      syncStatus({ state: "stalled", lagBlocks: "300", lagSeconds: 600 }),
    );

    expect(presentation.tone).toBe("danger");
    expect(presentation.detail).toContain("No block has been stored for 10m 0s.");
  });

  test("says nothing useful is known yet without data", () => {
    expect(describeSync(null).shouldWarn).toBe(false);
    expect(describeSync(syncStatus({ state: "unknown", lagBlocks: null })).shouldWarn).toBe(false);
  });
});

describe("sync formatting helpers", () => {
  test("describes lag in blocks and chain time", () => {
    expect(describeLag(syncStatus({ lagBlocks: "1", lagSeconds: 0 }))).toBe("1 block");
    expect(describeLag(syncStatus({ lagBlocks: "120", lagSeconds: 240 }))).toBe(
      "120 blocks (4m 0s of chain history)",
    );
    expect(describeLag(syncStatus({ lagBlocks: null }))).toBe("an unknown amount");
  });

  test("describes throughput against the chain", () => {
    expect(describeThroughput(syncStatus({ scanBlocksPerSecond: 10 }))).toBe(
      "10.0 blocks/s scanned vs 0.50 blocks/s produced (2.00s block time).",
    );
    expect(describeThroughput(syncStatus({ scanBlocksPerSecond: null }))).toBeNull();
  });

  test("scales rate precision to the magnitude", () => {
    expect(fmtRate(0.5)).toBe("0.50");
    expect(fmtRate(12.34)).toBe("12.3");
    expect(fmtRate(1234)).toBe("1234");
    expect(fmtRate(null)).toBe("—");
  });
});
