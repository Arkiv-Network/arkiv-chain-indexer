import { STATISTICS_PERIODS, type IndexerStatistics, type StatisticsActivity, type StatisticsWindow } from "./indexerStatisticsTypes";

export interface BlockStatisticsBand extends Omit<IndexerStatistics["blocks"], "missingWithinStoredRange"> {
  band: number;
  throughHead: string;
  throughCoverageHead: string;
}
export type TransactionStatisticsBand = IndexerStatistics["transactions"] & { band: number };
export interface OperationStatisticsBand {
  band: number;
  type: number;
  successful: string;
  reverted: string;
  unknownStatus: string;
  createsWithoutKey: string;
  payloadWrites: string;
  payloadBytes: string;
  referenceWrites: string;
  referenceBytes: string;
  referencesWithoutSize: string;
}

const OP_NAMES: Record<number, string> = {
  1: "created", 2: "updated", 3: "extended", 4: "ownerChanged", 5: "deleted", 6: "expired",
};

export const sumStatistics = <T, K extends keyof T>(rows: readonly T[], key: K): string =>
  rows.reduce((total, row) => total + BigInt(row[key] as string), 0n).toString();

function maximum<T, K extends keyof T>(rows: readonly T[], key: K): string {
  return rows.reduce((largest, row) => {
    const value = BigInt(row[key] as string);
    return value > largest ? value : largest;
  }, 0n).toString();
}

/** SQL groups each history scan into disjoint bands; only these small aggregates are folded per period. */
export function foldStatisticsActivity(
  blocks: readonly BlockStatisticsBand[],
  transactions: readonly TransactionStatisticsBand[],
  operations: readonly OperationStatisticsBand[],
): StatisticsActivity {
  return {
    blocks: {
      indexed: sumStatistics(blocks, "indexed"), transactions: sumStatistics(blocks, "transactions"),
      inputBytes: sumStatistics(blocks, "inputBytes"), compressedInputBytes: sumStatistics(blocks, "compressedInputBytes"),
    },
    transactions: {
      indexed: sumStatistics(transactions, "indexed"), withInput: sumStatistics(transactions, "withInput"),
      inputBytes: sumStatistics(transactions, "inputBytes"), compressedInputBytes: sumStatistics(transactions, "compressedInputBytes"),
      maxInputBytes: maximum(transactions, "maxInputBytes"),
    },
    operations: {
      byType: [...new Set([...Object.keys(OP_NAMES).map(Number), ...operations.map((row) => row.type)])].sort((a, b) => a - b).map((type) => {
        const rows = operations.filter((row) => row.type === type);
        return {
          type, name: OP_NAMES[type] ?? `unknown(${type})`, successful: sumStatistics(rows, "successful"),
          reverted: sumStatistics(rows, "reverted"), unknownStatus: sumStatistics(rows, "unknownStatus"),
        };
      }),
      successfulCreatesWithoutKey: sumStatistics(operations, "createsWithoutKey"),
      successfulPayloadWrites: sumStatistics(operations, "payloadWrites"),
      successfulPayloadBytes: sumStatistics(operations, "payloadBytes"),
      successfulReferenceWrites: sumStatistics(operations, "referenceWrites"),
      referencedPayloadBytes: sumStatistics(operations, "referenceBytes"),
      referencesWithoutSize: sumStatistics(operations, "referencesWithoutSize"),
    },
  };
}

export function statisticsWindowBounds(cutoffUtc: string): Array<Pick<StatisticsWindow, "fromInclusiveUtc" | "toExclusiveUtc">> {
  return STATISTICS_PERIODS.map(({ hours }) => ({
    fromInclusiveUtc: hours === null ? null : new Date(Date.parse(cutoffUtc) - hours * 3_600_000).toISOString(),
    toExclusiveUtc: hours === null ? null : cutoffUtc,
  }));
}

/** Band -1 contains future timestamps; band 8 contains history older than seven days. */
export function statisticsBandSql(column: string): string {
  // Ascending thresholds make width_bucket include the lower bound. Parse each row's timestamp once.
  return `8 - width_bucket(${column}::timestamptz, ARRAY[$9, $8, $7, $6, $5, $4, $3, $2, $1]::timestamptz[])`;
}

export function foldStatisticsWindows(
  cutoffUtc: string,
  blocks: readonly BlockStatisticsBand[],
  transactions: readonly TransactionStatisticsBand[],
  operations: readonly OperationStatisticsBand[],
  allTime: StatisticsActivity,
): NonNullable<IndexerStatistics["windows"]> {
  const bounds = statisticsWindowBounds(cutoffUtc);
  return Object.fromEntries(STATISTICS_PERIODS.map(({ id, hours }, index) => {
    const inWindow = (row: { band: number }) => row.band >= 0 && row.band <= index;
    return [id, {
      ...bounds[index],
      ...(hours === null
        ? { blocks: allTime.blocks, transactions: allTime.transactions, operations: allTime.operations }
        : foldStatisticsActivity(blocks.filter(inWindow), transactions.filter(inWindow), operations.filter(inWindow))),
    }];
  })) as NonNullable<IndexerStatistics["windows"]>;
}

export function blockStatisticsBounds(rows: readonly BlockStatisticsBand[]): Pick<IndexerStatistics["blocks"], "first" | "last" | "missingWithinStoredRange"> {
  let first: bigint | null = null;
  let last: bigint | null = null;
  for (const row of rows) {
    if (row.first !== null && (first === null || BigInt(row.first) < first)) first = BigInt(row.first);
    if (row.last !== null && (last === null || BigInt(row.last) > last)) last = BigInt(row.last);
  }
  return {
    first: first?.toString() ?? null, last: last?.toString() ?? null,
    missingWithinStoredRange: (first === null || last === null ? 0n : last - first + 1n - BigInt(sumStatistics(rows, "indexed"))).toString(),
  };
}
