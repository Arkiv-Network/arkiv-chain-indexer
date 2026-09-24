import type { Db } from "./db";
import { TYPE_TAGS_BY_ID } from "./entityValues";
import type { IndexerStatistics } from "./indexerStatisticsTypes";
import {
  blockStatisticsBounds, foldStatisticsActivity, foldStatisticsWindows, statisticsBandSql, statisticsWindowBounds,
  sumStatistics, type BlockStatisticsBand, type OperationStatisticsBand, type TransactionStatisticsBand,
} from "./statisticsWindows";

export const DEFAULT_STATISTICS_INTERVAL_MS = 300_000;
export const DEFAULT_STATISTICS_FILE = "/tmp/arkiv-indexer-statistics.json";
export const STATISTICS_HEAD_EXCLUSION_BLOCKS = 10n;

/** Count only rows through observed head minus ten; normal tip lag does not reduce coverage. */
export function scannedPercent(count: string, head: string | null): number | null {
  if (head === null) return null;
  const total = BigInt(head) + 1n - STATISTICS_HEAD_EXCLUSION_BLOCKS;
  if (total <= 0n) return null;
  // Truncate at four decimal places so incomplete coverage never rounds up to 100%.
  return Number(BigInt(count) * 1_000_000n / total) / 10_000;
}

