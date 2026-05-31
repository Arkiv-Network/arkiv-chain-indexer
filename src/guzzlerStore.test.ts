import { describe, expect, test } from "bun:test";
import type { GuzzlerBucket } from "./guzzlers";
import { parseBuckets, RedisGuzzlerStore, serializeBuckets } from "./guzzlerStore";

const T0 = Date.parse("2026-05-30T12:00:00.000Z");
const MINUTE = 60 * 1000;

function bucket(timestampMs: number, gasUsed = "277259", feeWei = "88445621000000000"): GuzzlerBucket {
  return {
    minute: Math.floor(timestampMs / MINUTE),
    transactionCount: 1,
    totalGasUsed: gasUsed,
    totalFeeWei: feeWei,
    firstSeenMs: timestampMs,
    lastSeenMs: timestampMs,
  };
}

class RecordingRedisClient {
  hsetCalls: Array<{ key: string; field: string; value: string }> = [];

  async hset(key: string, field: string, value: string): Promise<void> {
    this.hsetCalls.push({ key, field, value });
  }
}

function redisStore(client: RecordingRedisClient): RedisGuzzlerStore {
  const Store = RedisGuzzlerStore as unknown as new (
    client: RecordingRedisClient,
    key: string,
    leaderboardKey: string,
  ) => RedisGuzzlerStore;
  return new Store(client, "guzzlers:test:senders", "guzzlers:test:leaderboards");
}

describe("guzzler Redis bucket serialization", () => {
  test("parses versioned tuple bucket values", () => {
    const buckets = [bucket(T0)];
    const encoded = {
      v: 1,
      b: [[buckets[0]!.minute, 1, "277259", "88445621000000000", T0, T0]],
    };

    expect(parseBuckets(JSON.stringify(encoded))).toEqual(buckets);
  });

  test("putSender writes the versioned tuple format", async () => {
    const client = new RecordingRedisClient();
    const store = redisStore(client);
    const buckets = [bucket(T0, "21000", "1000")];

    await store.putSender("0xaaa", buckets);

    expect(client.hsetCalls).toHaveLength(1);
    expect(client.hsetCalls[0]).toEqual({
      key: "guzzlers:test:senders",
      field: "0xaaa",
      value: JSON.stringify(serializeBuckets(buckets)),
    });
    expect(JSON.parse(client.hsetCalls[0]!.value)).toEqual({
      v: 1,
      b: [[Math.floor(T0 / MINUTE), 1, "21000", "1000", T0, T0]],
    });
  });

  test("ignores unknown versioned bucket values", () => {
    expect(parseBuckets(JSON.stringify({ v: 2, b: [[Math.floor(T0 / MINUTE), 1, "1", "2", T0, T0]] }))).toEqual(
      [],
    );
  });

  test("ignores malformed tuple entries and keeps valid ones", () => {
    const valid = bucket(T0, "300", "30");
    const encoded = {
      v: 1,
      b: [
        [valid.minute, valid.transactionCount, valid.totalGasUsed, valid.totalFeeWei, valid.firstSeenMs],
        [valid.minute, valid.transactionCount, 300, valid.totalFeeWei, valid.firstSeenMs, valid.lastSeenMs],
        [valid.minute, valid.transactionCount, valid.totalGasUsed, valid.totalFeeWei, valid.firstSeenMs, valid.lastSeenMs],
      ],
    };

    expect(parseBuckets(JSON.stringify(encoded))).toEqual([valid]);
  });

  test("preserves decimal string precision through compact tuple values", () => {
    const preciseGas = "123456789012345678901234567890";
    const preciseFee = "987654321098765432109876543210";
    const buckets = [bucket(T0, preciseGas, preciseFee)];

    const encoded = serializeBuckets(buckets);
    expect(encoded.b[0]?.[2]).toBe(preciseGas);
    expect(encoded.b[0]?.[3]).toBe(preciseFee);
    expect(parseBuckets(JSON.stringify(encoded))).toEqual(buckets);
  });
});
