# Proposal: bootstrap the explorer from a retained genesis index artifact

Status: proposed, 2026-10-15. This document adds no runtime behavior or supported configuration.

A seeded chain contains entities at block zero without creation transactions. Restoring its
execution database makes those entities available to the node, but the explorer's block scanner
cannot reconstruct them. The default one-million-entity RPC import cap deliberately leaves larger
datasets waiting for an offline import.

The proposal is to prepare the explorer's genesis data once, publish it alongside the retained
initial chain snapshot, and bootstrap an empty explorer from that immutable artifact. The indexer
owns the format and commands. The manager wires pinned images, storage, credentials and references.

## Fit with the accepted prefill architecture

[db-chain-mgr #484](https://github.com/Arkiv-Network/db-chain-mgr/pull/484) imports execution state
once and publishes the initial EL snapshot. Nodes use snapshot bootstrap for creation, recovery
and external joining. Its reviews require component code to stay in its owning repository and
seeded networks to retain ordinary recovery capabilities.

This proposal follows those boundaries:

- `arkiv-chain-indexer` builds and restores the entity artifact through public commands in its
  released app image. No indexer SQL or importer implementation is embedded in the manager.
- `arkiv-prefill` coordinates artifact production with the existing seed pipeline. It does not
  import internal indexer modules or incorporate Bun into the ordinary generator image.
- `db-chain-mgr` invokes the pinned component images and records an immutable artifact reference.
  The ordinary generator retains its current ownership of network identity and credentials.
- Chain bootstrap remains the existing EL snapshot path. Explorer import has its own progress
  and failure state; an explorer failure does not regenerate genesis or prevent chain recovery.

The earlier [indexer #107](https://github.com/Arkiv-Network/arkiv-chain-indexer/pull/107) proposed
exporting PostgreSQL entity tables. It was closed without recorded review feedback. This proposal
retains the build-once/bootstrap model, but starts with a portable entity artifact rather than a
physical Postgres datadir or a copy of an application database.

## Artifact contract

Proposed protocol 1 is a manifest plus independently compressed, bounded JSONL shards of genesis
entity metadata. Records carry the original entity id, key, owner, creator, expiry, creation flags,
content type, payload size and typed attributes needed to reproduce the existing dump import.
Preserve integer precision and permanent-expiry semantics. Include no payload bytes, transaction
history, authentication tables, sessions or database credentials.

The exporter streams the existing `state.jsonl` using the indexer's parser and validates the same
entity count and id-to-key ordering ledger used by `importGenesisState.ts`. It measures payloads
without retaining them. It publishes no complete manifest until validation succeeds. This does
not require a temporary Postgres server or a scanner in the generator pod.

The manifest records:

- Protocol version, record-schema version and producer image digest.
- Chain id, execution genesis hash, block-zero state root and genesis-file checksum. The execution
  hash must be obtained from a validated execution genesis; a file checksum is not a block hash.
- Total entity and attribute counts, and the genesis projection boundary (block zero).
- An ordered shard list: immutable object key, compressed SHA-256 and byte size, expanded size,
  entity count, and first/last entity id. Shards preserve the node's entity-id ordering.

Readers declare supported protocol/schema versions in indexer-owned compatibility metadata.
Do not hard-code an indexer release in the manager. Unknown formats fail before database mutation;
normal indexer migrations own the target tables. A metadata format avoids coupling the artifact to
Postgres storage files or binary COPY types. The restore command may still use COPY internally
where supported, without making that representation the public contract.

Publish into the retained genesis run, using content-addressed object names. Follow the initial
snapshot's privacy policy and use its existing secret-delivery mechanism. Public manifests contain
references, never credentials. Explicitly preserve the artifact during pruning and carry it through
network archival/recovery; do not rely on an incidental prefix regex.

## Production and publication

Add an indexer export container, pinned to the network's indexer app image, beside the existing
prefill runtime and generator. The manager supplies only command arguments, environment, mounts
and resources; the indexer repository implements the command. Its protocol is also runnable in
Compose or as a standalone container.

1. The prefill runtime exposes the completed dump and its original seeder manifest on shared
   scratch, with an atomic completion signal. Today the runtime builds in a temporary directory
   and publishes a different `prefill-state.json`; preserving the dump until export acknowledges
   it, and retaining the original entity-count manifest, are explicit implementation changes.
2. The exporter reads the completed dump and writes validated shards and a local descriptor.
   The runtime's existing publication component uploads them using snapshot credentials. The
   exporter needs no Kubernetes, mnemonic or object-storage credentials.
3. Publish all objects first, verify them, then publish an immutable explorer descriptor last.
   Reference it by key and digest in a versioned genesis-artifact catalog associated with the
   retained initial snapshot. Define and test that optional catalog extension with the manager;
   do not assume existing snapshot readers accept arbitrary new `layers` entries.
4. Persist the resolved descriptor reference in network metadata/registry. Bootstrap must not
   discover the genesis artifact via rolling `latest.json`, which later points to chain backups.

EL publication and chain start do not wait for explorer export. Export completion updates its own
status/reference; upload failure retries from retained export output without re-seeding the chain.
The worker/controller protocol must distinguish chain readiness from exporter completion and keep
scratch until export succeeds or the operator explicitly abandons it. A failed exporter container
must not trigger an unguarded replay of successful generator work on a replacement pod.

For a network created with the indexer disabled, retain enough seed identity and source references
for a later export job. Enabling the indexer can trigger that job from the published dump; it must
not require access to an expired generator scratch directory.

## Explorer bootstrap

The explorer's Postgres listens on loopback. Run the restore command from the pinned app image
as an additional regular container inside `indexer-0`, connecting to the same local database.
Its component-owned wrapper waits after success and checks durable state after restarts. It is
not an init container waiting for the backend: that would prevent the backend from starting.

The backend starts normally and creates/migrates its schema. For a declared artifact, it keeps
genesis entity projection/query readiness pending until bootstrap and repair finish. Scanner
block ingestion can continue. An HTTP health check alone does not certify a complete entity index.

The restore command:

1. Waits for schema readiness and validates artifact identity against the network declaration,
   stored scanner identity and the node's block-zero hash/root/count. An unavailable node means
   waiting; a mismatch means refusal, with no reset of existing data.
2. Acquires the existing fold lock, coordinates through `genesis_import`, and loads into private
   staging tables. The new snapshot source must be integrated with the projector's state machine;
   it cannot be implemented merely by setting an environment variable in today's backend.
3. Downloads one bounded shard at a time, verifies digest/length before use, and commits its rows
   and checkpoint in one transaction. An interrupted shard rolls back; completed shards are not
   appended again. Checkpoints bind the manifest digest and shard identity. Never resume arbitrary
   compressed streams or binary COPY at an assumed row offset.
4. Validates counts and ids, builds required indexes, and atomically installs the genesis base
   under the fold lock. In the first release this is allowed only when entity tables are empty;
   a compatible already-complete import is a no-op, and a nonempty incompatible index is refused.
5. Hands control to the backend's existing repair mechanism for already-scanned operations.
   Only completed repair marks the entity index ready; importer exit zero alone is insufficient.

Restarts must also recover during index construction, atomic installation and repair. Store the
phase and artifact identity in Postgres, not just a pod-local completion marker. Existing restored
databases with matching chain identity and a completed genesis import are accepted even if they
were produced by the dump importer or a database backup, rather than this new bootstrap command.

## Lifecycle and sizing

| Event | Expected behavior |
| --- | --- |
| New seeded explorer | Restore immutable genesis artifact, then project scanned blocks. |
| Pod restart | Keep completed DB; resume an interrupted shard or repair. |
| Lost explorer PVC | Recreate DB, restore genesis artifact, rescan available chain history. |
| Restore existing explorer DB | Validate identity; retain compatible data and progress. |
| Disable / re-enable indexer | Preserve declaration, artifact reference and existing PVC semantics. |
| Chain restore / wipe | Use the resulting execution genesis identity; refuse artifacts for a different identity. |
| External explorer | Same image/commands with local artifact files or authorized download and its own DB. |
| Indexer upgrade | Check artifact format support and run normal DB migrations; no chain regeneration. |

Reconstructing later history requires an RPC source retaining those blocks and receipts. A genesis
artifact alone is not a backup of post-genesis explorer history. If history is unavailable, report
the missing coverage rather than claiming a complete rebuild. A reset onto a different genesis
requires an explicit database replacement; never silently truncate a populated database.

Expose per-network indexer database and importer resource requests/limits through the manager's
validated API, chart and declaration. The current resource overrides cover chain components;
shared environment settings cannot set container limits. Keep scratch separate from database
storage and bounded by the largest shard, not the full raw seed dump.

Measure entity and attribute counts, table/index sizes, peak WAL, staging/index-build space and
peak memory on a representative subset before sizing the full import. Do not reuse synthetic two-attribute-per-entity estimates for Sourcify. No restore
throughput or completion-time guarantee is made by this proposal.

## Delivery and acceptance

1. Indexer PR: protocol/schema, exporter, restore state machine, progress/health integration and
   opt-in Postgres tests. Verify a small artifact produces the same rows and query answers as
   `importGenesisState.ts`, including entity order, permanent expiry and payload sizes.
2. Prefill PR: shared-dump lifecycle, publication protocol, immutable descriptor and retries. Test
   exporter/upload failure without losing the completed chain result or deleting needed scratch.
3. Manager PR: pinned container wiring, catalog/reference persistence, secrets, resources and
   separate explorer conditions. Update `how-it-works.md`, feature parity, security and the ops
   runbook together; document minimum compatible versions instead of accepting ignored settings.
4. Lab acceptance: creation, restart at every import phase, lost PVC, compatible restored DB,
   indexer off/on, chain restore/wipe, private artifacts and an external explorer. Inject truncated
   shards, digest/identity mismatches and unsupported schema versions. Partial data must never be
   reported as a complete index. Compare sampled block-zero queries and subsequent mutations with
   the node, then run a production-scale import with measured resource usage.

Review decisions requested: the portable shard contract, the optional genesis catalog/reference
extension, and independent chain/explorer completion with retained export scratch. Command and
configuration names are intentionally left to the implementation PRs; none are available today.
