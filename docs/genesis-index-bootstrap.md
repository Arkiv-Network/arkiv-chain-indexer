# Managed explorer genesis import

Seeded entities have no creation transactions. The explorer therefore imports the
retained `state.jsonl` and its original seeder manifest after chain initialization,
then projects scanned operations over those genesis versions. Chain genesis and
prefill contain no explorer export stage or new artifact format.

This implements the direction agreed in [proposal #115](https://github.com/Arkiv-Network/arkiv-chain-indexer/pull/115#issuecomment-6339393937).
The manager integration must use the contract below; installing the indexer image
alone does not provision credentials, reference metadata or storage.

## Private artifact reference

Prefill retains a content-addressed dump and the original manifest at
`<dump URI>.manifest.json`, even when the explorer is disabled. Its private
`prefill-state.json` version 1 carries:

| Field | Meaning |
| --- | --- |
| `s3Uri`, `sha256`, `bytes`, optional `versionId` | Exact dump object and byte identity |
| `manifestUri`, `manifestSha256`, `manifestBytes`, optional `manifestVersionId` | Exact original seeder manifest and byte identity |
| `chainId`, `stateRoot`, `entityCount` | Seeded chain identity and block-zero entity count |
| `genesisSha256` | Checksum of the generated execution genesis JSON file; **not** its block hash |

The manager adds the HTTPS storage `endpoint` when supplying this document to the
worker. No credential belongs in this document. Preserve it in the private network
declaration and status; never copy it into public genesis metadata or the registry.
The original seeder sidecar still uses `count`, not `entityCount`.

Both object hashes are verified before decoding. Node validation also compares
chain ID, execution block-zero hash, state root and historical entity count. A
cursor belongs to the exact dump bytes and genesis; it cannot be moved between
artifacts. Successful and failed imports are durable database state, not inferred
from a container exit status.

## Pod wiring

Run `bun run scripts/bootstrapGenesis.ts` from the pinned indexer app image as an
additional regular container beside the backend and scanner. It connects to the
same loopback PostgreSQL and remains running after success. PostgreSQL must be
ready before app containers start; a conventional init container waiting for the
backend would deadlock startup.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Local explorer database, shared with backend/scanner |
| `GENESIS_BOOTSTRAP_RPC` | Archive node used for block-zero identity and count |
| `GENESIS_BOOTSTRAP_REFERENCE` | Private reference file; default `/bootstrap/reference.json` |
| `GENESIS_BOOTSTRAP_SCRATCH` | Download scratch; default `/bootstrap-scratch` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Read-only seed-bucket credential |
| `AWS_REGION` | Storage signing region; default `auto` for R2 |
| `AWS_SESSION_TOKEN` | Optional temporary credential token |
| `SHADOW_RPC_UPSTREAM_API_KEY` | Optional node API key, sent as a header |

Set `ENTITY_INDEX_GENESIS=managed` on the backend. This disables automatic RPC
import and leaves entity reads unavailable while the managed import is pending,
running or failed. Keep the scanner, block APIs and workload readiness independent
of this gate. The scanner continues independently while the backend completes repair and subsequent projection.

Only make the reference file available after the chain is running. An absent
reference, unavailable database/node, or transient download error is retried.
Downloads retry after 120 seconds without response data. They stream to temporary
files, enforce declared lengths and hashes, and
rename verified files atomically. Scratch must hold the full dump plus its small
manifest; it is separate from PostgreSQL data, indexes and WAL. The worker removes
its verified local files after the matching database is durably done. Downloaded payload
bytes never enter PostgreSQL.

The worker checks durable state before downloading. A matching completed import is
reused, including a completed RPC import or restored database with positive chain
and genesis evidence. A running repair is observed without starting another load.
A failed import requires explicit reset. A mismatched or unverifiable existing
identity is refused without replacing data.

Entity reads **fail closed** while genesis import is pending, running, unavailable or failed:
HTTP endpoints return 503 and entity RPC requests report that the index is incomplete,
rather than serving a partial set of entities. The frontend shows import progress from
`/api/health` → `features.entityQueryIndex.readiness` and `genesis.imported` / `genesis.total`.
The banner clears when the index is ready; block scanning and rollout readiness remain independent.

## Completion and recovery

`/health` advertises `features.entityQueryIndex.genesisBootstrapVersion: 1` and exposes
`entityQueryIndex.ready`, `readiness`, and `genesis` progress and
identity. The import command's successful return means either completed-state
reuse or handoff to the backend's repair phase. The manager must observe
`genesis.status == "done"` to complete the import Operation. Index construction is
part of import finalization; an interrupted bulk import must not rebuild partial
indexes synchronously before the backend's HTTP server starts.

Keep `IndexerCurrent` as the existing rollout condition. Report import progress
and a condition such as `IndexerGenesisImported` separately, with its own Operation
and size-based timeout. Do not add genesis completion to Kubernetes pod readiness:
that would indirectly turn the existing 15-minute rollout deadline into an import
deadline.

Every explorer replica has a separate database. Import and observe each ordinal,
including new replicas and replacement PVCs. Aggregate their status rather than
polling the load-balanced Service. Entity reads fail closed per database, and
completion/reset invalidates cached entity responses.

## Explicit reset

`bun run scripts/resetEntityIndex.ts --writers-stopped` clears entity versions,
attributes and index bookkeeping. It preserves scanned blocks, transactions,
logs, authentication tables and sessions. Stop all explorer database writers
before invoking it; the explicit flag acknowledges that operational requirement.
The command uses the importer/reset lock and fences an old import generation.

A full rebuild replaces only explorer database PVCs after stopping writers. Both
reset scopes restart the managed import; ordinary pod startup never clears a
populated database. Cover retained replica claims as well as currently running
copies, so scaling up cannot revive stale data.

Retain the dump/reference through disable/re-enable, soft delete, archive, restore,
and normal backup pruning. Only an explicit purge with discarded backups deletes
the recorded dump/manifest keys. Genesis artifacts do not replace post-genesis
history: execution nodes must preserve historical blocks, receipts and block-zero
state. Resource sizing and production-scale throughput require a measured import;
this implementation promises no fixed completion time.