/** No migrations or writes: one consistent database snapshot on the worker's own connection. */
export async function gatherIndexerStatistics(
  db: Db,
  options: { schema?: string; intervalMs?: number; statementTimeoutMs?: number } = {},
): Promise<IndexerStatistics> {
  const started = Date.now();
  const prefix = `"${(options.schema ?? "public").replaceAll('"', '""')}"`;
  const table = (name: string) => `${prefix}.${name}`;
  return db.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs ?? 120_000)]);
    const timing = await tx.query<{ at: string }>("SELECT date_trunc('milliseconds', transaction_timestamp())::text AS at");
    const gatheredAtUtc = new Date(timing.rows[0]!.at).toISOString();
    // Match JSON timestamp precision exactly; every table and window uses these same UTC bounds.
    const timeBounds = [gatheredAtUtc, ...statisticsWindowBounds(gatheredAtUtc).flatMap((bound) =>
      bound.fromInclusiveUtc === null ? [] : [bound.fromInclusiveUtc])];
    // Never read scanner_rpc_url, which may contain credentials.
    const stateRows = await tx.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${table("scanner_state")} WHERE key IN ('chain_id', 'latest_observed_block', 'latest_observed_at')`,
    );
    const state = new Map(stateRows.rows.map((r) => [r.key, r.value]));
    const head = state.get("latest_observed_block") ?? null;
    const coverageHead = head === null ? null : BigInt(head) - STATISTICS_HEAD_EXCLUSION_BLOCKS;
    const observedAt = state.get("latest_observed_at") ?? null;
    const headAge = observedAt === null ? null : Math.max(0, (Date.parse(gatheredAtUtc) - Date.parse(observedAt)) / 1000);
    const blockBands = (await tx.query<BlockStatisticsBand>(`
      SELECT ${statisticsBandSql("block_date")} AS band,
        count(*)::text AS indexed, min(block_number)::text AS first, max(block_number)::text AS last,
        coalesce(sum(transaction_count), 0)::text AS transactions,
        coalesce(sum(total_input_data_size_bytes::numeric), 0)::text AS "inputBytes",
        coalesce(sum(total_input_data_compressed_size_bytes::numeric), 0)::text AS "compressedInputBytes",
        count(*) FILTER (WHERE block_number <= $10::bigint)::text AS "throughHead",
        count(*) FILTER (WHERE block_number <= $11::bigint)::text AS "throughCoverageHead"
      FROM ${table("blocks")} GROUP BY band`, [...timeBounds, head, coverageHead?.toString() ?? null])).rows;
    const throughHead = sumStatistics(blockBands, "throughHead");
    const throughCoverageHead = sumStatistics(blockBands, "throughCoverageHead");
    const transactionBands = (await tx.query<TransactionStatisticsBand>(`
      SELECT ${statisticsBandSql("block_date")} AS band, count(*)::text AS indexed,
        count(*) FILTER (WHERE input_data_size_bytes::numeric > 0)::text AS "withInput",
        coalesce(sum(input_data_size_bytes::numeric), 0)::text AS "inputBytes",
        coalesce(sum(input_data_compressed_size_bytes::numeric), 0)::text AS "compressedInputBytes",
        coalesce(max(input_data_size_bytes::numeric), 0)::text AS "maxInputBytes"
      FROM ${table("transactions")} GROUP BY band`, timeBounds)).rows;
    const operationBands = (await tx.query<OperationStatisticsBand>(`
      SELECT ${statisticsBandSql("o.block_date")} AS band, o.operation_type AS type,
        count(*) FILTER (WHERE t.status = '1')::text AS successful,
        count(*) FILTER (WHERE t.status = '0')::text AS reverted,
        count(*) FILTER (WHERE t.status IS NULL OR t.status NOT IN ('0', '1'))::text AS "unknownStatus",
        count(*) FILTER (WHERE t.status = '1' AND o.operation_type = 1 AND o.entity_key IS NULL)::text AS "createsWithoutKey",
        count(*) FILTER (WHERE t.status = '1' AND o.payload_size_bytes > 0)::text AS "payloadWrites",
        coalesce(sum(o.payload_size_bytes) FILTER (WHERE t.status = '1'), 0)::text AS "payloadBytes",
        count(*) FILTER (WHERE t.status = '1' AND o.is_reference)::text AS "referenceWrites",
        coalesce(sum(CASE WHEN o.payload_reference->>'sizeBytes' ~ '^[0-9]+$'
          THEN (o.payload_reference->>'sizeBytes')::numeric END)
          FILTER (WHERE t.status = '1' AND o.is_reference), 0)::text AS "referenceBytes",
        count(*) FILTER (WHERE t.status = '1' AND o.is_reference
          AND coalesce(o.payload_reference->>'sizeBytes' ~ '^[0-9]+$', false) = false)::text AS "referencesWithoutSize"
      FROM ${table("transaction_operations")} o
      LEFT JOIN ${table("transactions")} t USING (block_number, position)
      GROUP BY band, o.operation_type`, timeBounds)).rows;
    const activity = foldStatisticsActivity(blockBands, transactionBands, operationBands);
    const blockStats = { ...activity.blocks, ...blockStatisticsBounds(blockBands) };
    const { transactions, operations } = activity;
    const windows = foldStatisticsWindows(gatheredAtUtc, blockBands, transactionBands, operationBands, activity);
    const entities: IndexerStatistics["entities"] = {
      status: "unavailable", floorBlock: null, asOfBlock: null, lagBehindObservedHead: null,
      lastFoldAtUtc: null, genesisStatus: null, known: null, active: null, expired: null, deleted: null,
      activeWithPayload: null, activeRecordedPayloadBytes: null, maxActiveRecordedPayloadBytes: null,
      activeAttributes: null, activeWithAttributes: null, maxAttributesPerActiveEntity: null,
      attributeTypes: [], topContentTypes: [],
    };
    const exists = (await tx.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS present",
      [table("entity_index_state"), table("entity_versions")],
    )).rows[0]!.present;
    if (exists) {
      const rows = await tx.query<{ key: string; value: string }>(`SELECT key, value FROM ${table("entity_index_state")}
        WHERE key IN ('floor_block', 'projected_through_block', 'last_fold_at', 'genesis_import')`);
      const progress = new Map(rows.rows.map((r) => [r.key, r.value]));
      entities.floorBlock = progress.get("floor_block") ?? null;
      entities.asOfBlock = progress.get("projected_through_block") ?? null;
      entities.lastFoldAtUtc = progress.get("last_fold_at") ?? null;
      const genesis = progress.get("genesis_import");
      entities.genesisStatus = genesis ? (JSON.parse(genesis) as { status: string }).status : null;
      entities.status = entities.genesisStatus === "running" ? "importing" : entities.asOfBlock === null ? "not-ready" : "available";
      if (entities.status === "available") {
        const at = entities.asOfBlock!;
        if (head !== null) entities.lagBehindObservedHead = (BigInt(head) > BigInt(at) ? BigInt(head) - BigInt(at) : 0n).toString();
        // Use version validity, not to_block IS NULL: a refold can already include later versions.
        const versions = `FROM ${table("entity_versions")} v WHERE v.from_block <= $1::bigint
          AND (v.to_block IS NULL OR v.to_block > $1::bigint)`;
        const active = "NOT deleted AND expires_at > $1::numeric";
        const counts = (await tx.query<Partial<IndexerStatistics["entities"]>>(`
          SELECT count(*)::text AS known,
            count(*) FILTER (WHERE ${active})::text AS active,
            count(*) FILTER (WHERE NOT deleted AND expires_at <= $1::numeric)::text AS expired,
            count(*) FILTER (WHERE deleted)::text AS deleted,
            count(*) FILTER (WHERE ${active} AND payload_size > 0)::text AS "activeWithPayload",
            coalesce(sum(payload_size) FILTER (WHERE ${active}), 0)::text AS "activeRecordedPayloadBytes",
            coalesce(max(payload_size) FILTER (WHERE ${active}), 0)::text AS "maxActiveRecordedPayloadBytes",
            coalesce(sum(jsonb_array_length(attributes)) FILTER (WHERE ${active}), 0)::text AS "activeAttributes",
            count(*) FILTER (WHERE ${active} AND jsonb_array_length(attributes) > 0)::text AS "activeWithAttributes",
            coalesce(max(jsonb_array_length(attributes)) FILTER (WHERE ${active}), 0)::text AS "maxAttributesPerActiveEntity"
          ${versions}`, [at])).rows[0]!;
        Object.assign(entities, counts);
        entities.attributeTypes = (await tx.query<{ typeId: number; count: string }>(`
          SELECT (a->>'typeId')::int AS "typeId", count(*)::text AS count
          FROM (SELECT attributes ${versions} AND ${active}) live,
            LATERAL jsonb_array_elements(live.attributes) a
          GROUP BY (a->>'typeId')::int ORDER BY (a->>'typeId')::int`, [at])).rows.map((r) => ({
            ...r, name: TYPE_TAGS_BY_ID.get(r.typeId) ?? `unknown(${r.typeId})`,
          }));
        entities.topContentTypes = (await tx.query<IndexerStatistics["entities"]["topContentTypes"][number]>(`
          SELECT content_type AS "contentType", count(*)::text AS entities,
            coalesce(sum(payload_size), 0)::text AS "recordedPayloadBytes"
          ${versions} AND ${active} GROUP BY content_type
          ORDER BY count(*) DESC, content_type COLLATE "C" ASC LIMIT 20`, [at])).rows;
      }
    }
    const limitations = [
      "Coverage excludes the newest 10 observed blocks from both the stored count and the chain total. Older gaps still reduce coverage; chains with 10 or fewer blocks have no coverage percentage yet. The head observation can be stale.",
      "All totals cover stored data only. Skipped transactions, disabled transaction storage, missing decoder history and unimported genesis entities cannot be recovered from these counts.",
      "Finite activity windows use stored block timestamps, with an inclusive start and exclusive end at gatheredAtUtc. All time includes every stored row, including future-dated rows. Empty windows are zero stored activity, not proof of complete chain coverage. Current entity, payload and attribute state is not filtered by the selected period.",
      "Operation counts are attempts grouped by receipt outcome; only status 1 counts as successful. Repeated updates count separately. Genesis entities have no create transaction.",
      "Input bytes are calldata sizes, not full serialized signed transaction sizes. Historical size fields defaulted to zero and cannot be distinguished from measured zero without rescanning.",
      "Entity state and active counts are evaluated at the projection block, not the live chain at collection time. Missing creates, pending refolds and pre-log expiry estimates can limit accuracy.",
      "Recorded entity payload sizes are projection metadata, not verified provider storage usage. Reference size totals are declared bytes per write, include repeated references, and exclude references without a usable size.",
      "Payload contents, full raw transaction sizes, unique payload storage and exact encoded attribute byte sizes are unavailable from the stored data.",
    ];
    return {
      version: 1, gatheredAtUtc, completedAtUtc: new Date().toISOString(), durationMs: Date.now() - started,
      refreshIntervalMs: options.intervalMs ?? DEFAULT_STATISTICS_INTERVAL_MS,
      chain: {
        id: state.get("chain_id") ?? null, observedHead: head, observedAtUtc: observedAt,
        headObservationAgeSeconds: headAge, headObservationStale: headAge === null || headAge > 60,
        blocksThroughObservedHead: head === null ? null : (BigInt(head) + 1n).toString(),
        indexedBlocksThroughObservedHead: head === null ? null : throughHead,
        coverageThroughBlock: coverageHead === null || coverageHead < 0n ? null : coverageHead.toString(),
        coverageBlocks: coverageHead === null ? null : (coverageHead < 0n ? 0n : coverageHead + 1n).toString(),
        indexedCoverageBlocks: head === null ? null : throughCoverageHead,
        scannedPercent: scannedPercent(throughCoverageHead, head),
      },
      blocks: blockStats, transactions, operations, entities, windows, limitations,
    };
  });
}
