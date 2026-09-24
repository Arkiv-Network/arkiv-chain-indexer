import { STATISTICS_PERIODS, type StatisticsActivity, type StatisticsPeriod, type StatisticsWindow, type IndexerStatistics } from "../../src/indexerStatisticsTypes";

export function isStatisticsPeriod(value: string): value is StatisticsPeriod {
  return STATISTICS_PERIODS.some(({ id }) => id === value);
}

/** Older files have no windows. Missing period data is unavailable, never manufactured as zero. */
export function selectStatisticsActivity(
  snapshot: StatisticsActivity & Pick<IndexerStatistics, "windows">,
  period: StatisticsPeriod,
): StatisticsWindow | null {
  if (snapshot.windows?.[period]) return snapshot.windows[period];
  if (period !== "all") return null;
  return {
    fromInclusiveUtc: null, toExclusiveUtc: null,
    blocks: snapshot.blocks, transactions: snapshot.transactions, operations: snapshot.operations,
  };
}
