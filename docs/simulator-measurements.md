# Native simulator integration measurements

Measured on 2026-09-24 with the real release Rust producer, its retained redb history, the strict TypeScript feed reader, and independent PostgreSQL projections. These results exercise the bounded metadata profile described in [the integration plan](simulator-integration-plan.md) and [run guide](simulator-run.md).

## Method and limits

The machine ran Ubuntu 26.04.1 / Linux 7.0.0-31-generic, x86-64 Intel i9-13900, 32 logical CPUs, Bun 1.4.0, and PostgreSQL 17.11 (`postgres:17-alpine`). The release producer used an **ext4** directory under `/home/ubuntu/.cache/arkiv-simulator-measurements`; PostgreSQL used a Docker local volume on ext4. The earlier debug experiment used tmpfs and is exploratory only. The release executable for this run was SHA-256 `abddcd684e6d5c109f4cc8da94f4a500f16e5f160321c0aa665a64223bce9910`.

The workload was version 1, seed 7, 1,000 ms logical block period, 64-byte unindexed field payloads, zero extra rows per block, and an 8 MiB configured engine cache. The producer stayed paused; 10,000 sequential idempotent `step` commands created ordinary blocks, without signatures. There are 10,001 retained feed blocks including genesis. The base workload deliberately includes empty blocks, typed attribute changes, rollback, deletion/recreation, expiry and namespace ownership transfer; it is not a saturated transaction throughput benchmark.

A single streaming consumer then ingested the complete history into one empty PostgreSQL schema. It rebuilt the same history into a second independent empty schema. It held one bounded feed block at a time and never accumulated a historical block array. Separate fresh Bun processes opened each schema at heights 100, 1,000 and 10,000. Both schemas were dropped afterwards. The producer was stopped; its authoritative ext4 file was retained for the separate cold-open and light-client checks.

“Cold” means a **new process with warm operating-system and PostgreSQL caches**, not a dropped disk page cache. PostgreSQL cold timings cover `SimulatorStorage.open` plus one progress read, including its fixed schema/version checks; they exclude HTTP server startup, authentication storage, and the scanner's one additional startup health-fence point read. Statement counts include DDL identity checks and point reads. Feed byte counts are decoded HTTP metadata bytes, excluding transport headers. The timing includes JSON parsing, canonical header/feed-digest validation, SQL ingestion and the checkpoint child processes. Other validation ran on the shared host, so these single-run numbers are evidence of bounded work, not latency or throughput guarantees.

RSS and post-GC JavaScript heap are distinct. The heap measurement follows `Bun.gc(true)`; RSS includes allocator/runtime retention and native allocations. The raw `resourceUsage().maxRSS` field includes process lifetime and can inherit fork-before-exec high-water usage in cold child processes; it must not be interpreted as isolated startup allocation. OS file cache, PostgreSQL server memory and individual allocator/decode attribution are not measured by the indexer process RSS. No constant-RSS claim is made.

## Release producer and PostgreSQL results

The producer created 10,000 blocks in **16.758 s**, ending with an **87,887,872-byte** redb file and **28,144 KiB** process RSS. It retained every block and snapshot. The engine reported one resident manifest, 16,384 cache entries and 2,286,993 cached object payload bytes at the published head.

| Pass | Height | Cumulative seconds | Feed reads | Feed bytes | SQL statements | Indexer RSS MiB | Post-GC JS MiB | Fresh PG open ms | Fresh PG statements |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| catch-up | 100 | 0.580 | 101 | 183,269 | 1,280 | 71.50 | 4.12 | 14.62 | 24 |
| catch-up | 1000 | 3.893 | 1,001 | 1,818,412 | 12,665 | 77.61 | 4.47 | 26.86 | 24 |
| catch-up | 10000 | 48.467 | 10,001 | 18,222,009 | 126,515 | 93.78 | 4.39 | 18.41 | 24 |
| rebuild | 100 | 0.340 | 101 | 183,269 | 1,280 | 94.53 | 4.34 | 19.44 | 24 |
| rebuild | 1000 | 2.540 | 1,001 | 1,818,412 | 12,665 | 97.70 | 4.60 | 15.22 | 24 |
| rebuild | 10000 | 57.024 | 10,001 | 18,222,009 | 126,515 | 107.36 | 4.39 | 18.83 | 24 |

