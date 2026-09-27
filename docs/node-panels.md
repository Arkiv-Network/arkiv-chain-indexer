# Full and light node demonstration

The current deployment uses the Arkiv entity v2 profile. See [the current deployment runbook](arkiv-v2-demo-deployment.md). The original verification and reset details below describe the earlier generic demo.

The two dedicated debug panels are independent of the explorer and PostgreSQL:

- `https://fullnode.experimental.arkiv-global.net`: full follower status, retained storage, and block metadata from its own node.
- `https://lightnode.experimental.arkiv-global.net`: equality query lab, verified responses, downloadable canonical witnesses, and an interactive Patricia witness inspector.

The producer creates deterministic unsigned blocks internally. The full follower independently executes each block and checks its roots and outcomes. The light follower retains headers and requests equality proofs from the full follower (`SIMULATOR_LIGHT_PEER_URL=http://full:9403`). It checks the entire engine proof against the selected retained header before returning any successful inspection. No transaction signatures or consensus authentication are implemented.

Verification runs in the hosted light process. The browser displays its result and performs response consistency checks; it does not run the cryptographic verifier. A remote user therefore trusts this hosted light process. Running the same light process locally moves that verification boundary to the user's machine.

## What to demonstrate

Open the light panel and run the supplied examples. The equality predicate is a single typed attribute in a selected namespace. A query pins one block; pagination keeps that block even while new blocks arrive.

1. The inclusion example shows a page of matching records and a continuation. Advance to the next page to demonstrate complete, stable pagination.
2. The missing-value example returns zero rows with a verified absence path.
3. The before/after expiry examples compare adjacent historical snapshots and show how a record disappears at the expiry block.
4. Enter a custom block (or `latest`), namespace, attribute, type, value and page size. Unsupported or unavailable queries produce an explicit error.
5. Inspect the state-root composition, choose catalog/term/row/key paths, and select individual branch, extension, or leaf nodes. The node details show compact nibble paths, hash/inline child references, sibling commitments, and exact RLP.

The visualizer displays the witnessed paths, not the whole database tree. Point inclusion alone does not prove query completeness: the equality verifier also reconstructs the posting root from the complete ordered record ID set. That reconstruction is displayed separately. Canonical proof bytes can contain row values; the separate explorer projection still stores metadata only.

## Deployment

The existing `compose.simulator.yml` stack remains the producer/full/light/explorer deployment. `compose.node-panels.yml` adds two read-only frontend services to that same project/network, with no database/backend dependency. They publish loopback ports 23572 and 23573 by default.

Use the existing private environment file and project name; never print the environment file or place secrets on the command line:

```sh
docker compose --env-file /home/ubuntu/.config/arkiv-simulator/experimental-v2/.env.simulator.local \
  -p arkiv-sim-b5a916006d -f compose.simulator.yml -f compose.node-panels.yml \
  --profile node-panels up -d --build --no-deps fullnode-ui lightnode-ui
```

The light service requires a node build containing `/sim/v1/query/inspect`. A targeted light rebuild/recreation preserves its retained headers and avoids rebuilding the explorer:

```sh
python3 scripts/simulator.py --state-dir /home/ubuntu/.config/arkiv-simulator/experimental-v2 \
  compose build light
python3 scripts/simulator.py --state-dir /home/ubuntu/.config/arkiv-simulator/experimental-v2 \
  compose up -- -d --no-deps --no-build light
```

Runtime mode chooses the fixed proxy target. `/node-sim/v1/status` is shared; only the full panel permits `GET /node-sim/v1/feed/blocks/H`, and only the light panel permits `POST /node-sim/v1/query/inspect`. The proxy strips credentials, refuses cross-origin requests and arbitrary targets, bounds requests to 64 KiB and responses to 8 MiB, limits concurrent requests, and enforces deadlines. The panels block `/api`, `/local-sim`, controls, replication, and metrics. They cannot administer the producer.

`deploy/nginx/node-panels-http.conf` bootstraps ACME issuance. After both A records resolve to the host, issue the certificate with the webroot `/var/www/arkiv-node-panels` and install `deploy/nginx/node-panels.conf`. Run `nginx -t` before reloading. The final configuration retains ACME webroot routing for automatic renewals. It only adds the new hostnames; existing producer/explorer site files remain untouched.

## Fresh demonstration run

On 2026-09-24 the user authorized removal of the old disposable demo data. The three simulator data volumes and `sim_v1` PostgreSQL projection were removed and recreated. Private deployment configuration, credentials, authentication tables, explorer application/images, and measurement reports were retained. The explorer backend and scanner were rebound to the new run without application changes.

- Source: `b8f801fc-34ad-475c-b719-59128ff198dc`
- New run: `39526034551af8f0c34c7579e2dbc3d9`
- Genesis: `0x859817c2c095092cab7666b80d0fb0df7c61fc7ff840b0a070c35be7246d2b9d`
- Previous removed run: `d0e9cfc7942a84f952720274e197229b`

The genesis hash is deterministic and may remain the same across runs; the run ID changes. A normal restart must retain the run ID and history. No routine launch command automatically resets or rebinds a run.

