import { describe, expect, test } from "bun:test";
import {
  collectorSecond,
  isBatcherCollectionEligible,
  parseBatcherCollectorResponse,
} from "./batcher";

describe("batcher collector helpers", () => {
  test("formats block timestamps as collector seconds", () => {
    expect(collectorSecond("2026-05-22T15:17:01.789Z")).toBe("2026-05-22T15:17:01Z");
  });

  test("only allows collection for blocks between two seconds and one hour old", () => {
    const now = new Date("2026-05-22T16:00:00.000Z");

    expect(isBatcherCollectionEligible("2026-05-22T15:59:58.500Z", now)).toBe(false);
    expect(isBatcherCollectionEligible("2026-05-22T15:59:57.999Z", now)).toBe(true);
    expect(isBatcherCollectionEligible("2026-05-22T15:00:00.000Z", now)).toBe(true);
    expect(isBatcherCollectionEligible("2026-05-22T14:59:59.999Z", now)).toBe(false);
  });

  test("parses successful collector payloads into optional block metrics", () => {
    expect(
      parseBatcherCollectorResponse({
        ok: true,
        entry: {
          ok: true,
          result: {
            current_load: 906,
            intensity: 0,
            lower_threshold: 10_000_000,
            upper_threshold: 50_000_000,
            max_block_size: 10_000_000,
            max_tx_size: 0,
          },
        },
      }),
    ).toEqual({
      batcherQueueSize: "906",
      batcherIntensity: "0",
      batcherLowerThreshold: "10000000",
      batcherUpperThreshold: "50000000",
      batcherMaxBlockSize: "10000000",
      batcherMaxTxSize: "0",
    });
  });

  test("ignores unsuccessful collector payloads", () => {
    expect(parseBatcherCollectorResponse({ ok: false })).toBeUndefined();
    expect(parseBatcherCollectorResponse({ ok: true, entry: { ok: false } })).toBeUndefined();
  });
});