Each pass read **18,222,009 metadata bytes** in exactly **10,001** bounded block reads and executed **126,515** ingestion SQL statements. Catch-up completed in **48.467 s**, rebuild in **57.024 s**. PostgreSQL table/index/TOAST totals were **47,243,264** and **47,284,224** bytes; these totals exclude WAL and server shared buffers. Both projections ended at exactly the same block hash, state root and counters:

- Height `10000`, block hash `0x6c7fef75220b8e248d63095cacc18967e7cc93008e9799aa3ee0380533e123c0`.
- State root `0xc1cf8d2be2283cc0258fd72da84ee1b6060ecc0a82c31a4018cecb518e2b2ecf`.
- 10,001 blocks, 7,501 transactions, 8,502 operation outcomes, 1,572,296 abstract execution units, 3,000 live records, two namespaces, zero live raw entries.

Fresh PG startup stayed at **24 statements** across all three history sizes and both passes. Fresh process RSS was 55.85–58.00 MiB with approximately 3.8 MiB post-GC JS heap. The streaming process retained approximately 4.39 MiB of post-GC JS heap at the end of both 10,000-block passes; RSS grew from 93.78 to 107.36 MiB between those checkpoints. This supports bounded retained application state, with visible runtime/allocator retention rather than a claim of flat total memory.

## Fresh retained node open

After stopping the release producer, `arkiv-simulator inspect --unsigned-simulator --run-dir <printed-directory>` reopened height 10,000 with **15 bounded record reads, one head read and zero trie-object reads**. It retained one manifest, zero cache entries and zero cached payload bytes; redb reported `fullRepair=false`. Fresh process RSS / high-water RSS were 6,900 KiB. These logical counters cover `Host::open` after the adapter open; they do not count backend filesystem page reads. No historical execution replay or trie-state load was needed.

```json
{"cacheEntries":0,"cachePayloadBytes":0,"coldHeadReads":1,"coldObjectReads":0,"coldRecordReads":15,"fileBytes":87887872,"fullRepair":false,"genesisHash":"0x859817c2c095092cab7666b80d0fb0df7c61fc7ff840b0a070c35be7246d2b9d","height":"10000","processMemory":["VmHWM:\t    6900 kB","VmRSS:\t    6900 kB"],"residentManifests":1,"role":"full","runId":"b57851189e98486c525c3a4371de3b4d","sourceId":"00000000-0000-4000-8000-000000000001"}
```

## Release light header synchronization and reopen

A fresh release light client synchronized the same retained height-10,000 source in **1.620 s**. Its header database was **4,214,784 bytes**, and process RSS / high-water RSS were **14,100 KiB**. A recording proxy observed one genesis request and 161 header-page requests (including idle polling), with **zero body or metadata-feed requests** during synchronization. A subsequent Eq query verified one row from a 2,500-record posting and returned a continuation, against the locally trusted simulator root. These roots remain unsigned and have no consensus authentication.

A separate fresh light process reopened with **one head read, five bounded record reads, zero trie-object reads**, one retained header, zero continuations and **6,448 KiB** RSS / high-water RSS. Redb reported `fullRepair=false`. This was a single release run with warm OS caches; retained header count is structural evidence, not allocator sampling. Both measurement child processes were stopped. No source history was regenerated for this check.

<details>
<summary>Complete release light synchronization and reopen result</summary>

