/** Keep these descriptions aligned with src/indexerStatistics.ts and the scanner's size measurements. */
export interface StatisticsExplanation {
  meaning: string;
  source: string;
  calculation: string;
  conditions: string;
  caveats: string;
}

const explain = (meaning: string, source: string, calculation: string, conditions: string, caveats: string): StatisticsExplanation =>
  ({ meaning, source, calculation, conditions, caveats });

const ACTIVITY_SCOPE = "Uses the selected activity period and stored block timestamps: start inclusive, collection cutoff exclusive. All time includes every stored row. Empty periods report zero stored activity; missing history is not estimated.";
const TX_SCOPE = "Includes successful, reverted and unknown-outcome transactions that were stored. The scanner excludes its system sender (0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001). " + ACTIVITY_SCOPE;
const INPUT_LIMITS = "This measures calldata only, without signatures or transaction-envelope overhead. Older size columns defaulted to zero, so historical zero values may mean the size was not recorded. No calldata bytes are stored.";
const ENTITY_SOURCE = "entity_versions, evaluated at entity_index_state.projected_through_block (the projection block shown above).";
const VERSION_SCOPE = "Choose the version with from_block ≤ projection block and to_block > projection block, or no to_block. Each known entity contributes once; superseded and future versions do not contribute.";
const ACTIVE_SCOPE = "Use the version valid at the projection block, require deleted = false and expires_at > that block. An entity expiring exactly at that block is already inactive.";
const ENTITY_LIMITS = "Unavailable means the projection is missing, has no head, or is importing genesis. Missing creates, an incomplete genesis import, pending historical refolds and inferred pre-log expiries can limit accuracy. This is not a live-node census. Entity, payload and attribute state always uses the current projection block, independent of the activity period.";
const PAYLOAD_LIMITS = "The projection carries recorded size metadata, not payload contents. A reference receipt's size can differ from the referenced entity bytes. Totals do not prove provider availability, current provider storage usage or deduplication.";
const OP_SOURCE = "The selected period filters transaction_operations.block_date, even for operations without a transaction row. transaction_operations joined to transactions by (block_number, position); operation_type selects the operation and the stored receipt status selects its outcome.";
const SUCCESS_SCOPE = "Only operations whose transaction has receipt status 1. Reverted, unknown-status and missing-transaction rows are excluded. Every operation counts separately, including multiple operations in one transaction or repeated writes to one entity. " + ACTIVITY_SCOPE;
const OP_LIMITS = "Only stored, decoded operations are covered. Disabled transaction storage or missing decoder history leaves gaps. Imported genesis entities have no create transaction. These are operation counts, not counts of distinct entities.";
const ATTRIBUTE_SOURCE = "The attributes JSON array on each active entity's selected entity_versions row.";
const ATTRIBUTE_LIMITS = "Counts describe projected attributes, not encoded bytes or distinct attribute names across the chain. Unset attributes and old values are excluded; unsupported or malformed attribute types can be skipped by the projector.";

