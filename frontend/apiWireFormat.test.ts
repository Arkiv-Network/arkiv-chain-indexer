// The list endpoints send compact rows: a `names` array once, then per-row
// value arrays. These tests pin the two halves of that contract together:
// the frontend's fallback name order must match the server's, and a row
// encoded by the server must decode back to the identical object through the
// public fetch helpers.
import { afterEach, describe, expect, test } from "bun:test";
import {
  BLOCK_RESPONSE_NAMES as SERVER_BLOCK_NAMES,
  ENTITY_OPERATION_RESPONSE_NAMES as SERVER_ENTITY_OPERATION_NAMES,
  GUZZLER_HISTORY_POINT_RESPONSE_NAMES as SERVER_GUZZLER_HISTORY_POINT_NAMES,
  GUZZLER_STAT_RESPONSE_NAMES as SERVER_GUZZLER_STAT_NAMES,
  RANGE_RESPONSE_NAMES as SERVER_RANGE_NAMES,
  SENDER_STATS_RESPONSE_NAMES as SERVER_SENDER_STATS_NAMES,
  TRANSACTION_RECORD_RESPONSE_NAMES as SERVER_TRANSACTION_RECORD_NAMES,
  TRANSACTION_RESPONSE_NAMES as SERVER_TRANSACTION_NAMES,
  entityOperationToResponseRow,
  senderStatsToResponseRow,
  transactionRecordToResponseRow,
  transactionToResponseRow,
} from "../src/server";
import type {
  StoredEntityOperation as ServerStoredEntityOperation,
  StoredSenderStats as ServerStoredSenderStats,
  StoredTransaction as ServerStoredTransaction,
  StoredTransactionRecord as ServerStoredTransactionRecord,
} from "../src/storage";
import {
  BLOCK_RESPONSE_NAMES,
  ENTITY_OPERATION_RESPONSE_NAMES,
  GUZZLER_HISTORY_POINT_RESPONSE_NAMES,
  GUZZLER_STAT_RESPONSE_NAMES,
  RANGE_RESPONSE_NAMES,
  SENDER_STATS_RESPONSE_NAMES,
  TRANSACTION_RECORD_RESPONSE_NAMES,
  TRANSACTION_RESPONSE_NAMES,
  fetchEntityByKey,
  fetchSenders,
  fetchTransactionRecords,
  fetchTransactions,
} from "./src/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockJson(body: unknown): void {
  globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
}

function serverTransactionFixture(): ServerStoredTransaction {
  return {
    blockNumber: 42,
    blockNumberDecimal: "42",
    blockDate: "2024-01-01T00:00:00.000Z",
    baseBlockFeeWei: "100",
    position: 0,
    hash: `0x${"ab".repeat(32)}`,
    from: "0x111",
    to: "0x222",
    type: "2",
    nonce: "1",
    valueWei: "0",
    gasLimit: "21000",
    gasUsed: "21000",
    inputDataSizeBytes: "0",
    inputDataCompressedSizeBytes: "0",
    cumulativeGasUsed: "21000",
    gasPriceWei: "110",
    maxFeePerGasWei: "200",
    maxPriorityFeePerGasWei: "10",
    effectiveGasPriceWei: "110",
    priorityFeeWei: "10",
    transactionFeeWei: "2310000",
    status: "1",
    contractAddress: null,
  };
}

function serverEntityOperationFixture(): ServerStoredEntityOperation {
  return {
    blockNumber: 42,
    blockNumberDecimal: "42",
    blockDate: "2026-01-01T00:00:00.000Z",
    position: 3,
    hash: `0x${"cd".repeat(32)}`,
    opIndex: 1,
    operationType: 1,
    operation: "create",
    entityKey: `0x${"11".repeat(32)}`,
    contentType: "application/vnd.atlas.payload-reference+json",
    payloadSizeBytes: 64,
    attributes: [{ key: "project", valueType: 2, valueTypeName: "string", value: "demo" }],
    expiresAtBlocks: 100,
    newOwner: null,
    isReference: true,
    payloadReference: {
      kind: "atlas.payloadReference",
      version: 1,
      provider: "atlas-payload-provider",
      id: "a".repeat(64),
      namespace: "atlas.test",
      checksum: `sha256:${"b".repeat(64)}`,
      sizeBytes: 64,
      submittedAt: "2026-06-24T15:24:30Z",
      nonce: `0x${"00".repeat(31)}01`,
      payment: 1000,
      signature: {
        scheme: "eip191",
        signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
        receipt: {},
        messageHash: `0x${"cd".repeat(32)}`,
        signature: `0x${"ef".repeat(65)}`,
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        v: 27,
      },
    },
    referenceVerification: {
      valid: true,
      signerTrusted: true,
      chainId: 42069,
      claimedSigner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      recoveredSigner: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      messageHash: `0x${"cd".repeat(32)}`,
      errors: [],
    },
    referenceError: null,
  };
}