```json
{
  "sourceDirectory": "/home/ubuntu/.cache/arkiv-simulator-measurements/arkiv-sim-metadata-experiment-4tNNCt",
  "lightDirectory": "/home/ubuntu/.cache/arkiv-simulator-measurements/arkiv-sim-light-release-78veyxhh",
  "sync": {
    "seconds": 1.6196922200033441,
    "processMemory": [
      "VmHWM:\t   14100 kB",
      "VmRSS:\t   14100 kB"
    ],
    "fileBytes": 4214784,
    "requests": {
      "/sim/v1/genesis": 1,
      "/sim/v1/headers": 161
    },
    "head": {
      "hash": "0x6c7fef75220b8e248d63095cacc18967e7cc93008e9799aa3ee0380533e123c0",
      "height": "10000",
      "stateRoot": "0xc1cf8d2be2283cc0258fd72da84ee1b6060ecc0a82c31a4018cecb518e2b2ecf"
    },
    "proof": {
      "rows": 1,
      "continuationPresent": true,
      "postingCount": 2500,
      "verification": "proof verified against trusted simulator root; unsigned source"
    },
    "requestsAfterProof": {
      "/sim/v1/genesis": 1,
      "/sim/v1/headers": 162,
      "/sim/v1/query/eq": 1
    }
  },
  "reopen": {
    "coldHeadReads": 1,
    "coldObjectReads": 0,
    "coldRecordReads": 5,
    "continuations": 0,
    "fileBytes": 4214784,
    "fullRepair": false,
    "genesisHash": "0x859817c2c095092cab7666b80d0fb0df7c61fc7ff840b0a070c35be7246d2b9d",
    "height": "10000",
    "processMemory": [
      "VmHWM:\t    6448 kB",
      "VmRSS:\t    6448 kB"
    ],
    "residentHeaders": 1,
    "role": "light",
    "runId": "b57851189e98486c525c3a4371de3b4d",
    "sourceId": "00000000-0000-4000-8000-000000000001"
  },
  "notes": [
    "Single release run; OS page cache not evicted.",
    "RSS/HWM is whole-process memory; retained header count is structural, not allocator sampling.",
    "No production or source regeneration; producer reopened paused at retained height10000."
  ]
}
```

</details>

## Historical correctness and failure evidence

`src/simulator/fixtures/native-history-v1.json` is a small Rust-produced genesis/first-two-block golden. Both languages pin the tagged binary feed codec and its hash independently of JSON object insertion order. The longer actual Rust trace at heights 0–40 was tested against `testOracle.ts`, a separate logical implementation of the documented twenty-slot lifecycle that does not derive expected rows from feed changes. Every retained snapshot, namespace ownership/revision, record incarnation, expiry and typed equality result matched. Eq pagination used sizes 1, 3 and 64 for `u64(1)`, `u64(2)` and `str("1")`, including reopen and duplicate replay. Synthetic PostgreSQL fixtures additionally cover raw updates/deletes, namespace isolation, exact u64/i64 extremes, embedded-NUL UTF-8 attributes and cursor pinning while the head advances.

The real PostgreSQL fault suite executes a mixed block with namespace creation/transfer, record patch/delete/recreation and raw update/delete. It forces rollback **after each of all 33 DML/notification statements**, and again after the transaction callback immediately before COMMIT. Exact dumps of all eight state tables remain unchanged and no notifications escape; the eventual successful retry emits one notification. A separate case terminates the actual transaction backend connection with `pg_terminate_backend`. Another lets COMMIT complete and then loses the caller response: reopening finds the committed head, and an exact retry is a duplicate with unchanged counters. A truncated chunked HTTP feed retries the same uncommitted height. Permanent identity/version/conflict health survives scanner restart, even if the peer later becomes consistent; a persisted transient source failure can resume. Operator recovery from a permanent fence requires a reviewed new native projection schema/run and rebuilding the metadata, with no public clear-fence endpoint. Authentic stale source prefixes are retriable availability faults; mismatched known hashes are conflicts; missing covered blocks are corruption, not empty results.

Final backend acceptance command (explicit disposable test database, no `.env` loading):

```sh
TEST_DATABASE_URL="$ISOLATED_TEST_DATABASE_URL" \
TEST_SIMULATOR_FIXTURE=/tmp/arkiv-simulator-fixtures.json \
bun --no-env-file test src
bunx --no-install tsc --noEmit
git diff --check
```

