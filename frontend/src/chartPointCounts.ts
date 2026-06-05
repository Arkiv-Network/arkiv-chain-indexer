export const CHART_POINT_COUNT_OPTIONS = [1000, 750, 500, 250, 100] as const;
export const DEFAULT_CHART_POINT_COUNT = CHART_POINT_COUNT_OPTIONS[0];

export type ChartPointCount = (typeof CHART_POINT_COUNT_OPTIONS)[number];

export function parseChartPointCount(value: string): ChartPointCount {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_CHART_POINT_COUNT;
  return CHART_POINT_COUNT_OPTIONS.includes(parsed as ChartPointCount)
    ? (parsed as ChartPointCount)
    : DEFAULT_CHART_POINT_COUNT;
}

export function normalizeChartPointCount(value: string): string {
  return String(parseChartPointCount(value));
}

export function chartRequestLimit(pointCount: ChartPointCount, blockCount?: number): number {
  if (blockCount === undefined) return pointCount;
  return Math.min(pointCount, Math.max(0, blockCount));
}
