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

    expect(computeBlockMetrics(block, receipts)).toEqual({
      blockDate: "2024-01-12T04:09:36.000Z",
      blockNumber: 123n,
      baseBlockFeeWei: "100",
      totalGasUsed: "10",
      totalInputDataSizeBytes: "3",
      totalInputDataCompressedSizeBytes: "21",
      maxGasInBlock: "30000000",
      transactionCount: 2,
      blockRewardWei: "280",
      burntFeesWei: "1000",
      totalTransactionFeeWei: "1280",
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
      transactionCount: 0,
      blockRewardWei: "0",
      burntFeesWei: "0",
      totalTransactionFeeWei: "0",
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

    expect(computeBlockMetrics(block, receipts)).toMatchObject({
      transactionCount: 2,
      burntFeesWei: "1500",
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

  test("stores input data totals and averages as decoded byte counts", () => {
    const block: RpcBlock = {
      number: "0x7c",
      timestamp: "0x65a0bb80",
      baseFeePerGas: "0x1",
      gasUsed: "0x3",
      gasLimit: "0x1c9c380",
      transactions: [
        {
          hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          input: `0x${"00".repeat(32)}`,
        },
        {
          hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          input: "0x12345678",
        },
        {
          hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          input: "0x",
        },
      ],
    };
    const receipts: RpcReceipt[] = [
      {
        transactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        gasUsed: "0x1",
        effectiveGasPrice: "0x1",
      },
      {
        transactionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        gasUsed: "0x1",
        effectiveGasPrice: "0x1",
      },
      {
        transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        gasUsed: "0x1",
        effectiveGasPrice: "0x1",
      },
    ];

    expect(computeBlockMetrics(block, receipts)).toMatchObject({
      totalInputDataSizeBytes: "36",
      averageTransactionInputDataSizeBytes: "12",
    });
  });
});
