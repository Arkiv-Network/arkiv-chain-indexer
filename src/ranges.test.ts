import { describe, expect, test } from "bun:test";
import {
  SUPPORTED_RANGE_SIZES,
  assertSupportedRangeSize,
  computeBlockRange,
  isSupportedRangeSize,
  parseRangeSize,
  rangeEndFor,
  rangeStartFor,
} from "./ranges";
import type { StoredBlock } from "./storage";

describe("SUPPORTED_RANGE_SIZES", () => {
  test("matches the documented set", () => {
    expect([...SUPPORTED_RANGE_SIZES]).toEqual([
      2n,
      5n,
      10n,
      20n,
      50n,
      100n,
      150n,
      200n,
      300n,
      500n,
      1000n,
    ]);
  });

  test("isSupportedRangeSize / assertSupportedRangeSize", () => {
    expect(isSupportedRangeSize(100n)).toBe(true);
    expect(isSupportedRangeSize(7n)).toBe(false);
    expect(() => assertSupportedRangeSize(50n)).not.toThrow();
    expect(() => assertSupportedRangeSize(7n)).toThrow();
  });

  test("parseRangeSize", () => {
    expect(parseRangeSize("50")).toBe(50n);
    expect(() => parseRangeSize("abc")).toThrow();
    expect(() => parseRangeSize("7")).toThrow();
    expect(() => parseRangeSize("-2")).toThrow();
  });
});

describe("rangeStartFor", () => {
  test("snaps down to the nearest multiple of rangeSize", () => {
    expect(rangeStartFor(245_600n, 100n)).toBe(245_600n);
    expect(rangeStartFor(245_650n, 100n)).toBe(245_600n);
    expect(rangeStartFor(245_699n, 100n)).toBe(245_600n);
    expect(rangeStartFor(245_700n, 100n)).toBe(245_700n);
    expect(rangeStartFor(0n, 100n)).toBe(0n);
    expect(rangeStartFor(53n, 50n)).toBe(50n);
    expect(rangeStartFor(7n, 2n)).toBe(6n);
    expect(rangeStartFor(2_345n, 1000n)).toBe(2000n);
  });

  test("rejects negative input", () => {
    expect(() => rangeStartFor(-1n, 100n)).toThrow();
  });

  test("rejects unsupported range sizes", () => {
    expect(() => rangeStartFor(0n, 7n)).toThrow();
  });
});

describe("rangeEndFor", () => {
  test("returns rangeStart + rangeSize - 1", () => {
    expect(rangeEndFor(245_600n, 100n)).toBe(245_699n);
    expect(rangeEndFor(0n, 100n)).toBe(99n);
    expect(rangeEndFor(50n, 50n)).toBe(99n);
    expect(rangeEndFor(2000n, 1000n)).toBe(2999n);
  });
});

