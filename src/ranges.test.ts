import { describe, expect, test } from "bun:test";
import { RANGE_SIZE, computeBlockRange, rangeEndFor, rangeStartFor } from "./ranges";
import type { StoredBlock } from "./storage";

describe("rangeStartFor", () => {
  test("snaps down to the nearest multiple of RANGE_SIZE", () => {
    expect(rangeStartFor(245_600n)).toBe(245_600n);
    expect(rangeStartFor(245_650n)).toBe(245_600n);
    expect(rangeStartFor(245_699n)).toBe(245_600n);
    expect(rangeStartFor(245_700n)).toBe(245_700n);
    expect(rangeStartFor(0n)).toBe(0n);
  });

  test("rejects negative input", () => {
    expect(() => rangeStartFor(-1n)).toThrow();
  });
});

describe("rangeEndFor", () => {
  test("returns rangeStart + 99", () => {
    expect(rangeEndFor(245_600n)).toBe(245_699n);
    expect(rangeEndFor(0n)).toBe(99n);
  });
});

describe("computeBlockRange", () => {
  test("aggregates min/max/avg/sum metrics with bigint precision", () => {
    const blocks = makeBlocks(245_600n, (offset) => ({
      blockDate: new Date(Date.UTC(2024, 0, 1, 0, Number(offset))).toISOString(),
      baseBlockFeeWei: (100n + offset).toString(),
      totalGasUsed: (1_000n + offset).toString(),
      maxGasInBlock: "30000000",
      transactionCount: 2,
      averageTransactionFeeWei: "0",
      averagePriorityFeeWeightedWei: (5n + offset).toString(),
      averagePriorityFeeWei: (3n + offset).toString(),
    }));

    const range = computeBlockRange(245_600n, blocks);

    expect(range.rangeStart).toBe(245_600n);
    expect(range.rangeEnd).toBe(245_699n);
    expect(range.minBlockDate).toBe(blocks[0]!.blockDate);
    expect(range.maxBlockDate).toBe(blocks[99]!.blockDate);
    expect(range.minBaseFeeWei).toBe("100");
    expect(range.maxBaseFeeWei).toBe("199");

    let baseFeeSum = 0n;
    let totalGas = 0n;
    let gasWeightedNumerator = 0n;
    let txWeightedNumerator = 0n;
    let totalTransactions = 0n;
    for (let offset = 0n; offset < 100n; offset += 1n) {
      const baseFee = 100n + offset;
      const gas = 1_000n + offset;
      const gwPriority = 5n + offset;
      const txPriority = 3n + offset;
      baseFeeSum += baseFee;
      totalGas += gas;
      gasWeightedNumerator += gwPriority * gas;
      txWeightedNumerator += txPriority * 2n;
      totalTransactions += 2n;
    }

    expect(range.averageBaseFeeWei).toBe((baseFeeSum / RANGE_SIZE).toString());
    expect(range.totalGasUsed).toBe(totalGas.toString());
    expect(range.totalMaxGas).toBe((30_000_000n * RANGE_SIZE).toString());
    expect(range.transactionCount).toBe(200);
    expect(range.averagePriorityFeeWeightedWei).toBe(
      (gasWeightedNumerator / totalGas).toString(),
    );
    expect(range.averagePriorityFeeWei).toBe(
      (txWeightedNumerator / totalTransactions).toString(),
    );
  });

  test("uses zero averages when the range has zero gas and zero transactions", () => {
    const blocks = makeBlocks(245_600n, () => ({
      baseBlockFeeWei: "100",
      totalGasUsed: "0",
      maxGasInBlock: "30000000",
      transactionCount: 0,
      averageTransactionFeeWei: "0",
      averagePriorityFeeWeightedWei: "0",
      averagePriorityFeeWei: "0",
    }));

    const range = computeBlockRange(245_600n, blocks);
    expect(range.averagePriorityFeeWeightedWei).toBe("0");
    expect(range.averagePriorityFeeWei).toBe("0");
    expect(range.totalGasUsed).toBe("0");
    expect(range.transactionCount).toBe(0);
  });

  test("rejects ranges that are not aligned to RANGE_SIZE", () => {
    const blocks = makeBlocks(245_650n, () => ({}));
    expect(() => computeBlockRange(245_650n, blocks)).toThrow();
  });

  test("rejects ranges with the wrong block count", () => {
    const blocks = makeBlocks(245_600n, () => ({})).slice(0, 99);
    expect(() => computeBlockRange(245_600n, blocks)).toThrow();
  });

  test("rejects ranges missing a block in the window", () => {
    const blocks = makeBlocks(245_600n, () => ({}));
    blocks[42] = { ...blocks[42]!, blockNumber: 999_999 };
    expect(() => computeBlockRange(245_600n, blocks)).toThrow(/missing blocks/);
  });
});

function makeBlocks(
  rangeStart: bigint,
  override: (offset: bigint) => Partial<StoredBlock>,
): StoredBlock[] {
  const blocks: StoredBlock[] = [];
  for (let offset = 0n; offset < RANGE_SIZE; offset += 1n) {
    const base: StoredBlock = {
      blockNumber: Number(rangeStart + offset),
      blockDate: "2024-01-01T00:00:00.000Z",
      baseBlockFeeWei: "100",
      totalGasUsed: "0",
      maxGasInBlock: "30000000",
      transactionCount: 0,
      averageTransactionFeeWei: "0",
      averagePriorityFeeWeightedWei: "0",
      averagePriorityFeeWei: "0",
    };
    blocks.push({ ...base, ...override(offset) });
  }
  return blocks;
}