export const STATISTICS_HELP = {
  "Statistics": explain(
    "An overview of stored activity for the selected period, plus current reconstructed entity state.",
    "GET /api/statistics serves a JSON file produced by a separate statistics worker from existing PostgreSQL tables.",
    "Each sweep reads one consistent, read-only database snapshot. Counts and byte totals remain exact decimal integers in the API; display formatting does not change the source values.",
    "Activity totals use the selected period. Chain coverage and entity state stay independent of that selection. Entity totals use the separately reported projection block. Loading this page does not run full-table counts or query the blockchain node.",
    "The worker normally refreshes about every five minutes. Missing indexed history remains missing; statistics are not estimates of unscanned data. Open each info icon for the particular metric's rules.",
  ),
  "Activity period": explain(
    "Selects the time range for indexed blocks, transactions, entity operation attempts and input/payload writes.",
    "The windows object in the precomputed snapshot. Finite periods share gatheredAtUtc as their UTC cutoff; no query or new sweep is triggered by selection.",
    "1, 2, 6, 12, 24, 48 or 72 hours, or exactly 7 × 24 hours, ending at the collection cutoff. A block timestamp equal to the start is included; one equal to the cutoff is excluded. All time includes every stored row, including future-dated rows.",
    "The period filters each table's stored block_date, not scan/import time. All time is the default and your selection is remembered in this browser. Older snapshots without windows support only All time.",
    "Chain coverage and current projected entity, active payload and attribute state do not change with this selection. Zero is no matching stored activity, not proof the period was fully indexed. Future-dated rows are excluded from finite periods.",
  ),
  "Indexed activity": explain(
    "Stored block and transaction counts in the selected activity period.",
    "blocks and transactions, grouped by their stored block_date by the statistics worker.",
    "Count block rows and transaction rows separately, and sum the transaction counts recorded in block metrics.",
    ACTIVITY_SCOPE,
    "The tables can have different historical coverage. These totals do not estimate unindexed history and do not count scan or backfill jobs.",
  ),
  "Current active payload state": explain(
    "Recorded payload sizes of entities active at the current projection block.",
    ENTITY_SOURCE,
    "Select one version per active entity, then count nonzero sizes and calculate the sum and maximum recorded size.",
    ACTIVE_SCOPE + " These state gauges are independent of the activity period.",
    PAYLOAD_LIMITS,
  ),
  "Byte units": explain(
    "Controls the display of all byte sizes on this page, including means and content-type totals.",
    "The worker sends decimal byte-count strings. This selector changes only their presentation in your browser.",
    "Bytes shows whole totals exactly in B. Decimal automatically selects kB, MB, GB, TB and larger units using powers of 1000. Binary uses KiB, MiB, GiB, TiB and powers of 1024.",
    "Decimal is the default. Your choice is remembered in this browser. Non-byte counts and the coverage percentage are unaffected.",
    "Scaled sizes and fractional means are rounded to two decimal places. Switch to Bytes to inspect an exact total; a per-transaction mean may still need rounding.",
  ),
  "Gathered": explain(
    "The time represented by the statistics snapshot, displayed in your selected time zone.",
    "gatheredAtUtc is PostgreSQL's transaction_timestamp(), truncated to millisecond precision, at the start of the worker's read-only, repeatable-read transaction.",
    "All queries in that sweep see a consistent database snapshot, even if the scanner stores more blocks while the sweep runs.",
    "This is the start of collection, not the page-load time, latest block timestamp, or end of collection.",
    "After a failed sweep the previous snapshot remains visible. The API marks it stale when its age exceeds twice the recorded refresh interval plus its collection duration; a failed page refresh also shows a warning.",
  ),
  "Collection took": explain(
    "How long the worker spent gathering this snapshot.",
    "durationMs, measured by the worker around its database aggregation work.",
    "Displayed as seconds by dividing milliseconds by 1000 and rounding to one decimal place.",
    "Includes the sequential reads and aggregation queries. It does not measure browser rendering, HTTP delivery or the wait until the next sweep.",
    "This is one collection's duration, not an average. A large index or a busy database can make the next collection slower. The worker increases its pause after expensive sweeps.",
  ),
  "Refreshes about every": explain(
    "The worker's planned pause before another collection, expressed approximately in minutes.",
    "refreshIntervalMs in the snapshot, based on STATISTICS_INTERVAL_MS and the most recent collection duration.",
    "The default pause is five minutes. It grows to at least four times the collection duration when gathering is expensive. Sweeps run sequentially and never overlap.",
    "The page checks for a newer file every 30 seconds; selecting a byte unit or reloading the page does not request a fresh database sweep.",
    "A complete refresh cycle also includes the next sweep's execution time. Failures retain the last successful snapshot, so this is a target cadence, not a freshness guarantee.",
  ),
  "Chain coverage": explain(
    "Shows how much block history is present and which part of the chain those rows cover.",
    "Stored block rows and the scanner's latest observed chain head in scanner_state.",
    "Only Chain scanned excludes the newest ten blocks. First/last height and internal gaps still describe all stored blocks. The separate Indexed activity section uses the selected period.",
    "Genesis is block 0 and counts as a block. Missing history reduces coverage even if the scanner is already following the latest head.",
    "The chain head is the scanner's last observation, not a fresh node query from this page. An observation older than 60 seconds at collection is flagged; an unknown observation cannot establish coverage.",
  ),
  "Chain scanned": explain(
    "The percentage of eligible chain blocks that actually have a stored block row, allowing ten blocks of normal tip delay.",
    "blocks.block_number and scanner_state.latest_observed_block; exposed as indexedCoverageBlocks, coverageBlocks and coverageThroughBlock.",
    "For observed head H, count stored blocks numbered 0 through H − 10, then divide by H + 1 − 10 and multiply by 100. For example, head 100 has 91 eligible blocks (0–90).",
    "The newest ten blocks are excluded from both the numerator and denominator. Older gaps still reduce the result; storing newer blocks cannot compensate for them.",
    "Unknown when no head is recorded or the chain has ten or fewer blocks. The percentage is truncated to four decimals so incomplete coverage never rounds up to 100%. A stale head can make coverage look better than the current chain.",
  ),
  "Indexed blocks": explain(
    "The exact number of stored block rows in the selected activity period.",
    "COUNT(*) over the blocks table.",
    "Each block number contributes one row. Rescanning the same block replaces its row rather than adding another count.",
    ACTIVITY_SCOPE,
    "This is not the highest block number plus one: the index may start after genesis or have gaps. It does not imply that every block has stored transaction details or decoded Arkiv operations.",
  ),
  "Observed chain head": explain(
    "The highest block number most recently reported to the scanner by its configured node.",
    "scanner_state.latest_observed_block, paired with latest_observed_at shown below the tiles.",
    "This is a block height, not a block count. A chain with head H contains H + 1 blocks when genesis is included.",
    "The worker reads the saved observation; it does not contact the node or extrapolate a newer head. Unknown means no observation has been stored.",
    "The observation may age during a catch-up scan, a pause or an RPC outage. The indexed block head and entity projection head are separate values and can both trail it.",
  ),
  "Gaps within stored range": explain(
    "How many block numbers are missing between the earliest and latest stored blocks.",
    "The minimum, maximum and row count in blocks.",
    "(last indexed block − first indexed block + 1) − indexed block count. An empty table produces zero.",
    "Only holes inside the stored range count. Blocks before the first stored block and blocks after the last stored block are outside this calculation; there is no ten-block adjustment here.",
    "Zero means the stored span has no internal gaps. It does not mean the index includes genesis, has caught up to the chain, or has complete transaction/operation history.",
  ),
  "First indexed block": explain(
    "The earliest block height with a stored block metrics row.",
    "MIN(block_number) in blocks.",
    "Returns the smallest stored block number, including block 0 when genesis was scanned. Unavailable means no block rows exist.",
    "This covers all stored blocks, including historical backfills. It is not the scanner's configured start or the entity projection's floor.",
    "A value above zero means earlier block history is absent from this table. Transaction rows and keyed entity creates may have narrower coverage than block metrics.",
  ),
  "Last indexed block": explain(
    "The greatest block height currently present in the block metrics table.",
    "MAX(block_number) in blocks.",
    "Returns the largest stored height across forward scanning, backfills and rescans. Unavailable means the table is empty.",
    "The newest ten blocks are included here. This is a table bound, not the observed node head or the entity projection head.",
    "Reaching a high block does not prove every earlier block is present. Use the coverage percentage and internal-gap count to assess completeness.",
  ),
  "Transactions in block metrics": explain(
    "The total number of included transactions counted when the stored blocks were scanned.",
    "SUM(blocks.transaction_count), calculated by the scanner from each block's included transactions.",
    "Add the transaction count in each stored block in the selected activity period; an empty block contributes zero. Transaction receipt outcome does not filter this total.",
    "Block metrics can exist even when detailed transaction-row storage is disabled. The scanner omits its system sender (0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001). " + ACTIVITY_SCOPE,
    "This can exceed Indexed transaction rows when detail storage was disabled for part of the history. It covers scanned blocks, not all transactions on an incompletely scanned chain.",
  ),
  "Indexed transaction rows": explain(
    "The number of detailed transaction records stored in the main transactions table.",
    "COUNT(*) over transactions; rows are keyed by (block_number, position).",
    "Each stored transaction position contributes once. A rescan replaces that block's rows. An empty table produces zero.",
    TX_SCOPE,
    "This does not count the separate transaction_records table or decoded operations. Disabled detail storage can make it lower than the total in block metrics, and zero is not proof that the chain had no transactions.",
  ),
  "Entity operations": explain(
    "Counts decoded Arkiv operation attempts by kind and by their transaction's receipt outcome.",
    OP_SOURCE,
    "Each transaction_operations row contributes once to Successful, Reverted or Unknown outcome. One transaction can contribute multiple rows, even to the same operation kind.",
    "Created, Updated, Extended, Owner changes and Deleted are shown. The expiry-operation row is omitted from this table; it remains in the API.",
    OP_LIMITS,
  ),
  "Operation": explain(
    "The kind of Arkiv action decoded from a stored transaction.",
    "transaction_operations.operation_type; create = 1, update = 2, extend = 3, owner transfer = 4, delete = 5.",
    "All decoded rows with that type are grouped together, then separated by receipt outcome in the adjacent columns.",
    "One execute call may contain many operations. The same entity can contribute repeatedly, and unknown future operation types can appear under an unknown label.",
    "An operation describes what the call attempted. The outcome column determines whether its transaction succeeded; the entity-state section separately describes reconstructed current state.",
  ),
  "Successful": explain(
    "Operation attempts whose containing transaction has a stored successful receipt.",
    "transaction_operations joined to transactions on block_number and position.",
    "COUNT of operation rows for this kind where transactions.status = '1'. The status is the receipt's numeric status stored as a decimal string.",
    SUCCESS_SCOPE,
    "Success is taken from the transaction receipt, not recomputed from entity state or a payload-reference verification verdict. Missing receipt status is not treated as success in this table.",
  ),
  "Reverted": explain(
    "Operation attempts decoded from transactions whose receipts report failure.",
    "The joined transactions.status value for each transaction_operations row.",
    "COUNT of operation rows for this kind where transactions.status = '0'.",
    "A reverted transaction may contribute several attempted operations. These do not count as successful changes, and the entity projector excludes transactions marked reverted.",
    "This measures attempts, not entities that were later rolled back by a different transaction. Missing or unrecognized statuses are placed in Unknown outcome instead.",
  ),
  "Unknown outcome": explain(
    "Decoded operation attempts for which the stored data does not establish a normal successful or reverted receipt outcome.",
    "The left join from transaction_operations to transactions by block_number and position.",
    "COUNT where status is null, is neither '0' nor '1', or no matching transaction row exists.",
    "These operations are excluded from the successful-operation and successful-payload totals. Unknown does not mean failed.",
    "Legacy entity projection code may trust older rows with no status, so entity-state counts need not be reconstructible by summing the Successful column alone.",
  ),
  "Entity state": explain(
    "A census of the entity states the index has reconstructed at its projection block.",
    ENTITY_SOURCE,
    "Known entities partition into active, expired but not deleted, and deleted states. Historical versions are not counted as extra entities.",
    VERSION_SCOPE,
    ENTITY_LIMITS,
  ),
  "Known entities": explain(
    "The number of distinct entities represented by a valid projected state at the reported projection block.",
    ENTITY_SOURCE,
    "Count all selected entity-version rows, including active, expired and deleted states. Known = Active + Expired, not deleted + Deleted.",
    VERSION_SCOPE,
    "Includes imported genesis entities even though they have no create transaction. Creates without an entity key or entities whose initial state was never indexed cannot contribute. It is not the cumulative Created operation count. " + ENTITY_LIMITS,
  ),
  "Active entities": explain(
    "Known entities that still exist and have not reached their expiry block in the projected state.",
    ENTITY_SOURCE,
    "COUNT of selected versions with deleted = false and expires_at strictly greater than the projection block. Expiry is checked on every sweep; it needs no explicit expire transaction.",
    ACTIVE_SCOPE,
    "An extension may keep an entity active, while deletion immediately removes it from this count. The projection block may lag the scanner and node. " + ENTITY_LIMITS,
  ),
  "Expired, not deleted": explain(
    "Known entities whose recorded expiry has been reached, but whose selected state is not a deletion tombstone.",
    ENTITY_SOURCE,
    "COUNT where deleted = false and expires_at ≤ projection block. Equality counts as expired.",
    VERSION_SCOPE + " Deleted states are excluded even if their expiry also lies in the past.",
    "This is an expiry-based state count, not a count of expire operations. Expired entities can be present even when no expiry operations were decoded. " + ENTITY_LIMITS,
  ),
  "Deleted entities": explain(
    "Known entities represented by a deletion tombstone at the projection block.",
    ENTITY_SOURCE,
    "COUNT of selected entity versions with deleted = true, without an additional expiry condition.",
    VERSION_SCOPE + " Both explicit delete operations and recorded expire/prune operations can create tombstones in the projector.",
    "This is a distinct-entity state count, not the Deleted operation total. An entity can also be absent from the projection because its create was never known; that is not counted as a deletion. " + ENTITY_LIMITS,
  ),
  "Transaction input and payloads": explain(
    "Activity data volume in the selected period: transaction calldata and payload writes in successful operations.",
    "Stored block/transaction input-size fields and decoded transaction_operations payload metadata, filtered by stored block_date.",
    "Sum input and successful-operation metadata within the selected period. Current active payload state is shown separately and does not use the selected period.",
    "Input totals include reverted transactions. Successful operation totals require receipt status 1. " + ACTIVITY_SCOPE,
    "These categories overlap and must not be added into one storage total. Calldata can contain operation metadata or reference receipts rather than entity bytes, and repeated writes are not deduplicated.",
  ),
  "Input bytes in block metrics": explain(
    "Total uncompressed transaction input/calldata bytes recorded across the stored blocks.",
    "SUM(blocks.total_input_data_size_bytes), originally computed from included transactions' input hex decoded to bytes.",
    "Sum each included transaction's input length inside its block, then sum the stored block totals. Empty input contributes zero; hex notation itself is not counted as text bytes.",
    ACTIVITY_SCOPE + " Successful and reverted transactions both contribute; the scanner's system-sender exclusion applies.",
    INPUT_LIMITS,
  ),
  "Compressed input in block metrics": explain(
    "The sum of compressed transaction-input sizes measured by the scanner.",
    "SUM(blocks.total_input_data_compressed_size_bytes). Each transaction's decoded input bytes are compressed separately with Bun.zstdCompressSync before the block total is stored.",
    "Add the individual compressed byte lengths. This is not the size obtained by compressing a whole block or the entire transaction history together.",
    "The same included transactions as the block input total contribute, regardless of receipt outcome. Empty and very small inputs can have compression-frame overhead, so compression is not guaranteed to save space.",
    "This is not HTTP compression, PostgreSQL storage size, or payload-provider usage. Historical default-zero size fields may understate the total.",
  ),
  "Input bytes in transaction rows": explain(
    "Total uncompressed calldata size across the detailed transaction rows that are actually stored.",
    "SUM(transactions.input_data_size_bytes), casting the decimal strings to PostgreSQL numeric for exact addition.",
    "Add every stored transaction's recorded input byte length. Empty inputs contribute zero; duplicate history is not introduced by rescanning a block.",
    TX_SCOPE,
    "Can differ from the block-metric total when detailed transaction storage has narrower coverage. " + INPUT_LIMITS,
  ),
  "Transaction rows with input": explain(
    "How many stored transactions have a recorded nonempty calldata field.",
    "transactions.input_data_size_bytes.",
    "COUNT of transaction rows whose recorded input size is greater than zero.",
    TX_SCOPE + " A transaction can contain input without being an Arkiv operation or carrying an entity payload.",
    "Zero-size legacy records cannot establish whether the transaction actually had no input. This count is neither the number of successful payload writes nor the number of entities with payloads.",
  ),
  "Mean input per transaction": explain(
    "Average uncompressed calldata size per stored transaction, including transactions with empty input.",
    "transactions.inputBytes divided by transactions.indexed in the statistics response; both come from the transactions table.",
    "Total recorded input bytes / total stored transaction rows. The denominator is not just Transaction rows with input. A zero denominator is displayed as a dash.",
    TX_SCOPE,
    "The result uses the chosen byte-unit system and is rounded to two decimals when fractional or scaled. This is an arithmetic mean, not a median or a gas-weighted average. " + INPUT_LIMITS,
  ),
  "Largest transaction input": explain(
    "The largest recorded uncompressed calldata size among stored detailed transactions.",
    "MAX(transactions.input_data_size_bytes::numeric).",
    "Select the maximum byte length; return zero when the transactions table is empty.",
    TX_SCOPE,
    "This is an observed maximum, not a protocol limit, and the transaction may have reverted. Transactions whose details were never saved cannot affect it. " + INPUT_LIMITS,
  ),
  "Successful writes with payload": explain(
    "Successful decoded operations that carry a recorded payload of nonzero size.",
    "transaction_operations.payload_size_bytes and the joined transaction receipt status.",
    "COUNT where status = '1' and payload_size_bytes > 0, summed over all operation types.",
    SUCCESS_SCOPE,
    "A payload-reference receipt can also have a nonzero recorded size. This is not a distinct transaction/entity count and does not indicate how many payloads remain active or stored by a provider.",
  ),
  "Recorded payload bytes in successful ops": explain(
    "The cumulative size metadata reported by the decoder for payloads in successful operations.",
    "SUM(transaction_operations.payload_size_bytes) after joining to transactions with receipt status '1'.",
    "Sum recorded sizes across every successful decoded operation; operations with a zero size add zero.",
    SUCCESS_SCOPE,
    "Repeated overwrites and repeated references contribute again. For reference operations the recorded operation payload may be the receipt itself, not the entity bytes it points to. This is neither current active payload volume nor unique stored data.",
  ),
  "Successful reference writes": explain(
    "Successful operations identified by the decoder as using payload references.",
    "transaction_operations.is_reference, joined to transactions.status.",
    "COUNT where is_reference = true and status = '1'. A usable reference size or a positive offline verification verdict is not required by this count.",
    SUCCESS_SCOPE,
    "Historical rows defaulted is_reference to false until rescanned with reference-aware decoding. Zero can therefore reflect decoder coverage rather than prove the chain never used references.",
  ),
  "Declared referenced payload bytes": explain(
    "The total entity-byte sizes declared inside successful payload-reference metadata.",
    "transaction_operations.payload_reference.sizeBytes for is_reference = true and joined receipt status '1'.",
    "Sum sizeBytes only when its stored text is a nonnegative integer made of digits. Zero is a usable size. Missing or unusable sizes contribute no bytes and are counted separately.",
    SUCCESS_SCOPE + " The statistic does not require reference_verification.valid or contact the provider.",
    "Repeated references to the same payload are counted repeatedly. These are declared sizes, not verified downloads or deduplicated provider storage; never add this total to calldata as though they measured disjoint storage.",
  ),
  "References without a usable size": explain(
    "Successful reference operations excluded from the declared referenced-byte sum because their size metadata cannot be used.",
    "payload_reference.sizeBytes on transaction_operations with is_reference = true and joined receipt status '1'.",
    "COUNT where sizeBytes is missing or its stored text is not a nonnegative integer made only of digits. A recorded zero is valid and is not counted here.",
    SUCCESS_SCOPE,
    "This flags incomplete size coverage, not necessarily a failed transaction or unavailable payload. It also does not say whether a reference signature was verified.",
  ),
  "Active entities with recorded payload": explain(
    "Active projected entities whose selected state has a nonzero recorded payload size.",
    ENTITY_SOURCE + " Uses payload_size on the selected version.",
    "COUNT of active states where payload_size > 0. Each entity contributes at most once.",
    ACTIVE_SCOPE,
    PAYLOAD_LIMITS + " A zero recorded size cannot establish whether external payload bytes exist.",
  ),
  "Active recorded payload bytes": explain(
    "The sum of recorded payload-size metadata for entities active at the projection block.",
    ENTITY_SOURCE + " Uses payload_size, seeded from imported state or carried forward from decoded create/update operations.",
    "SUM(payload_size) over active selected versions. Old overwritten versions and inactive entities do not contribute; an empty active set yields zero.",
    ACTIVE_SCOPE,
    PAYLOAD_LIMITS + " The current projector retains the previous size when an update's decoded payload size is zero, so this is explicitly a metadata total.",
  ),
  "Largest active recorded payload": explain(
    "The greatest recorded payload size among currently active projected entities.",
    ENTITY_SOURCE + " Uses the selected version's payload_size.",
    "MAX(payload_size) over active states; return zero if no active states exist.",
    ACTIVE_SCOPE,
    "This is an observed metadata maximum, not a permitted maximum payload size. " + PAYLOAD_LIMITS,
  ),
  "Attributes on active entities": explain(
    "Describes the attributes present in active entity state, rather than the history of attribute writes.",
    ATTRIBUTE_SOURCE,
    "For each selected active entity, measure its attributes array; aggregate its length and group entries by typeId.",
    ACTIVE_SCOPE + " A patch replaces or removes an attribute in projected state, so earlier values are not counted again.",
    ATTRIBUTE_LIMITS + " Projection coverage limits also apply to every count in this section.",
  ),
  "Total attributes": explain(
    "The number of attribute entries currently represented across all active projected entities.",
    ATTRIBUTE_SOURCE,
    "SUM(jsonb_array_length(attributes)) over active states. An active entity with three attributes contributes three; no attributes contributes zero.",
    ACTIVE_SCOPE,
    "The same attribute name on 1,000 entities contributes 1,000 entries. " + ATTRIBUTE_LIMITS,
  ),
  "Entities with attributes": explain(
    "How many active projected entities have at least one stored attribute.",
    ATTRIBUTE_SOURCE,
    "COUNT of active states whose attributes array length is greater than zero. One entity contributes one regardless of how many attributes it has.",
    ACTIVE_SCOPE,
    "This is a subset of Active entities, not the total number of attribute entries. " + ATTRIBUTE_LIMITS,
  ),
  "Mean attributes per active entity": explain(
    "Average number of projected attributes per active entity, including active entities with no attributes.",
    "entities.activeAttributes divided by entities.active in the statistics response.",
    "Total attributes / Active entities. The denominator is not Entities with attributes. The page truncates the mean to two decimal places and shows a dash when there are no active entities.",
    ACTIVE_SCOPE,
    "This is an arithmetic mean, not a median or a typical entity's guaranteed shape. " + ATTRIBUTE_LIMITS,
  ),
  "Maximum attributes per entity": explain(
    "The largest number of attributes on any one active projected entity.",
    ATTRIBUTE_SOURCE,
    "MAX(jsonb_array_length(attributes)) over active states; zero when no active state exists.",
    ACTIVE_SCOPE,
    "This is an observed maximum, not a protocol attribute limit. It excludes larger historical states if the entity changed, expired or was deleted. " + ATTRIBUTE_LIMITS,
  ),
  "Top content types": explain(
    "Groups active entities by their recorded content-type string to show the most common data formats.",
    ENTITY_SOURCE + " Grouping uses content_type; sizes use payload_size.",
    "Count entities and sum recorded payload sizes within each group. Sort by entity count descending, then content-type string in bytewise order, and return at most 20 groups.",
    ACTIVE_SCOPE + " Entities with zero recorded payload size still contribute to the entity count. An empty content type appears as Unspecified.",
    "The list can omit smaller groups, so displayed rows need not sum to the active totals. Content types are declared metadata, not detected from payload contents. " + PAYLOAD_LIMITS,
  ),
  "Content type": explain(
    "The exact recorded content-type string shared by entities in this row.",
    "entity_versions.content_type on the version valid at the projection block.",
    "Group active entity states by their content_type string. The empty string is displayed as Unspecified; the statistics query does not normalize MIME parameters or detect file types.",
    ACTIVE_SCOPE + " Only the 20 groups with the most active entities are displayed.",
    "A label such as application/json is metadata from decoding or imported state. It does not mean the index inspected or validated JSON payload contents.",
  ),
  "Content-type active entities": explain(
    "The number of active projected entities belonging to this particular content-type group.",
    "COUNT(*) grouped by entity_versions.content_type for active selected versions.",
    "Each active entity contributes once to its recorded content type, including entities with a zero recorded payload size.",
    ACTIVE_SCOPE + " Rows are ranked by this count; ties use bytewise content-type order.",
    "This is a per-group count, not the whole-page Active entities total. Only 20 groups are returned, so adding the visible rows may omit less common content types.",
  ),
  "Recorded payload bytes": explain(
    "The active recorded payload-size total for this content-type group.",
    "SUM(entity_versions.payload_size) grouped by content_type, using active selected versions.",
    "Add one recorded payload size per active entity in the group. The byte-unit selector controls display; a zero size contributes zero.",
    ACTIVE_SCOPE + " Only the 20 groups selected by entity count are displayed; they are not ranked by total bytes.",
    PAYLOAD_LIMITS + " The visible group totals may not sum to the all-content-types total.",
  ),
  "Coverage and measurement limitations": explain(
    "Explains which conclusions the stored data can support and where coverage or measurement is incomplete.",
    "The limitations array supplied with the statistics worker's snapshot, plus the source-specific rules in each info tooltip.",
    "Open this section to read the caveats. Zero is an observed empty sum/count where applicable; Unavailable or Unknown means the required state or denominator is absent.",
    "Block, detailed transaction, decoded operation and entity projection coverage can differ. A complete block percentage does not certify completeness of every other dataset.",
    "The index deliberately stores no payload contents. Full signed-transaction sizes, exact live entity counts while behind, unique provider storage and exact encoded attribute bytes cannot be established by these statistics.",
  ),
} satisfies Record<string, StatisticsExplanation>;

