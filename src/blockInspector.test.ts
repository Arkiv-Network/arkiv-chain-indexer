import { describe, expect, test } from "bun:test";
import { inspectBlockFromRpc } from "./blockInspector";
import type { RpcBlock, RpcReceipt } from "./types";

describe("inspectBlockFromRpc", () => {
  test("computes transaction inspection fields from block and receipts", () => {
    const block = blockFixture();
    const receipts = receiptsFixture();

    const inspected = inspectBlockFromRpc(block, receipts);

    expect(inspected).toMatchObject({
      blockNumber: 42,
      blockNumberDecimal: "42",
      baseBlockFeeWei: "100",
      totalGasUsed: "12",
      maxGasInBlock: "48",
      transactionCount: 2,
    });
    expect(inspected.transactions[0]).toMatchObject({
      position: 0,
      hash: "0xaaa",
      gasUsed: "10",
      effectiveGasPriceWei: "150",
      priorityFeeWei: "50",
      transactionFeeWei: "1500",
      maxPriorityFeePerGasWei: "60",
      status: "1",
    });
    expect(inspected.transactions[1]).toMatchObject({
      position: 1,
      hash: "0xbbb",
      gasUsed: "2",
      effectiveGasPriceWei: "80",
      priorityFeeWei: "0",
      transactionFeeWei: "160",
      status: "0",
    });
  });

  test("requires one receipt per transaction", () => {
    expect(() => inspectBlockFromRpc(blockFixture(), receiptsFixture().slice(0, 1))).toThrow(
      /Receipt count/,
    );
  });
});

function blockFixture(): RpcBlock {
  return {
    number: "0x2a",
    timestamp: "0x65a3bd17",
    baseFeePerGas: "0x64",
    gasUsed: "0xc",
    gasLimit: "0x30",
    transactions: [
      {
        hash: "0xaaa",
        from: "0x111",
        to: "0x222",
        type: "0x2",
        nonce: "0x1",
        value: "0x5",
        gas: "0x5208",
        gasPrice: "0x96",
        maxFeePerGas: "0xc8",
        maxPriorityFeePerGas: "0x3c",
      },
      {
        hash: "0xbbb",
        from: "0x333",
        to: null,
        type: "0x0",
        nonce: "0x2",
        value: "0x0",
        gas: "0x7530",
        gasPrice: "0x50",
      },
    ],
  };
}

function receiptsFixture(): RpcReceipt[] {
  return [
    {
      transactionHash: "0xaaa",
      gasUsed: "0xa",
      cumulativeGasUsed: "0xa",
      effectiveGasPrice: "0x96",
      status: "0x1",
    },
    {
      transactionHash: "0xbbb",
      gasUsed: "0x2",
      cumulativeGasUsed: "0xc",
      effectiveGasPrice: "0x50",
      status: "0x0",
      contractAddress: "0x444",
    },
  ];
}
