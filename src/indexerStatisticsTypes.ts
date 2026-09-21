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
    successfulPayloadWrites: string;
    successfulPayloadBytes: string;
    successfulReferenceWrites: string;
    referencedPayloadBytes: string;
    referencesWithoutSize: string;
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
  limitations: string[];
}

export interface StatisticsResponse extends IndexerStatistics {
  ageSeconds: number;
  stale: boolean;
}