export type StatisticsHelpKey = keyof typeof STATISTICS_HELP;

const OPERATION_DETAILS: Record<number, [string, string]> = {
  1: ["Create attempts that ask Arkiv to allocate a new entity.", "Successful creates count even when old decoder history did not retain the assigned entity key. Imported genesis entities contribute no create operation, and a later deletion does not remove a historical create count."],
  2: ["Update/patch attempts that modify an existing entity's attributes or payload metadata.", "Repeated updates to the same entity count repeatedly. This is not the number of changed attributes, distinct updated entities, or entities whose current state differs from their initial state."],
  3: ["Expiry-extension attempts for existing entities.", "A successful extension counts as an operation, not as the number of extra blocks of lifetime. It does not guarantee that the entity is still active at the current projection block."],
  4: ["Ownership-transfer attempts for existing entities.", "Each successful transfer operation contributes once; this does not count distinct owners or distinct entities transferred. Later transfers do not remove earlier ones from the total."],
  5: ["Explicit delete attempts for existing entities.", "The Successful column counts delete operations, not all entities currently inactive. Passive expiry is separate, and the projected Deleted entities count can also include expire/prune tombstones."],
};

export function operationExplanation(type: number): StatisticsExplanation {
  const detail = OPERATION_DETAILS[type];
  return explain(
    detail?.[0] ?? `Decoded attempts with operation type ${type}, which this UI does not name.`,
    OP_SOURCE,
    `Count operation rows with operation_type = ${type}, separately for status 1, status 0, and missing/other status.`,
    "All stored attempts of this kind contribute to their respective outcome columns, with one count per operation row. A single transaction may contribute several operations.",
    `${detail?.[1] ?? "The decoder emitted this type, but its semantic meaning is not defined by this UI."} ${OP_LIMITS}`,
  );
}

