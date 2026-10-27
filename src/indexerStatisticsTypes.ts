export const STATISTICS_PERIODS = [
  { id: "1h", label: "1 hour", hours: 1 },
  { id: "2h", label: "2 hours", hours: 2 },
  { id: "6h", label: "6 hours", hours: 6 },
  { id: "12h", label: "12 hours", hours: 12 },
  { id: "24h", label: "24 hours", hours: 24 },
  { id: "48h", label: "48 hours", hours: 48 },
  { id: "72h", label: "72 hours", hours: 72 },
  { id: "7d", label: "7 days", hours: 168 },
  { id: "all", label: "All time", hours: null },
] as const;

export type StatisticsPeriod = typeof STATISTICS_PERIODS[number]["id"];

/** Stored activity only. Current entity state never belongs to a time window. */
export interface StatisticsActivity {
  blocks: Pick<
    IndexerStatistics["blocks"],
    "indexed" | "transactions" | "inputBytes" | "compressedInputBytes" | "gasFeeWei" | "rentFeeWei" | "burnedWei"
  >;
  transactions: IndexerStatistics["transactions"];
  operations: IndexerStatistics["operations"];
}

export interface StatisticsWindow extends StatisticsActivity {
  /** Null bounds mean all stored history, including any future-dated rows. */
  fromInclusiveUtc: string | null;
  toExclusiveUtc: string | null;
}

/** Counts and byte totals are decimal strings so JSON never loses integer precision. */
export interface IndexerStatistics {
  version: 1;
  gatheredAtUtc: string;
  completedAtUtc: string;
  durationMs: number;
  refreshIntervalMs: number;
  chain: {
    id: string | null;
    observedHead: string | null;
    observedAtUtc: string | null;
    headObservationAgeSeconds: number | null;
    headObservationStale: boolean;
    blocksThroughObservedHead: string | null;
    indexedBlocksThroughObservedHead: string | null;
    /** Coverage excludes the newest ten blocks from both its numerator and denominator. */
    coverageThroughBlock: string | null;
    coverageBlocks: string | null;
    indexedCoverageBlocks: string | null;
    scannedPercent: number | null;
  };
  blocks: {
    indexed: string;
    first: string | null;
    last: string | null;
    missingWithinStoredRange: string;
    transactions: string;
    inputBytes: string;
    compressedInputBytes: string;
    /** Gas fees paid (Σ gasUsed × effectiveGasPrice), wei. */
    gasFeeWei: string;
    /** Storage rent burned outside gas, wei. */
    rentFeeWei: string;
    /** Base-fee burn plus rent, wei. */
    burnedWei: string;
  };
  transactions: {
    indexed: string;
    withInput: string;
    inputBytes: string;
    compressedInputBytes: string;
    maxInputBytes: string;
  };
  operations: {
    byType: Array<{ type: number; name: string; successful: string; reverted: string; unknownStatus: string }>;
    successfulCreatesWithoutKey: string;
    /** Successful creates/patches that wrote at least one bytes attribute. */
    successfulBytesWrites: string;
    /** Bytes those bytes attributes held, counted per write (contents are never stored). */
    successfulBytesWritten: string;
    /** Attribute triples set by successful creates/patches with the indexed flag (queryable). */
    successfulIndexedAttributeWrites: string;
    /** Attribute triples set without it (stored, returned, never matched by a query). */
    successfulStoredAttributeWrites: string;
    /** Patch tombstones that unset an attribute. */
    successfulAttributeUnsets: string;
    /** Successful creates/patches that set an `arkiv.schema` tag. */
    successfulSchemaTaggedWrites: string;
  };
  entities: {
    status: "available" | "unavailable" | "importing" | "not-ready";
    floorBlock: string | null;
    asOfBlock: string | null;
    lagBehindObservedHead: string | null;
    lastFoldAtUtc: string | null;
    genesisStatus: string | null;
    known: string | null;
    active: string | null;
    expired: string | null;
    deleted: string | null;
    activeWithPayload: string | null;
    activeRecordedPayloadBytes: string | null;
    maxActiveRecordedPayloadBytes: string | null;
    activeAttributes: string | null;
    activeWithAttributes: string | null;
    maxAttributesPerActiveEntity: string | null;
    attributeTypes: Array<{ typeId: number; name: string; count: string }>;
    topContentTypes: Array<{ contentType: string; entities: string; recordedPayloadBytes: string }>;
  };
  /** Optional so readers can continue to serve snapshots from older workers. */
  windows?: Record<StatisticsPeriod, StatisticsWindow>;
  limitations: string[];
}

export interface StatisticsResponse extends IndexerStatistics {
  ageSeconds: number;
  stale: boolean;
}