## Verification

`docs/node-panels-verification.json` records the successful live HTTPS/browser check. Run the same check without stopping production:

```sh
bun --no-env-file scripts/checkNodePanels.ts --out /tmp/arkiv-node-panel-check
```

Set `CHROMIUM_EXECUTABLE` to an installed Chromium/headless-shell binary if the Playwright-managed browser is not installed. The script saves screenshots, the actual membership witness, and an independently fetched full-node block header. It checks inclusion (IDs 3,4,5 then 6,7), empty results, expiry (2→1 rows), pinned paging while the head advances, raw evidence, node selection, desktop/mobile layout, wrong-run rejection, frozen-node trust invalidation, and restricted routing. It never invokes producer controls or resets data.

The captured 3,252-byte witness was additionally verified using the separate Rust `verify_inspection` example and the full node's block-20 header. A one-byte witness mutation was rejected with `InvalidProof`. See the Rust repository's `docs/simulator-proof-inspection.md` for offline commands and the exact proof schema.

Frontend/proxy validation passed 25 tests with 177 assertions, frontend test TypeScript checking, and the production build. The Rust change passed trie/node regression tests, the equality-proof suite, adversarial socket tests, and Clippy. The original explorer remains healthy on the fresh run; its frontend container/image and both original nginx site files were unchanged.

Block timestamps are deterministic simulated time, not wall-clock production time. The full-node block inspector labels them accordingly.

## Signed chain deployments

Set `DEBUG_NODE_PROTOCOL=signed` on each panel server to route the existing
read-only panel paths to `/signed/v1` on its fixed `DEBUG_NODE_HOST` and
`DEBUG_NODE_PORT`. The default remains `sim`. Configure navigation with
`VITE_NODE_FULL_UI_URL`, `VITE_NODE_LIGHT_UI_URL`, and `VITE_NODE_EXPLORER_URL`.
Use `VITE_UI_MODE=fullnode` or `lightnode` as before.

Signed status selects authenticated single-proposer trust wording and live
`$contentType` examples instead of the old simulator's fixed block fixtures.
The membership example selects `application/octet-stream`, as used by the
explorer's Baseload workers; operators can edit the query for their data.
The node must provide the single-block feed route, original query and verified
entity creation flags. Signed inspection responses retain their nested identity
and certificate; the client rejects mismatched identity, query, snapshot, or
verification mode. The hosted Rust process verifies proofs, not the browser.
Missing storage/cache/peer telemetry is shown as unavailable, never as zero.

Rogue One runs the panels on loopback ports 23572 and 23573. Nginx serves browser
GET/HEAD `/` and static assets through the panels, while JSON-RPC POST `/`,
WebSocket upgrades, and `/signed/v1/` continue to reach the respective nodes.
Private controls and replication remain blocked. Its light follower requests
proofs from its full follower. Deployment configuration lives outside the repo
at `/home/ubuntu/.config/rogue-one-9008/compose.json`.

Read-only live verification (requires Baseload entities and Playwright Chromium):

```sh
bun --no-env-file scripts/checkSignedNodePanels.ts
```

Override `FULL_PANEL_URL`, `LIGHT_PANEL_URL`, or `PANEL_CHECK_OUT` as needed.
The check covers matching identities, block/proof roots, membership, pagination,
absence, desktop/mobile rendering, restricted paths, HTTP RPC, and WebSockets.

## Range witness inspection

`/proof-inspector` now opens the complete numeric range witness in the existing
Patricia inspector. `?proof=equality` selects the existing equality view. The
inspector no longer appends a second range playground, large raw-response section
or node-identity section underneath the tree.

The range view requests `/node-sim/v1/query/range/inspect`, allowlisted only for a
signed light panel. The proxy forwards to the light node's native inspection
endpoint. The response contains the exact canonical request/proof and a trace
returned only after strict verification. The frontend validates shape, snapshot,
map roots, parent/child links, witness indexing and posting/row associations;
it does not independently perform cryptographic proof verification.

The interval tree distinguishes opened nodes, opaque outside-range references,
authenticated empty slots and excluded boundary leaves. The supplied witness
list uses indices from the actual terms-witness array; inline nodes reference
their containing entry instead of inventing another supplied node. Catalog,
row and key point-path views reuse the equality inspector. Each matching term
shows its complete ID set and the reconstructed/committed posting roots.

Tree/list navigation bounds the rendered view, not the query result. Inspection
has additional resource limits and fails as a whole if those are exceeded.
Editing, a failed request, changed chain identity or an unavailable/frozen node
clears the old witness. Download remains available as one bundle button.

Validation commands:

```sh
bun --no-env-file test frontend
bun --no-env-file run typecheck:frontend-tests
npm --prefix frontend run build
# Read-only live acceptance; or RANGE_INSPECT_FIXTURE=1 against a local preview.
bun --no-env-file scripts/checkRangeInspector.ts
```

The checked-in `frontend/fixtures/range-inspection/price.json` is a captured real
proof from chain 9009, block 42884: prices 10 and 15 match; the opened price-20
leaf is excluded boundary evidence. It contains public data only.
