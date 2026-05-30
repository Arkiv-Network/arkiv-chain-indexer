import { describe, expect, test } from "bun:test";
import {
  parseBatcherCollectorConfig,
  runBatcherCollector,
} from "./batcherCollector";
import type { BatcherMetrics, BatcherMetricsSource } from "./batcher";
import type { StoredBlock } from "./storage";

describe("batcher collector worker config", () => {
  test("reads required settings and interval from env", () => {
    expect(
      parseBatcherCollectorConfig([], {
        DATABASE_URL: "postgres://example",
        BATCHER_COLLECTOR_URL: "https://collector.example",
        BATCHER_COLLECTOR_INTERVAL_MS: "2500",
      }),
    ).toEqual({
      databaseUrl: "postgres://example",
      batcherCollectorUrl: "https://collector.example",
      intervalMs: 2500,
      once: false,
    });
  });

  test("lets CLI settings override env", () => {
    expect(
      parseBatcherCollectorConfig(
        [
          "--database-url",
          "postgres://cli",
          "--batcher-collector-url",
          "https://cli.example",
          "--interval-ms",
          "5000",
          "--once",
        ],
        {
          DATABASE_URL: "postgres://env",
          BATCHER_COLLECTOR_URL: "https://env.example",
          BATCHER_COLLECTOR_INTERVAL_MS: "2500",
        },
      ),
    ).toEqual({
      databaseUrl: "postgres://cli",
      batcherCollectorUrl: "https://cli.example",
      intervalMs: 5000,
      once: true,
    });
  });

  test("requires a batcher collector URL", () => {
    expect(() =>
      parseBatcherCollectorConfig([], {
        DATABASE_URL: "postgres://example",
      }),
    ).toThrow("BATCHER_COLLECTOR_URL");
  });
});

describe("batcher collector worker", () => {
  test("runs one fill sweep when once is enabled", async () => {
    const storage = new FakeBatcherStorage([
      {
        blockNumber: "10",
        blockDate: "2026-05-22T15:17:01.000Z",
      } as unknown as StoredBlock,
    ]);
    const collector = new FakeBatcherCollector({ batcherQueueSize: "906" });
    const runtime = new FakeRuntime();

    await runBatcherCollector(
      {
        databaseUrl: "postgres://example",
        batcherCollectorUrl: "https://collector.example",
        intervalMs: 1000,
        once: true,
      },
      storage,
      collector,
      runtime,
    );

    expect(collector.requestedDates).toEqual(["2026-05-22T15:17:01.000Z"]);
    expect(storage.savedBatcherMetrics).toEqual([
      { blockNumber: 10n, metrics: { batcherQueueSize: "906" } },
    ]);
    expect(runtime.sleeps).toEqual([]);
    expect(runtime.logs).toContain("Batcher collector worker updated 1 block(s)");
  });
});

class FakeBatcherStorage {
  savedBatcherMetrics: Array<{ blockNumber: bigint; metrics: BatcherMetrics }> = [];

  constructor(private readonly recentBlocksMissingBatcherMetrics: StoredBlock[]) {}

  async queryRecentBlocksMissingBatcherMetrics(): Promise<StoredBlock[]> {
    return this.recentBlocksMissingBatcherMetrics;
  }

  async saveBatcherMetricsForBlock(blockNumber: bigint, metrics: BatcherMetrics): Promise<boolean> {
    this.savedBatcherMetrics.push({ blockNumber, metrics });
    return true;
  }
}

class FakeBatcherCollector implements BatcherMetricsSource {
  requestedDates: string[] = [];

  constructor(private readonly metrics: BatcherMetrics) {}

  async getMetricsForBlockDate(blockDate: string): Promise<BatcherMetrics | undefined> {
    this.requestedDates.push(blockDate);
    return this.metrics;
  }
}

class FakeRuntime {
  logs: string[] = [];
  sleeps: number[] = [];

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}