describe("compact row wire format", () => {
  test("frontend fallback name orders match the server's", () => {
    expect(BLOCK_RESPONSE_NAMES).toEqual(SERVER_BLOCK_NAMES);
    expect(RANGE_RESPONSE_NAMES).toEqual(SERVER_RANGE_NAMES);
    expect(GUZZLER_STAT_RESPONSE_NAMES).toEqual(SERVER_GUZZLER_STAT_NAMES);
    expect(GUZZLER_HISTORY_POINT_RESPONSE_NAMES).toEqual(SERVER_GUZZLER_HISTORY_POINT_NAMES);
    expect(TRANSACTION_RESPONSE_NAMES).toEqual(SERVER_TRANSACTION_NAMES);
    expect(TRANSACTION_RECORD_RESPONSE_NAMES).toEqual(SERVER_TRANSACTION_RECORD_NAMES);
    expect(SENDER_STATS_RESPONSE_NAMES).toEqual(SERVER_SENDER_STATS_NAMES);
    expect(ENTITY_OPERATION_RESPONSE_NAMES).toEqual(SERVER_ENTITY_OPERATION_NAMES);
  });

  test("transaction rows round-trip, with and without operationsSummary", async () => {
    const plain = serverTransactionFixture();
    const withSummary: ServerStoredTransaction = {
      ...serverTransactionFixture(),
      position: 1,
      operationsSummary: [{ operation: "create", operationType: 1, count: 2 }],
    };
    mockJson({
      count: 2,
      limit: 1000,
      truncated: false,
      page: 1,
      pageSize: 1000,
      totalCount: 2,
      totalPages: 1,
      hasPreviousPage: false,
      hasNextPage: false,
      filters: {
        block: null,
        blockGt: null,
        blockLt: null,
        address: null,
        nonceGt: null,
        nonceLt: null,
        dateGt: null,
        dateLt: null,
      },
      names: SERVER_TRANSACTION_NAMES,
      transactions: [transactionToResponseRow(plain), transactionToResponseRow(withSummary)],
    });

    const response = await fetchTransactions(new URLSearchParams());

    expect(response.count).toBe(2);
    expect(response.transactions[0]).toEqual(plain);
    expect(response.transactions[0]?.operationsSummary).toBeUndefined();
    expect(response.transactions[1]).toEqual(withSummary);
  });

  test("transaction record rows round-trip", async () => {
    const record: ServerStoredTransactionRecord = {
      ...serverTransactionFixture(),
      category: "gas_used",
      recordValue: "21000",
      rank: 1,
      recordedAt: "2024-01-01T00:00:01.000Z",
    };
    mockJson({
      limit: 20,
      names: SERVER_TRANSACTION_RECORD_NAMES,
      records: {
        gas_used: [transactionRecordToResponseRow(record)],
        transaction_fee: [],
        effective_fee: [],
      },
    });

    const response = await fetchTransactionRecords(new URLSearchParams());

    expect(response.records.gas_used[0]).toEqual(record);
    expect(response.records.transaction_fee).toEqual([]);
  });

  test("sender rows round-trip, including null latestNonce", async () => {
    const sender: ServerStoredSenderStats = {
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      latestNonce: null,
      transactionCount: "2",
      totalGasUsed: "63000",
      totalTransactionFeeWei: "6930000",
      totalValueWei: "3000",
      averageGasUsed: "31500",
      averageTransactionFeeWei: "3465000",
      firstBlockNumber: 100,
      firstBlockNumberDecimal: "100",
      lastBlockNumber: 101,
      lastBlockNumberDecimal: "101",
      firstBlockDate: "2024-01-01T00:00:00.000Z",
      lastBlockDate: "2024-01-02T00:00:00.000Z",
      aggregatedAt: "2024-01-02T00:00:01.000Z",
    };
    mockJson({
      count: 1,
      limit: 25,
      truncated: false,
      filters: { order: "desc" },
      names: SERVER_SENDER_STATS_NAMES,
      senders: [senderStatsToResponseRow(sender)],
    });

    const response = await fetchSenders(new URLSearchParams());

    expect(response.senders[0]).toEqual(sender);
  });

  test("entity operation rows round-trip, keeping nested reference values", async () => {
    const reference = serverEntityOperationFixture();
    const minimal: ServerStoredEntityOperation = {
      ...serverEntityOperationFixture(),
      blockNumber: 43,
      blockNumberDecimal: "43",
      operationType: 5,
      operation: "delete",
      contentType: null,
      payloadSizeBytes: 0,
      attributes: [],
      expiresAtBlocks: 0,
      isReference: false,
      payloadReference: null,
      referenceVerification: null,
      referenceError: null,
    };
    mockJson({
      entityKey: reference.entityKey,
      count: 2,
      totalOperations: 5,
      truncated: true,
      names: SERVER_ENTITY_OPERATION_NAMES,
      operations: [entityOperationToResponseRow(reference), entityOperationToResponseRow(minimal)],
      firstOperation: entityOperationToResponseRow(reference),
    });

    const response = await fetchEntityByKey(reference.entityKey ?? "");

    expect(response?.totalOperations).toBe(5);
    expect(response?.truncated).toBe(true);
    expect(response?.operations[0]).toEqual(reference);
    expect(response?.operations[1]).toEqual(minimal);
    expect(response?.firstOperation).toEqual(reference);
  });
});
