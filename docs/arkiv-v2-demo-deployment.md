# Arkiv-compatible entity demo deployment

The full/light node panels now serve the `arkiv-entity-v2` profile. The old chain was stopped with user authorization; its containers and volumes remain offline for rollback. No old database was reinterpreted using new encodings.

- Full panel: https://fullnode.experimental.arkiv-global.net
- Light query/proof panel: https://lightnode.experimental.arkiv-global.net
- Existing explorer application: https://explorer.experimental.arkiv-global.net
- Compose project: `arkiv-sim-b5a916006d`
- Private configuration: `/home/ubuntu/.config/arkiv-simulator/experimental-v2/.env.simulator.local`
- Profile build setting: `SIMULATOR_FEATURES=arkiv-v2`
- Source: `f1c370bc-088b-4ed0-ae5f-b8904dd229bc`
- Run: `500ffaf8875dd09986d072214cf84af9`
- Chain ID: `9002`
- Genesis: `0x0c4492adbacca9db32c189ccf9957f5787d169e8c7d7330a73a96dead4657b4d`

The producer creates unsigned blocks, the full node re-executes them, and the light node fetches headers and proofs from the full node. Verification runs in the hosted Rust light process. The browser validates response consistency and displays actual decoded witness paths. This profile does not implement production-identical roots, transaction signatures, full SDK JSON-RPC, or the full query language.

## Demonstration

The light panel detects the node profile and offers all supported equality scalar types: bool, i32, u64, u256, dec, bytes32, str, addr and key. Names may be 32 bytes, indexed strings 128 UTF-8 bytes. System ownership, timestamps, expiry, creation flags, content type and payload are committed and checked by the host/verifier. Exact numeric values stay strings in JSON; decimal queries use up to 18 fractional digits without floating point.

Twelve examples demonstrate membership pagination, absence, before/after expiry, ownership transfer, immutable creator, decimal values, maximum u256, content type, update height, entity references and minimum i32. Expand a returned entity to see verified system fields and payload bytes. Proof/raw payload bytes are restricted to the proof interface; PostgreSQL retains descriptors and indexed attribute metadata only.

Fixture history: block 2 creates five entities; block 4 transfers one to Bob; block 5 Bob patches it; block 6 a permitted extension stamps updatedAt; block 8 deletes one; block 14 expires one. Group equality at block 3 returns IDs 1,2,3 then 4,5; total matches change from four at block 13 to three at block 14. Querying `$updatedAt` is an explicit extension over the pinned current Arkiv node; current SDK query-builder restrictions also differ for `$createdAt` and `$contentType`.

## Operations

Run from the experimental indexer checkout. Never print the private environment file.

```sh
python3 scripts/simulator.py --state-dir /home/ubuntu/.config/arkiv-simulator/experimental-v2 status
python3 scripts/simulator.py --state-dir /home/ubuntu/.config/arkiv-simulator/experimental-v2 compose ps
```

Rebuild the two node panels independently:

```sh
docker compose --env-file /home/ubuntu/.config/arkiv-simulator/experimental-v2/.env.simulator.local \
  -p arkiv-sim-b5a916006d -f compose.simulator.yml -f compose.node-panels.yml \
  --profile node-panels up -d --build --no-deps fullnode-ui lightnode-ui
```

The launcher uses the saved profile setting for Rust builds. Fresh v2 stores are mandatory; do not point the new binary at legacy volumes. The existing nginx/TLS sites still proxy the same loopback ports (9400, 23570–23573). Unrelated services and DNS were untouched.

For rollback, stop every new-project service including the node-panels overlay, then start the retained `arkiv-sim-666374b2c8` project with the old `experimental/.env.simulator.local`, all original profiles and the panel overlay. Use `--no-build`; its retained images/stores belong together. Do not run both stacks on the same ports. Historical hashes and run identities must remain unchanged; never reset either store to resolve a mismatch.

## Verification

The live report is `docs/arkiv-v2-demo-verification.json`. `scripts/checkNodePanels.ts` detects legacy/v2 and checks the actual HTTPS APIs and Chromium browser: all sample types, pinned pagination during block production, wrong-run rejection, frozen-node trust invalidation, raw witness/tree interactions and desktop/mobile overflow. The full/light views do not query the explorer database.

The live 4,980-byte membership proof was additionally checked by the standalone Rust `verify_inspection` example, compiled with `--features arkiv-v2`, using a separately fetched full-node genesis/header and original query. Changing one witness byte was rejected with `InvalidProof`.

Frontend validation: 27 tests / 199 assertions, frontend test TypeScript checks and production build passed. Backend simulator validation: 50 tests against isolated PostgreSQL passed (one optional external Rust oracle skipped), including old-schema widening and exact u256/decimal/binary comparisons. Rust validation: 364 legacy / 363 v2 database tests; 90 legacy / 15 v2 node tests; 177 recovered crash images; Clippy both profiles. The explorer was observed following the new identity with healthy indexing.
