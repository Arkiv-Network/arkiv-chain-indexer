# Full and light node demonstration

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
docker compose --env-file /home/ubuntu/.config/arkiv-simulator/experimental/.env.simulator.local \
  -p arkiv-sim-666374b2c8 -f compose.simulator.yml -f compose.node-panels.yml \
  --profile node-panels up -d --build --no-deps fullnode-ui lightnode-ui
```

The light service requires a node build containing `/sim/v1/query/inspect`. A targeted light rebuild/recreation preserves its retained headers and avoids rebuilding the explorer:

```sh
python3 scripts/simulator.py --state-dir /home/ubuntu/.config/arkiv-simulator/experimental \
  compose build light
python3 scripts/simulator.py --state-dir /home/ubuntu/.config/arkiv-simulator/experimental \
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