const ATTRIBUTE_MEANINGS: Record<number, string> = {
  1: "Boolean values (true or false).", 2: "Signed 32-bit integer values.",
  3: "Unsigned 64-bit integer values.", 4: "Unsigned 256-bit integer values.",
  5: "Fixed-point decimal values stored with 18 fractional places.", 6: "Fixed-length 32-byte values.",
  7: "Variable-length byte values; this system type is normally unsupported by the attribute projector.",
  8: "String values.", 9: "20-byte address values.", 10: "32-byte entity-key values.",
};

export function attributeExplanation(typeId: number, name: string): StatisticsExplanation {
  return explain(
    `The number of ${name} attribute entries on active entities. ${ATTRIBUTE_MEANINGS[typeId] ?? "This is an unrecognized stored type ID."}`,
    `${ATTRIBUTE_SOURCE} Each entry carries a numeric typeId; this tile uses typeId ${typeId}.`,
    "Expand the selected active entities' attribute arrays and count entries with this type ID. An entity with several attributes of this type contributes several counts.",
    ACTIVE_SCOPE + " Types with no entries are not returned as tiles. An update that changes an attribute's type moves its current entry to the new type.",
    ATTRIBUTE_LIMITS + " The same name or value on different entities is counted separately. This is not the count of entities using the type.",
  );
}
