import { STATISTICS_PERIODS, type StatisticsResponse } from "../src/indexerStatisticsTypes";

export function statisticsFixture(): StatisticsResponse {
  const snapshot: StatisticsResponse = {
    version: 1, gatheredAtUtc: "2026-09-24T12:00:00.123Z", completedAtUtc: "2026-09-24T12:00:01.123Z",
    durationMs: 1000, refreshIntervalMs: 300_000, ageSeconds: 1, stale: false,
    chain: { id: "1", observedHead: "100", observedAtUtc: "2026-09-24T12:00:00.000Z", headObservationAgeSeconds: 0,
      headObservationStale: false, blocksThroughObservedHead: "101", indexedBlocksThroughObservedHead: "99",
      coverageThroughBlock: "90", coverageBlocks: "91", indexedCoverageBlocks: "91", scannedPercent: 100 },
    blocks: { indexed: "99", first: "0", last: "100", missingWithinStoredRange: "2", transactions: "99", inputBytes: "9007199254740993", compressedInputBytes: "99", gasFeeWei: "99000", rentFeeWei: "9007199254740993", burnedWei: "9007199254839993" },
    transactions: { indexed: "99", withInput: "99", inputBytes: "9900", compressedInputBytes: "99", maxInputBytes: "100" },
    operations: { byType: [{ type: 1, name: "created", successful: "99", reverted: "2", unknownStatus: "3" }],
      successfulCreatesWithoutKey: "0", successfulBytesWrites: "99", successfulBytesWritten: "9900",
      successfulIndexedAttributeWrites: "99", successfulStoredAttributeWrites: "0", successfulAttributeUnsets: "0", successfulSchemaTaggedWrites: "0" },
    entities: { status: "available", floorBlock: "0", asOfBlock: "100", lagBehindObservedHead: "0", lastFoldAtUtc: null, genesisStatus: null,
      known: "456", active: "456", expired: "0", deleted: "0", activePermanent: "1", activeWithBytes: "456", activeBytes: "45600",
      maxActiveBytes: "100", activeAttributes: "456", activeIndexedAttributes: "400", activeStoredAttributes: "56", activeWithAttributes: "456",
      maxAttributesPerActiveEntity: "1", attributeTypes: [], topSchemas: [{ schemaName: "posts", entities: "400", bytes: "40000" }], activeUntagged: "56" },
    limitations: [],
  };
  const windows = {} as NonNullable<StatisticsResponse["windows"]>;
  for (const [index, { id, hours }] of STATISTICS_PERIODS.entries()) windows[id] = {
    fromInclusiveUtc: hours === null ? null : new Date(Date.parse(snapshot.gatheredAtUtc) - hours * 3_600_000).toISOString(),
    toExclusiveUtc: hours === null ? null : snapshot.gatheredAtUtc,
    blocks: { ...snapshot.blocks, indexed: hours === null ? "99" : String(index + 1), inputBytes: hours === null ? snapshot.blocks.inputBytes : String((index + 1) * 100) },
    transactions: { ...snapshot.transactions, indexed: hours === null ? "99" : String(index + 1) },
    operations: { ...snapshot.operations, byType: [{ type: 1, name: "created", successful: hours === null ? "99" : String(index + 1), reverted: "2", unknownStatus: "3" }] },
  };
  snapshot.windows = windows;
  return snapshot;
}