describe("computeBlockRange", () => {
  test("aggregates min/max/avg/sum metrics with bigint precision (size 100)", () => {
    const rangeSize = 100n;
    const blocks = makeBlocks(245_600n, rangeSize, (offset) => ({
      blockDate: new Date(Date.UTC(2024, 0, 1, 0, Number(offset))).toISOString(),
      baseBlockFeeWei: (100n + offset).toString(),
      totalGasUsed: (1_000n + offset).toString(),
      maxGasInBlock: (30_000_000n + offset * 1_000n).toString(),
      transactionCount: 2,
      blockRewardWei: ((5n + offset) * (1_000n + offset)).toString(),
      burntFeesWei: ((100n + offset) * (1_000n + offset)).toString(),
      totalTransactionFeeWei: (2_000n + offset).toString(),
      feePriceSumWei: ((100n + offset) * 2n).toString(),
      priorityFeeSumWei: ((3n + offset) * 2n).toString(),
      priorityFeeWeightedNumeratorWei: ((5n + offset) * (2_000n + offset)).toString(),
      priorityFeeGasWeightedNumeratorWei: ((5n + offset) * (1_000n + offset)).toString(),
      averageFeePriceWei: (100n + offset).toString(),
      averageTransactionFeeWei: ((2_000n + offset) / 2n).toString(),
      averageTransactionGasUsed: ((1_000n + offset) / 2n).toString(),
      averagePriorityFeeWeightedWei: (5n + offset).toString(),
      averagePriorityFeeWei: (3n + offset).toString(),
    }));

    const range = computeBlockRange(245_600n, rangeSize, blocks);

    expect(range.rangeSize).toBe(100n);
    expect(range.rangeStart).toBe(245_600n);
    expect(range.rangeEnd).toBe(245_699n);
    expect(range.minBlockDate).toBe(blocks[0]!.blockDate);
    expect(range.maxBlockDate).toBe(blocks[99]!.blockDate);
    expect(range.minBaseFeeWei).toBe("100");
    expect(range.maxBaseFeeWei).toBe("199");

    let baseFeeSum = 0n;
    let totalGas = 0n;
    let totalMaxGas = 0n;
    let totalBlockReward = 0n;
    let totalBurntFees = 0n;
    let gasWeightedNumerator = 0n;
    let feePriceNumerator = 0n;
    let transactionGasNumerator = 0n;
    let txWeightedNumerator = 0n;
    let totalTransactions = 0n;
    for (let offset = 0n; offset < 100n; offset += 1n) {
      const baseFee = 100n + offset;
      const gas = 1_000n + offset;
      const maxGas = 30_000_000n + offset * 1_000n;
      const gwPriority = 5n + offset;
      const feePrice = 100n + offset;
      const txPriority = 3n + offset;
      baseFeeSum += baseFee;
      totalGas += gas;
      totalMaxGas += maxGas;
      totalBlockReward += gwPriority * gas;
      totalBurntFees += baseFee * gas;
      gasWeightedNumerator += gwPriority * gas;
      feePriceNumerator += feePrice * 2n;
      transactionGasNumerator += gas;
      txWeightedNumerator += txPriority * 2n;
      totalTransactions += 2n;
    }

    expect(range.averageBaseFeeWei).toBe((baseFeeSum / rangeSize).toString());
    expect(range.totalGasUsed).toBe(totalGas.toString());
    expect(range.totalMaxGas).toBe(totalMaxGas.toString());
    expect(range.minMaxGasInBlock).toBe("30000000");
    expect(range.maxMaxGasInBlock).toBe("30099000");
    expect(range.transactionCount).toBe(200);
    expect(range.totalBlockRewardWei).toBe(totalBlockReward.toString());
    expect(range.totalBurntFeesWei).toBe(totalBurntFees.toString());
    expect(range.averageBlockRewardWei).toBe((totalBlockReward / rangeSize).toString());
    expect(range.averageBurntFeesWei).toBe((totalBurntFees / rangeSize).toString());
    expect(range.averagePriorityFeeWeightedWei).toBe(
      (gasWeightedNumerator / totalGas).toString(),
    );
    expect(range.averageFeePriceWei).toBe(
      (feePriceNumerator / totalTransactions).toString(),
    );
    expect(range.averageTransactionGasUsed).toBe(
      (transactionGasNumerator / totalTransactions).toString(),
    );
    expect(range.averagePriorityFeeWei).toBe(
      (txWeightedNumerator / totalTransactions).toString(),
    );
  });

  test("aggregates correctly for a non-100 size (50)", () => {
    const rangeSize = 50n;
    const blocks = makeBlocks(2_050n, rangeSize, (offset) => ({
      baseBlockFeeWei: (200n + offset).toString(),
      totalGasUsed: "1000",
      maxGasInBlock: "30000000",
      transactionCount: 1,
      blockRewardWei: "10000",
      burntFeesWei: ((200n + offset) * 1000n).toString(),
      totalTransactionFeeWei: "2000",
      feePriceSumWei: "20",
      priorityFeeSumWei: "8",
      priorityFeeWeightedNumeratorWei: "20000",
      priorityFeeGasWeightedNumeratorWei: "10000",
      averageFeePriceWei: "20",
      averagePriorityFeeWeightedWei: "10",
      averageTransactionGasUsed: "1000",
      averagePriorityFeeWei: "8",
    }));
    const range = computeBlockRange(2_050n, rangeSize, blocks);
    expect(range.rangeSize).toBe(50n);
    expect(range.rangeStart).toBe(2_050n);
    expect(range.rangeEnd).toBe(2_099n);
    expect(range.transactionCount).toBe(50);
    expect(range.totalGasUsed).toBe((1000n * 50n).toString());
    expect(range.minBaseFeeWei).toBe("200");
    expect(range.maxBaseFeeWei).toBe((200n + 49n).toString());
  });

  test("weights range priority averages by gas used, not transaction fee size", () => {
    const blocks = makeBlocks(0n, 2n, (offset) =>
      offset === 0n
        ? {
            totalGasUsed: "1",
            transactionCount: 1,
            totalTransactionFeeWei: "1000",
            feePriceSumWei: "1000",
            priorityFeeSumWei: "100",
            priorityFeeWeightedNumeratorWei: "100000",
            priorityFeeGasWeightedNumeratorWei: "100",
            averageFeePriceWei: "1000",
            averageTransactionFeeWei: "1000",
            averageTransactionGasUsed: "1",
            averagePriorityFeeWeightedWei: "100",
            averagePriorityFeeWei: "100",
          }
        : {
            totalGasUsed: "1000",
            transactionCount: 1,
            totalTransactionFeeWei: "1000",
            feePriceSumWei: "1",
            priorityFeeSumWei: "1",
            priorityFeeWeightedNumeratorWei: "1000",
            priorityFeeGasWeightedNumeratorWei: "1000",
            averageFeePriceWei: "1",
            averageTransactionFeeWei: "1000",
            averageTransactionGasUsed: "1000",
            averagePriorityFeeWeightedWei: "1",
            averagePriorityFeeWei: "1",
          },
    );

    const range = computeBlockRange(0n, 2n, blocks);

    expect(range.averagePriorityFeeWeightedWei).toBe("1");
  });

  test("falls back to reconstructed gas weights for legacy block rows", () => {
    const blocks = makeBlocks(0n, 2n, (offset) =>
      offset === 0n
        ? {
            totalGasUsed: "1",
            transactionCount: 1,
            averageFeePriceWei: "1000",
            averageTransactionFeeWei: "1000",
            averageTransactionGasUsed: "1",
            averagePriorityFeeWeightedWei: "100",
            averagePriorityFeeWei: "100",
          }
        : {
            totalGasUsed: "1000",
            transactionCount: 1,
            averageFeePriceWei: "1",
            averageTransactionFeeWei: "1000",
            averageTransactionGasUsed: "1000",
            averagePriorityFeeWeightedWei: "1",
            averagePriorityFeeWei: "1",
          },
    );

    const range = computeBlockRange(0n, 2n, blocks);

    expect(range.averagePriorityFeeWeightedWei).toBe("1");
  });

  test("uses zero averages when the range has zero gas and zero transactions", () => {
    const blocks = makeBlocks(245_600n, 100n, () => ({
      baseBlockFeeWei: "100",
      totalGasUsed: "0",
      maxGasInBlock: "30000000",
      transactionCount: 0,
      averageFeePriceWei: "0",
      averageTransactionFeeWei: "0",
      averageTransactionGasUsed: "0",
      averagePriorityFeeWeightedWei: "0",
      averagePriorityFeeWei: "0",
    }));

    const range = computeBlockRange(245_600n, 100n, blocks);
    expect(range.averagePriorityFeeWeightedWei).toBe("0");
    expect(range.averageFeePriceWei).toBe("0");
    expect(range.averageTransactionGasUsed).toBe("0");
    expect(range.averagePriorityFeeWei).toBe("0");
    expect(range.totalGasUsed).toBe("0");
    expect(range.transactionCount).toBe(0);
  });

  test("aggregates nullable batcher metrics from available blocks", () => {
    const blocks = makeBlocks(0n, 2n, (offset) =>
      offset === 0n
        ? {
            batcherQueueSize: "10",
            batcherIntensity: "2",
            batcherLowerThreshold: "100",
            batcherUpperThreshold: "500",
            batcherMaxBlockSize: "1000",
            batcherMaxTxSize: "50",
          }
        : {
            batcherQueueSize: "30",
            batcherIntensity: "4",
            batcherLowerThreshold: "200",
            batcherUpperThreshold: "700",
            batcherMaxBlockSize: "3000",
            batcherMaxTxSize: "150",
          },
    );

    const range = computeBlockRange(0n, 2n, blocks);

    expect(range.minBatcherQueueSize).toBe("10");
    expect(range.maxBatcherQueueSize).toBe("30");
    expect(range.averageBatcherQueueSize).toBe("20");
    expect(range.averageBatcherIntensity).toBe("3");
    expect(range.averageBatcherLowerThreshold).toBe("150");
    expect(range.averageBatcherUpperThreshold).toBe("600");
    expect(range.averageBatcherMaxBlockSize).toBe("2000");
    expect(range.averageBatcherMaxTxSize).toBe("100");
  });

  test("averages fractional batcher intensity without throwing on decimals", () => {
    const blocks = makeBlocks(0n, 2n, (offset) =>
      offset === 0n
        ? { batcherIntensity: "0.000002848359418402778" }
        : { batcherIntensity: "0.000001151640581597222" },
    );

    const range = computeBlockRange(0n, 2n, blocks);

    expect(range.averageBatcherIntensity).toBe("0.000002");
  });

  test("uses null batcher range values when no block has collector data", () => {
    const blocks = makeBlocks(0n, 2n, () => ({}));

    const range = computeBlockRange(0n, 2n, blocks);

    expect(range.minBatcherQueueSize).toBeNull();
    expect(range.maxBatcherQueueSize).toBeNull();
    expect(range.averageBatcherQueueSize).toBeNull();
    expect(range.averageBatcherIntensity).toBeNull();
  });

  test("rejects ranges that are not aligned to rangeSize", () => {
    const blocks = makeBlocks(245_650n, 100n, () => ({}));
    expect(() => computeBlockRange(245_650n, 100n, blocks)).toThrow();
  });

  test("rejects ranges with the wrong block count", () => {
    const blocks = makeBlocks(245_600n, 100n, () => ({})).slice(0, 99);
    expect(() => computeBlockRange(245_600n, 100n, blocks)).toThrow();
  });

  test("rejects ranges missing a block in the window", () => {
    const blocks = makeBlocks(245_600n, 100n, () => ({}));
    blocks[42] = { ...blocks[42]!, blockNumber: 999_999 };
    expect(() => computeBlockRange(245_600n, 100n, blocks)).toThrow(/missing blocks/);
  });

  test("rejects unsupported range sizes", () => {
    const blocks = makeBlocks(0n, 100n, () => ({}));
    expect(() => computeBlockRange(0n, 7n, blocks)).toThrow();
  });
});

function makeBlocks(
  rangeStart: bigint,
  rangeSize: bigint,
  override: (offset: bigint) => Partial<StoredBlock>,
): StoredBlock[] {
  const blocks: StoredBlock[] = [];
  for (let offset = 0n; offset < rangeSize; offset += 1n) {
    const base: StoredBlock = {
      blockNumber: Number(rangeStart + offset),
      blockDate: "2024-01-01T00:00:00.000Z",
      baseBlockFeeWei: "100",
      totalGasUsed: "0",
      maxGasInBlock: "30000000",
      transactionCount: 0,
      averageFeePriceWei: "0",
      averageTransactionFeeWei: "0",
      averageTransactionGasUsed: "0",
      averagePriorityFeeWeightedWei: "0",
      averagePriorityFeeWei: "0",
    };
    blocks.push({ ...base, ...override(offset) });
  }
  return blocks;
}
