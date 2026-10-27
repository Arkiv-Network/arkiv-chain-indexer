# UDC end-to-end harness

Runs this explorer against a throwaway chain of the UDC node
(arkiv-state-db-experiment: user-defined columns, no payload, rent outside gas,
live permanent entities) and checks the index against the node, transaction by
transaction and entity by entity. It is the WP4a harness of the explorer UDC
plan; the indexer, decoder and frontend work (WP1–WP3) is validated with it.

```sh
export NODE_DIR=/home/ubuntu/arkiv-network/arkiv-state-db-experiment      # read only
export ARKIV_PROPOSER_BIN=/home/ubuntu/.cache/arkiv-release-target/release/arkiv-proposer
export ARKIV_SDK_DIR=/path/to/arkiv-sdk-js        # 0.9.0-next, built, test/ installed
export ARKIV_DECODER_IMAGE=arkiv-transaction-decoder:udc-local   # the default
scripts/e2e-udc.sh            # [--keep] [--no-chaos] [--screenshots] [--skip-explorer] ...
```

State, logs and reports go to `UDC_E2E_DIR` (default `~/.cache/arkiv-udc-e2e`):
`manifest.json`, `truth.json`, `verify-report.json`, `compare-<block>.json`,
`logs/*.log`, `screenshots/`. The run tears everything down unless `--keep`.

## What runs

