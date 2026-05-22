export interface BatcherMetrics {
  batcherQueueSize?: string;
  batcherIntensity?: string;
  batcherLowerThreshold?: string;
  batcherUpperThreshold?: string;
  batcherMaxBlockSize?: string;
  batcherMaxTxSize?: string;
}

export interface BatcherMetricsSource {
  getMetricsForBlockDate(blockDate: string, now?: Date): Promise<BatcherMetrics | undefined>;
}

const MIN_COLLECTOR_AGE_MS = 2_000;
const MAX_BLOCK_AGE_MS = 60 * 60 * 1_000;

export class HttpBatcherCollector implements BatcherMetricsSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getMetricsForBlockDate(blockDate: string, now: Date = new Date()): Promise<BatcherMetrics | undefined> {
    if (!isBatcherCollectionEligible(blockDate, now)) {
      return undefined;
    }

    const response = await this.fetchFn(this.urlForBlockDate(blockDate));
    if (!response.ok) {
      throw new Error(`Batcher collector returned HTTP ${response.status}`);
    }

    return parseBatcherCollectorResponse(await response.json());
  }

  private urlForBlockDate(blockDate: string): string {
    const url = new URL(this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/history/${collectorSecond(blockDate)}`;
    return url.toString();
  }
}

export function isBatcherCollectionEligible(blockDate: string, now: Date = new Date()): boolean {
  const blockMs = Date.parse(blockDate);
  if (!Number.isFinite(blockMs)) return false;

  const ageMs = now.getTime() - blockMs;
  return ageMs > MIN_COLLECTOR_AGE_MS && ageMs <= MAX_BLOCK_AGE_MS;
}

export function collectorSecond(blockDate: string): string {
  const blockMs = Date.parse(blockDate);
  if (!Number.isFinite(blockMs)) {
    throw new Error(`Invalid block date: ${blockDate}`);
  }
  return new Date(Math.floor(blockMs / 1_000) * 1_000).toISOString().replace(".000Z", "Z");
}

export function parseBatcherCollectorResponse(body: unknown): BatcherMetrics | undefined {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.entry) || body.entry.ok !== true) {
    return undefined;
  }

  const result = body.entry.result;
  if (!isRecord(result)) {
    return undefined;
  }

  const metrics: BatcherMetrics = {
    ...numericField("batcherQueueSize", result.current_load),
    ...numericField("batcherIntensity", result.intensity),
    ...numericField("batcherLowerThreshold", result.lower_threshold),
    ...numericField("batcherUpperThreshold", result.upper_threshold),
    ...numericField("batcherMaxBlockSize", result.max_block_size),
    ...numericField("batcherMaxTxSize", result.max_tx_size),
  };

  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function numericField<K extends keyof BatcherMetrics>(
  key: K,
  value: unknown,
): Pick<BatcherMetrics, K> | Record<string, never> {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { [key]: String(value) } as Pick<BatcherMetrics, K>;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return { [key]: value.trim() } as Pick<BatcherMetrics, K>;
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