Result: **903 passed, zero failed**, 5,648 assertions across 55 backend files. The long cross-language oracle is opt-in through `TEST_SIMULATOR_FIXTURE`; ordinary tests need neither a node nor a database. The HTTP/OAuth control tests cover administrator role, exact Origin and CSRF, temporary-token owner checks, lost control responses, and bounded request/response handling. These are unsigned simulator tests; metadata digest validation and SQL query results do not provide consensus authentication or complete proof verification.

## Reproduction

Build `arkiv-simulator` in release mode in the Rust node repository. Point `TEST_DATABASE_URL` at a disposable PostgreSQL instance. Use a real disk directory explicitly if `/tmp` is tmpfs:

```sh
mkdir -p "$DISK_SCRATCH_DIRECTORY"
TEST_DATABASE_URL="$ISOLATED_TEST_DATABASE_URL" \
SIMULATOR_EXPERIMENT_BINARY="$NODE_REPOSITORY/target/release/arkiv-simulator" \
SIMULATOR_EXPERIMENT_DIRECTORY_ROOT="$DISK_SCRATCH_DIRECTORY" \
bun --no-env-file src/simulator/experiment.ts > simulator-measurements.jsonl
```

The runner uses loopback ports 19640/19641 by default (`SIMULATOR_EXPERIMENT_PORT` changes the base), creates private random control credentials without printing them, creates isolated `sim_measure_*` schemas and removes them on completion. `SIMULATOR_EXPERIMENT_BLOCKS` can shorten an exploratory run; acceptance used 10,000. It leaves the printed producer directory for read-only inspection after stopping its child. The run identity and scratch paths in the raw trace below are test identities, not deployment configuration.

## Raw release run

<details>
<summary>Complete producer and PostgreSQL JSON Lines</summary>