| Step | Tool | Notes |
| --- | --- | --- |
| Devnet | `scripts/udc-devnet.py up` | container `udc-e2e-node`, network `arkiv-udc-e2e`, RPC `127.0.0.1:28545`, private control `127.0.0.1:28546` |
| Explorer | `docker compose -p arkiv-explorer-e2e` | `docker-compose.yml` + `docker-compose.prefill.yml`, backend `127.0.0.1:13101`, frontend `127.0.0.1:23661` |
| Traffic | node `udc-sdk-smoke.ts exercise`, SDK `network-health.test.ts`, `scripts/udcExplorerTraffic.ts` | a decoder outage and a scanner restart happen during the traffic (`--no-chaos` skips them) |
| Verify | `scripts/verifyUdcExplorer.ts` | waits for the index to reach the traffic's last block (`E2E_INDEX_TIMEOUT`, 600 s) |
| Compare | `scripts/compareEntityQuery.ts` | node vs `/shadow-rpc/experimental` at block 0, mid-run, the first block past the expiry, and the end |
| Bytes | `pg_dump` grep | no bytes content (traffic markers as text, hex or base64; the prefill's bodies) may be in Postgres |
| Screens | `scripts/udcE2eScreenshots.ts` | `--screenshots`; needs `bun install` and `bunx playwright install chromium` here |

The explorer env (`UDC_E2E_DIR/explorer.env`) points both RPC URLs at
`http://udc-e2e-node:8545`, sets `ENTITY_INDEX_GENESIS=auto`,
`SAVE_TRANSACTION_DATA=true`, `ENTITY_QUERY_INDEX=true`, backfill from block 0, a
dummy `RPC_PROXY_UPSTREAM`, and keeps the genesis progress file inside the
container (`/tmp`) so nothing root-owned lands in the state dir.

## The devnet

`udc-devnet.py up | status | down [--purge]` builds a genesis bundle from the
node repo's UDC smoke fixture, imported from `NODE_DIR/scripts/genesis-bundle-smoke.py`
and edited exactly as `udc-sdk-smoke.py` edits it: chain 9405, three prefilled
entities with bytes bodies, 500 ms blocks, a 200,000-unit per-block storage cap.
On top it funds three fresh keys at genesis (`health` for network-health,
`trafficA` and `trafficB`) and picks a start time a few seconds ahead.

- The producer does not wait for `start_time`, and block `h` is stamped
  `start_time + h × period`, so the container starts early and a wrapper inside
  it execs the producer at exactly `start_time`. `status` reports the lag
  behind that schedule (tens of ms after `up`; pauses, such as the smoke's
  storage-cap step, add to it).
- `secrets.json` (0600) in the run dir holds every account key and the
  private-control token; nothing secret is printed or passed in argv.
- `down` removes only the container and network labelled with this run dir;
  `--purge` also deletes the run dir. `--block-period-ms` changes the period
  (the smoke exercise then fails; it asserts 500 ms values).

## Traffic and the failure cases

`udcExplorerTraffic.ts` asserts each step against the node and writes the
manifest (tx hashes, entity keys, expected final states, absent queries, bytes
markers). It covers index toggle and retype by patch (u64 → dec, indexed ⇄
stored, predicates following), a 32-attribute create of every type, unicode,
negative dec, u256 max, i32 min and case-sensitive names, expiry, delete,
finite → permanent, a permanent entity transferred and patched by its new
owner, a permissionless extension paid by a non-owner, a five-op batch, plain
GLM transfers, and these failures, sent with an explicit 3,000,000 gas limit so
that no estimate refuses them first. On node 2aff63b:

| Case | Revert / refusal | Outcome |
| --- | --- | --- |
| readonly patch | `ReadOnlyEntity` | mined, status 0 |
| non-owner transfer / patch / delete | `NotOwner` | mined, status 0 |
| non-owner extension to permanent | `PermanenceOwnerOnly` | mined, status 0 |
| patch of a missing entity | `EntityNotFound` | mined, status 0 |
| shortened expiry | `ExpiryNotExtended` | mined, status 0 |
| transfer to self | `TransferToSelf` | mined, status 0 |
| batch: good create + readonly patch | `ReadOnlyEntity` | mined, status 0; the create does not apply |
| create with a 60,000 gas limit | out of gas | mined, status 0 (59,736 gas used) |
| patch after expiry | `EntityNotFound` | mined, status 0 |
| sender with gas but not rent | `insufficient funds for gas * price + value + rent` | refused at admission: no tx, no nonce |

Every mined failure is charged gas (21,000 for an ordinary revert) and no rent,
advances the sender's nonce, and changes no state. Without an explicit gas
limit the SDK's gas estimate reverts first and nothing is sent, which is why
network-health's own revert checks never reach a block.

## Verification

`verifyUdcExplorer.ts --node … --manifest … (--node-only | --explorer …)`
collects the ground truth from the node alone (`udcE2eNodeTruth.ts`): every
block and receipt up to the target block (status, gasUsed, rentFee, logs), the
per-block gas and rent sums, and every live entity there through `arkiv_query`
with the full select (`attributeSchema` with `indexed`, exact `expiresAt`
including 2^64 − 1). It self-checks that truth and the manifest, then compares
the explorer:

- backend API: every block present with its tx count, gas and rent sum; every
  tx's status, gas, gas fee and rent;
- `/shadow-rpc`: every receipt (rentFee included) and block, field by field;
- `/shadow-rpc/experimental`: every entity at the target block as raw JSON,
  the order, the count, the manifest's keys and the absent queries.

`scripts/udcExplorerApi.ts` is the only module that knows the backend's REST
shapes; update it when WP2/WP3 change them. It already reads `rentFeeWei`
(transactions) and `totalRentFeeWei` (blocks) and reports them as "not exposed"
until they exist. `compareEntityQuery.ts` still selects `contentType` and calls
`arkiv_getEntity`, which the UDC node refuses; it fails until WP2b updates it.

## Node behaviour the explorer has to model

- 500 ms blocks have whole-second timestamps, so pairs of blocks share one, and
  `arkiv_getBlockTiming.duration` (whole seconds between the last two blocks)
  is 0 or 1.
- A block's `gasUsed` can exceed the sum of its receipts: the expiry sweep
  spends gas that no transaction pays (19,500 for one expired entity).
- Receipts carry the transaction fields, `input` included, so bytes contents
  travel in them; the harness keeps only the input size.

## SDK network-health on the devnet

At 500 ms blocks it passes 30 or 31 of 33. Besides the known paging failure,
two of its checks assume 2 s blocks: "an entity expires on its own" (its 5-block
lifetime is 2.5 s and ends before the read-back) always fails, and "the chain
reports its block timing" fails whenever the last two blocks share a second
(`duration` 0). On a `--block-period-ms 2000` devnet it passes 32 of 33.

## Baseline: the payload-era explorer

Recorded 2026-10-27 with this branch's base (main a19eaf3, v0.5.23) and decoder
v0.2.2. It neither stalls nor errors; it indexes the chain and gets the UDC
parts wrong:

- **Chain data is exact.** Scanner, backfill and gap filler store every block
  (no gaps through the decoder outage and the scanner restart), and every
  block, transaction, status, gas figure and log matches the node, through the
  API and `/shadow-rpc` alike, block 0 and the expiry-gas blocks included.
- **No rent anywhere**: no `rentFee` in API rows or shadow receipts, no block
  rent sums.
- **Decoded operations are wrong.** v0.2.2 reads the UDC calldata without an
  error, but every indexed attribute (typeId bit 7) comes out as type
  `unknown` with a hex value (an indexed str, dec, u256 or i32 alike), bytes as
  `<96 bytes>`, expiry as a relative `expiresAtBlocks` (5000), permanence
  clamped to 9007199254740991, with `contentType: null, payloadSizeBytes: 0`.
- **The entity index is dead on arrival** with `ENTITY_INDEX_GENESIS=auto`: the
  genesis import asks for `contentType` and the node answers -32602, readiness
  stays `genesis-failed`, every `/shadow-rpc/experimental` call answers -32000
  and `/entity/<key>` 503. compareEntityQuery fails at every checkpoint.
- **With the genesis import off** (after `scripts/resetEntityIndex.ts`) the
  index serves entities but inverted: it keeps only unindexed, non-bytes
  attributes (one of the edge entity's nine) and no `indexed` flags, misses the
  three genesis entities (count 20 vs 23), and lists newest-first where the
  node lists oldest-first. `expiresAt` is right.
- The Postgres dump holds no bytes contents (the payload-era schema keeps sizes).

The same indexer with the v0.3 decoder (`arkiv-transaction-decoder:udc-local`)
stalls instead: the first block with an `execute()` call fails with "Arkiv
decoder returned an unexpected operation shape" and is retried forever, so the
decoder and the indexer must ship together.

## Plugging in WP1–WP3

- Decoder: build it as `arkiv-transaction-decoder:udc-local` or point
  `ARKIV_DECODER_IMAGE` at it.
- Indexer and frontend: run the harness from a checkout of the branch under
  test; the compose images build from it.
- API shape changes: `scripts/udcExplorerApi.ts`.
- `/shadow-rpc` is an admin surface; the runner enables token login with a
  random token (0600 file in the state dir) and the verifier signs in with it.

## Names, ports and cleanup

Containers `udc-e2e-node` and compose project `arkiv-explorer-e2e`, networks
`arkiv-udc-e2e` and `arkiv-explorer-e2e_default`, ports 28545/28546 (node) and
13101/23661 (explorer), all on 127.0.0.1. Without `--keep` the run ends with
`docker compose down -v` and `udc-devnet.py down --purge`; the built
`arkiv-explorer-e2e-*` images stay for the next run. After `--keep`:

```sh
docker compose -p arkiv-explorer-e2e --env-file "$UDC_E2E_DIR/explorer.env" \
  -f docker-compose.yml -f docker-compose.prefill.yml down -v
python3 scripts/udc-devnet.py down --purge
```
