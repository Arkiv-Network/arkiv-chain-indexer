import { describe, expect, test } from "bun:test";
import { computeBlockMetrics } from "./metrics";
import { IGNORED_TRANSACTION_FROM_ADDRESS } from "./transactionFilter";
import type { RpcBlock, RpcReceipt } from "./types";

describe("computeBlockMetrics", () => {
  test("computes fee and priority averages with bigint precision", () => {
    const block: RpcBlock = {
      number: "0x7b",
      timestamp: "0x65a0bb80",
      baseFeePerGas: "0x64",
      gasUsed: "0xa",
      gasLimit: "0x1c9c380",
      transactions: [
        { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", input: "0x123456" },
        { hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", input: "0x" },
      ],
    };
    const receipts: RpcReceipt[] = [
      {
        transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gasUsed: "0x2",
        effectiveGasPrice: "0xc8",
      },
      {
        transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        gasUsed: "0x8",
        effectiveGasPrice: "0x6e",
      },
    ];
    const previousBlock: RpcBlock = {
      ...block,
      number: "0x7a",
      timestamp: "0x65a0bb7e",
      transactions: [],
    };

    expect(computeBlockMetrics(block, receipts, previousBlock)).toEqual({
      blockHash: null,
      parentHash: null,
      blockDate: "2024-01-12T04:09:36.000Z",
      blockNumber: 123n,
      blockTimeSeconds: "2",
      baseBlockFeeWei: "100",
      totalGasUsed: "10",
      totalInputDataSizeBytes: "3",
      totalInputDataCompressedSizeBytes: "21",
      maxGasInBlock: "30000000",
      transactionCount: 2,
      blockRewardWei: "280",
      burntFeesWei: "1000",
      totalTransactionFeeWei: "1280",
      totalRentFeeWei: "0",
      totalBurnedWei: "1000",
      feePriceSumWei: "310",
      priorityFeeSumWei: "110",
      priorityFeeWeightedNumeratorWei: "48800",
      priorityFeeGasWeightedNumeratorWei: "280",
      averageFeePriceWei: "155",
      averageTransactionFeeWei: "640",
      averageTransactionGasUsed: "5",
      averageTransactionInputDataSizeBytes: "1",
      averageTransactionInputDataCompressedSizeBytes: "10",
      averagePriorityFeeWeightedWei: "28",
      averagePriorityFeeWei: "55",
    });
  });

  test("sums receipt rent apart from gas: the fee stays gas-only, burned is base-fee burn plus rent", () => {
    // Live UDC block 48: the permanent create paid 0.0118 GLM rent beside
    // 54,760 gas at a flat 1 gwei.
    const block: RpcBlock = {
      number: "0x30",
      timestamp: "0x6adfb434",
      baseFeePerGas: "0x3b9aca00",
      gasUsed: "0xd5e8",
      gasLimit: "0x5f5e100",
      transactions: [
        { hash: "0xaeb0ee8887ee4414ed8e95edaa2557721d25a864d9a0d2c2f1a49b2b59cae3be", input: "0x49650044" },
        { hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", input: "0x" },
      ],
    };
    const receipts: RpcReceipt[] = [
      {
        transactionHash: "0xaeb0ee8887ee4414ed8e95edaa2557721d25a864d9a0d2c2f1a49b2b59cae3be",
        gasUsed: "0xd5e8",
        effectiveGasPrice: "0x3b9aca00",
        rentFee: "0x29efc43364a800",
      },
      // A node without rent (or a failed transaction) reads as zero.
      {
        transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        gasUsed: "0x0",
        effectiveGasPrice: "0x3b9aca00",
      },
    ];

    const metrics = computeBlockMetrics(block, receipts);
    expect(metrics.totalTransactionFeeWei).toBe((54_760n * 1_000_000_000n).toString());
    expect(metrics.totalRentFeeWei).toBe(BigInt("0x29efc43364a800").toString());
    expect(metrics.burntFeesWei).toBe((54_760n * 1_000_000_000n).toString());
    expect(metrics.totalBurnedWei).toBe((54_760n * 1_000_000_000n + BigInt("0x29efc43364a800")).toString());
    expect(metrics.averageTransactionFeeWei).toBe(((54_760n * 1_000_000_000n) / 2n).toString());
  });

  test("burns the base fee on the receipts' gas, not on gas the block spends for itself", () => {
    // An Arkiv expiry sweep charges 19,500 gas per expired entity to the block
    // header; no transaction pays it.
    const block: RpcBlock = {
      number: "0x20",
      timestamp: "0x65a0bb80",
      baseFeePerGas: "0x3b9aca00",
      gasUsed: `0x${(21_000 + 2 * 19_500).toString(16)}`,
      gasLimit: "0x5f5e100",
      transactions: [{ hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
    };
    const metrics = computeBlockMetrics(block, [
      { transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" },
    ]);
    expect(metrics.totalGasUsed).toBe("60000");
    expect(metrics.burntFeesWei).toBe((21_000n * 1_000_000_000n).toString());
    expect(metrics.totalTransactionFeeWei).toBe((21_000n * 1_000_000_000n).toString());
    expect(metrics.totalBurnedWei).toBe((21_000n * 1_000_000_000n).toString());
    // An empty sweep-only block burns nothing.
    const sweepOnly = computeBlockMetrics({ ...block, transactions: [] }, []);
    expect(sweepOnly.burntFeesWei).toBe("0");
  });

  test("stores zero averages for empty blocks", () => {
    const block: RpcBlock = {
      number: "0x1",
      timestamp: "0x0",
      baseFeePerGas: "0x7",
      gasUsed: "0x0",
      gasLimit: "0x1",
      transactions: [],
    };

    expect(computeBlockMetrics(block, [])).toMatchObject({
      blockTimeSeconds: "2",
      transactionCount: 0,
      blockRewardWei: "0",
      burntFeesWei: "0",
      totalTransactionFeeWei: "0",
      totalRentFeeWei: "0",
      totalBurnedWei: "0",
      feePriceSumWei: "0",
      priorityFeeSumWei: "0",
      priorityFeeWeightedNumeratorWei: "0",
      priorityFeeGasWeightedNumeratorWei: "0",
      averageFeePriceWei: "0",
      averageTransactionFeeWei: "0",
      averageTransactionGasUsed: "0",
      averagePriorityFeeWeightedWei: "0",
      averagePriorityFeeWei: "0",
    });
  });

  test("ignores transactions from the configured dead sender address", () => {
    const block: RpcBlock = {
      number: "0x7b",
      timestamp: "0x65a0bb80",
      baseFeePerGas: "0x64",
      gasUsed: "0xf",
      gasLimit: "0x1c9c380",
      transactions: [
        {
          hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          from: "0x111",
        },
        {
          hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          from: IGNORED_TRANSACTION_FROM_ADDRESS,
        },
        {
          hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          from: "0x333",
        },
      ],
    };
    const receipts: RpcReceipt[] = [
      {
        transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gasUsed: "0x2",
        effectiveGasPrice: "0xc8",
      },
      {
        transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        gasUsed: "0x8",
        effectiveGasPrice: "0x6e",
      },
    ];

    expect(computeBlockMetrics(block, receipts, { ...block, number: "0x7a", timestamp: "0x65a0bb7f", transactions: [] })).toMatchObject({
      blockTimeSeconds: "1",
      transactionCount: 2,
      // The dead sender's gas is in the header but burns nobody's balance.
      burntFeesWei: "1000",
      totalTransactionFeeWei: "1280",
      feePriceSumWei: "310",
      priorityFeeSumWei: "110",
      priorityFeeWeightedNumeratorWei: "48800",
      priorityFeeGasWeightedNumeratorWei: "280",
      averageFeePriceWei: "155",
      averageTransactionFeeWei: "640",
      averageTransactionGasUsed: "5",
      averagePriorityFeeWeightedWei: "28",
      averagePriorityFeeWei: "55",
    });
  });
});

describe("computeBlockMetrics header hashes", () => {
  test("keeps the block and parent hashes lowercased when the header carries them", () => {
    const metrics = computeBlockMetrics(
      {
        number: "0x1",
        hash: `0x${"AB".repeat(32)}`,
        parentHash: `0x${"CD".repeat(32)}`,
        timestamp: "0x1",
        gasUsed: "0x0",
        gasLimit: "0x1",
        transactions: [],
      },
      [],
    );
    expect(metrics.blockHash).toBe(`0x${"ab".repeat(32)}`);
    expect(metrics.parentHash).toBe(`0x${"cd".repeat(32)}`);
  });
});