```jsonl
{"phase":"start","directory":"/home/ubuntu/.cache/arkiv-simulator-measurements/arkiv-sim-metadata-experiment-4tNNCt","producerPid":953253,"blocks":10000,"identity":{"sourceId":"00000000-0000-4000-8000-000000000001","runId":"b57851189e98486c525c3a4371de3b4d","genesisHash":"0x859817c2c095092cab7666b80d0fb0df7c61fc7ff840b0a070c35be7246d2b9d","chainId":"9001"},"workload":{"version":1,"seed":"7","blockPeriodMs":"1000","payloadBytes":64,"extraRowsPerBlock":0},"memory":{"rssBytes":59314176,"postGcRssBytes":60100608,"heapUsedBytes":3630581,"peakRssBytes":60100608}}
{"phase":"produce","height":100,"elapsedMs":79.39849399999999,"producerStatus":["VmHWM:\t   10176 kB","VmRSS:\t   10176 kB"],"fileBytes":1224704}
{"phase":"produce","height":1000,"elapsedMs":864.4268569999999,"producerStatus":["VmHWM:\t   19216 kB","VmRSS:\t   19216 kB"],"fileBytes":10989568}
{"phase":"produce","height":2000,"elapsedMs":2323.240172,"producerStatus":["VmHWM:\t   24396 kB","VmRSS:\t   24396 kB"],"fileBytes":21975040}
{"phase":"produce","height":3000,"elapsedMs":4164.467797,"producerStatus":["VmHWM:\t   26556 kB","VmRSS:\t   26556 kB"],"fileBytes":43945984}
{"phase":"produce","height":4000,"elapsedMs":6079.812043000001,"producerStatus":["VmHWM:\t   27080 kB","VmRSS:\t   27080 kB"],"fileBytes":43945984}
{"phase":"produce","height":5000,"elapsedMs":8100.092946,"producerStatus":["VmHWM:\t   27560 kB","VmRSS:\t   27560 kB"],"fileBytes":43945984}
{"phase":"produce","height":6000,"elapsedMs":9894.746213,"producerStatus":["VmHWM:\t   27620 kB","VmRSS:\t   27620 kB"],"fileBytes":87887872}
{"phase":"produce","height":7000,"elapsedMs":11640.841640999999,"producerStatus":["VmHWM:\t   27712 kB","VmRSS:\t   27712 kB"],"fileBytes":87887872}
{"phase":"produce","height":8000,"elapsedMs":13379.647746999999,"producerStatus":["VmHWM:\t   27776 kB","VmRSS:\t   27776 kB"],"fileBytes":87887872}
{"phase":"produce","height":9000,"elapsedMs":15000.635409999999,"producerStatus":["VmHWM:\t   28080 kB","VmRSS:\t   28080 kB"],"fileBytes":87887872}
{"phase":"produce","height":10000,"elapsedMs":16758.46989,"producerStatus":["VmHWM:\t   28144 kB","VmRSS:\t   28144 kB"],"fileBytes":87887872}
{"phase":"catch-up","height":100,"elapsedMs":579.8278479999972,"feedMs":104.08032400002048,"feedReads":101,"feedBytes":183269,"statements":1280,"memory":{"rssBytes":74977280,"postGcRssBytes":74977280,"heapUsedBytes":4325000,"peakRssBytes":79654912},"coldOpen":{"height":"100","openMs":14.619176000000003,"statements":24,"memory":{"rssBytes":59596800,"postGcRssBytes":60383232,"heapUsedBytes":3987060,"peakRssBytes":79392768}}}
{"phase":"catch-up","height":1000,"elapsedMs":3892.9323640000002,"feedMs":764.3162859999939,"feedReads":1001,"feedBytes":1818412,"statements":12665,"memory":{"rssBytes":81375232,"postGcRssBytes":81375232,"heapUsedBytes":4687982,"peakRssBytes":84070400},"coldOpen":{"height":"1000","openMs":26.859394,"statements":24,"memory":{"rssBytes":58568704,"postGcRssBytes":59940864,"heapUsedBytes":3985258,"peakRssBytes":84070400}}}
{"phase":"catch-up","height":10000,"elapsedMs":48466.798968999996,"feedMs":5919.410455000187,"feedReads":10001,"feedBytes":18222009,"statements":126515,"memory":{"rssBytes":98336768,"postGcRssBytes":98336768,"heapUsedBytes":4602062,"peakRssBytes":101740544},"coldOpen":{"height":"10000","openMs":18.411404000000005,"statements":24,"memory":{"rssBytes":59584512,"postGcRssBytes":60633088,"heapUsedBytes":3986413,"peakRssBytes":101740544}}}
{"phase":"catch-up-complete","progress":{"height":"10000","hash":"0x6c7fef75220b8e248d63095cacc18967e7cc93008e9799aa3ee0380533e123c0","observed":{"head":{"hash":"0x6c7fef75220b8e248d63095cacc18967e7cc93008e9799aa3ee0380533e123c0","height":"10000","stateRoot":"0xc1cf8d2be2283cc0258fd72da84ee1b6060ecc0a82c31a4018cecb518e2b2ecf"},"role":"producer","runId":"b57851189e98486c525c3a4371de3b4d","health":"paused","limits":{"pageItems":64,"feedPageBytes":"4194304"},"memory":{"engineCacheBytes":"2286993","residentManifests":1,"engineCacheEntries":16384},"paused":true,"chainId":"9001","coverage":{"from":"0","through":"10000","complete":true},"sourceId":"00000000-0000-4000-8000-000000000001","workload":{"seed":"7","version":1,"payloadBytes":64,"blockPeriodMs":"1000","extraRowsPerBlock":0},"apiVersion":1,"durability":"durable","sourceKind":"arkiv-native-simulator","feedVersion":1,"genesisHash":"0x859817c2c095092cab7666b80d0fb0df7c61fc7ff840b0a070c35be7246d2b9d","proofProfiles":["eq-page-v1"],"authentication":"unsigned-simulator-v1","configRevision":"0","protocolVersion":2,"projectionVersion":1,"blockFormatVersion":1,"observedPeerHeight":"10000"},"blocks":"10001","transactions":"7501","operations":"8502","spentUnits":"1572296","liveRecords":"3000","namespaces":"2","rawRecords":"0","health":"running"},"pgRelationBytes":"47243264","memory":{"rssBytes":98336768,"postGcRssBytes":98336768,"heapUsedBytes":4558459,"peakRssBytes":101740544}}
{"phase":"rebuild","height":100,"elapsedMs":340.3780840000036,"feedMs":48.4749200000515,"feedReads":101,"feedBytes":183269,"statements":1280,"memory":{"rssBytes":99123200,"postGcRssBytes":99123200,"heapUsedBytes":4546847,"peakRssBytes":101740544},"coldOpen":{"height":"100","openMs":19.43983500000001,"statements":24,"memory":{"rssBytes":59797504,"postGcRssBytes":60846080,"heapUsedBytes":3986757,"peakRssBytes":101740544}}}
{"phase":"rebuild","height":1000,"elapsedMs":2539.7714189999897,"feedMs":490.864921000044,"feedReads":1001,"feedBytes":1818412,"statements":12665,"memory":{"rssBytes":102440960,"postGcRssBytes":102703104,"heapUsedBytes":4819182,"peakRssBytes":103714816},"coldOpen":{"height":"1000","openMs":15.218547999999998,"statements":24,"memory":{"rssBytes":60813312,"postGcRssBytes":61599744,"heapUsedBytes":3984249,"peakRssBytes":103714816}}}
{"phase":"rebuild","height":10000,"elapsedMs":57024.302842,"feedMs":5331.343770999767,"feedReads":10001,"feedBytes":18222009,"statements":126515,"memory":{"rssBytes":112574464,"postGcRssBytes":112574464,"heapUsedBytes":4605748,"peakRssBytes":112803840},"coldOpen":{"height":"10000","openMs":18.831742000000006,"statements":24,"memory":{"rssBytes":59539456,"postGcRssBytes":61112320,"heapUsedBytes":3985267,"peakRssBytes":112803840}}}
{"phase":"rebuild-complete","progress":{"height":"10000","hash":"0x6c7fef75220b8e248d63095cacc18967e7cc93008e9799aa3ee0380533e123c0","observed":{"head":{"hash":"0x6c7fef75220b8e248d63095cacc18967e7cc93008e9799aa3ee0380533e123c0","height":"10000","stateRoot":"0xc1cf8d2be2283cc0258fd72da84ee1b6060ecc0a82c31a4018cecb518e2b2ecf"},"role":"producer","runId":"b57851189e98486c525c3a4371de3b4d","health":"paused","limits":{"pageItems":64,"feedPageBytes":"4194304"},"memory":{"engineCacheBytes":"2286993","residentManifests":1,"engineCacheEntries":16384},"paused":true,"chainId":"9001","coverage":{"from":"0","through":"10000","complete":true},"sourceId":"00000000-0000-4000-8000-000000000001","workload":{"seed":"7","version":1,"payloadBytes":64,"blockPeriodMs":"1000","extraRowsPerBlock":0},"apiVersion":1,"durability":"durable","sourceKind":"arkiv-native-simulator","feedVersion":1,"genesisHash":"0x859817c2c095092cab7666b80d0fb0df7c61fc7ff840b0a070c35be7246d2b9d","proofProfiles":["eq-page-v1"],"authentication":"unsigned-simulator-v1","configRevision":"0","protocolVersion":2,"projectionVersion":1,"blockFormatVersion":1,"observedPeerHeight":"10000"},"blocks":"10001","transactions":"7501","operations":"8502","spentUnits":"1572296","liveRecords":"3000","namespaces":"2","rawRecords":"0","health":"running"},"pgRelationBytes":"47284224","memory":{"rssBytes":112574464,"postGcRssBytes":112574464,"heapUsedBytes":4556433,"peakRssBytes":112803840}}
{"phase":"finished","directory":"/home/ubuntu/.cache/arkiv-simulator-measurements/arkiv-sim-metadata-experiment-4tNNCt","producerStopped":true,"schemasDropped":2}
```

</details>
