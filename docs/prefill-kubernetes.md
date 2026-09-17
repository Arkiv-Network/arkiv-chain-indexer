# Prefilling the entity index of a Kubernetes-hosted network

Status: design, 2026-09-15. Part of the prefilled-testnet proposal in
`arkiv-prefill/docs/testnet-deployment.md`; this page is the indexer's share of it.

## The problem

A chain seeded with [arkiv-prefill](https://github.com/Arkiv-Network/arkiv-prefill) carries its
entities in the block-0 state, where no transaction ever mentions them, so the entity index imports
them once (README, "Genesis entities"). Two sources exist:

- the backend walks the node at block 0 over RPC, up to `ENTITY_INDEX_GENESIS_RPC_LIMIT`
  (1,000,000) entities — each page costs the node O(entities), so this is a path for small seeds;
- `scripts/importGenesisState.ts` streams the seed's `state.jsonl` dump into Postgres, ~3,200
  entities/s on a large host, resumable, the only path that records payload sizes.

In the cluster (db-chain-mgr's chart) the indexer is one pod: Postgres, Redis and the decoder are
loopback-only sidecars, the `db` claim is 20Gi by default, Postgres runs under a 2Gi limit, and
nothing outside the pod can reach its database. The dump is 393 GB for the 100M seed and 39 GB at
10M; there is no claim to put it on, no Job that could reach the database, and at 100M the load
would run for the better part of a day against a database sized for a block scanner. The RPC walk
is capped, and would be hours of O(N) pages even at the cap.

## The proposal: an index snapshot

The pipeline that seeds the chain already runs this indexer beside the node and imports the dump
into it (`arkiv-prefill/docker-compose.indexer.yml`). Once that import is `done`, its result — the
entity index's own tables — is the artifact to ship, not the dump:

```
<network>/<run>/index/manifest.json
<network>/<run>/index/entity_versions.copy.zst
<network>/<run>/index/entity_version_attributes.copy.zst
<network>/<run>/index/entity_index_state.json
```

published under the same prefix as the chain's genesis snapshot (`arkiv-prefill`'s
`scripts/package-snapshot.sh`, on the cluster's public snapshot host) and named from the chain
snapshot's manifest, so one `latest.json` leads to both.

### The export — `scripts/exportEntityIndex.ts`

Runs against a finished index (`entity_index_state.genesis_import.status == done`, and no scanner
writes since: the pipeline's chain is idle), takes the fold lock, and writes each table with
`COPY … TO STDOUT (FORMAT binary)` through zstd, plus the state rows (the genesis document and the
fold cursor) as JSON and a manifest:

```json
{ "tool": "arkiv-chain-indexer", "format": 1, "indexerVersion": "v0.5.9", "schema": 3,
  "chainId": 7733102, "genesisHash": "0x70d9…0279", "stateRoot": "0x1d97…c01b",
  "entities": 28825, "attributeRows": 214460, "foldedThroughBlock": 0,
  "tables": { "entity_versions": { "key": "…/entity_versions.copy.zst", "rows": 28825, "bytes": 1, "sha256": "…" },
              "entity_version_attributes": { "…": "…" } } }
```

`schema` is the entity index's own schema version (the columns and the secondary indexes
`entityIndexStorage.ts` creates); it gates the import. Only the two entity tables and the index's
state rows travel — the block and transaction store re-derives from the chain, which is empty at
genesis anyway.

### The import — in the backend

A third genesis source beside `rpc` and `dump`: `ENTITY_INDEX_GENESIS_SNAPSHOT_URL`, the manifest's
URL (in the chart, `spec.indexer.settings`). At startup, when the index holds no genesis import and
the URL is set, the backend — under the same advisory lock the projector and the dump importer take,
so nothing folds on top of a half-loaded base:

1. fetches the manifest; refuses a chain id, genesis hash (against the node it already probes for
   the genesis) or schema it cannot take; a newer indexer with a migration that changed the two
   tables' shape refuses rather than guessing (the manifest names the release that wrote it);
2. drops the secondary indexes, streams each table through `COPY … FROM STDIN (FORMAT binary)` in
   ranged, resumable fetches, verifying each object's digest and size against the manifest as the
   dump importer verifies its own input;
3. rebuilds the indexes, writes the state rows, and hands the import to the projector's
   `repairing` phase exactly as the dump importer does, so entities with operations already
   scanned are refolded on top of their genesis version;
4. writes the same progress document (`ENTITY_INDEX_GENESIS_PROGRESS_FILE`, `source: "snapshot"`)
   and reports it in `/health` → `features.entityQueryIndex.genesis`, so the prefill watcher, the
   explorer's Data page and the deploy checks read it like any other import.

Restart safety: an import interrupted mid-table resumes from the table's row count (`COPY` is
appended in batches under a savepoint; the state row records the batch), as the dump importer
resumes from its batch. A backend that finds `ENTITY_INDEX_GENESIS_SNAPSHOT_URL` unset behaves as
today.

Why in the backend rather than an init container or a Job: the database is loopback-only, the
schema is created by the backend's own startup, the fold lock is the backend's, and the hand-off to
`repairing` already exists there. The one-shot in `arkiv-prefill`'s compose file is the same shape
from outside the process; in a single pod it belongs inside.

### Sizes

Measured on the Sourcify index: `entity_versions` 44 MB and `entity_version_attributes` 83 MB for
28,825 entities and 214,460 attribute rows — about 1.5 KB per entity row (the `attributes` JSONB
included) and 0.4 KB per attribute row, on disk with indexes. The synthetic seed carries two
attributes per entity: roughly 2.3 KB per entity, 23 GB at 10M, 230 GB at 100M. `COPY` binary
loads at Postgres speed rather than the dump importer's 3,200 rows/s: minutes at 10M, one to two
hours at 100M, index rebuild included — against ~9 hours for the dump on a large host.

The chart's indexer needs, for the 100M seed: `spec.storage.indexerDb` at 400Gi, Postgres far
above its 2Gi limit (the index rebuild and the working set of a 230 GB database), and the backend
above 1Gi while it loads — resource overrides the chart does not offer for the indexer today
(`spec.resources` covers the chain tier). That is on db-chain-mgr's list.

## The alternative: the dump importer in the pod

For seeds up to ~10M the existing importer can run in the cluster with no new indexer code, if the
chart mounts a claim holding the dump into the backend's container and runs
`scripts/importGenesisState.ts --dump /prefill/state.jsonl --rpc http://watchers-el:8545` as an
extra container that idles once `/health` reports `done` (the compose one-shot's loop, verbatim: it
waits for the backend, skips a finished import, resumes an interrupted one). It costs a 40 GB claim
per network at 10M, an hour or more of load against the pod's Postgres, and someone to put the dump
on the claim; at 100M it does not fit. Keep it as the fallback, not the plan.

## What the launch needs from this repository

- `scripts/exportEntityIndex.ts` and the backend's snapshot source, both writing the shared
  progress document; tests against the Postgres test database (`TEST_DATABASE_URL`).
- The `schema` number for the entity index, stamped by `entityIndexStorage.ts` and stored in
  `entity_index_state`, so an artifact can name what it was written against.
- `scripts/compareEntityQuery.ts --at-block 0` as the acceptance check after the restore, as it
  was for the dump path (252 checks, 0 differences on the Sourcify seed).
- README: the third source in "Genesis entities", the new variable in the configuration table.
