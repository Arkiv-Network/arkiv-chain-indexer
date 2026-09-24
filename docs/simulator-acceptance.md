# Native simulator acceptance evidence

The integration runs an explicitly unsigned durable Rust producer, an independently
executing full follower, a header-only durable light client, and an independent
PostgreSQL explorer. `SOURCE_KIND=native-simulator` selects a separate backend and
frontend path before Ethereum services mount. Existing Ethereum mode and the signed
Rust demo remain available. No pruning is included; the hosted experimental deployment
and its validation record are in [simulator-deployment.md](simulator-deployment.md).

[Run it locally or against a remote source](simulator-run.md). The implementation
contract and the bounded whole-block feed adjustment are in
[the design](simulator-integration-plan.md). Release-mode throughput, filesystem,
RSS and cold-open measurements are recorded separately in
[simulator-measurements.md](simulator-measurements.md).

## What was exercised

- Canonical memory/durable/full execution and header/root/outcome/receipt parity on
  200 deterministic blocks; historical Eq proof bytes/results at page sizes 1, 3
  and 64. Metadata observation leaves canonical execution unchanged.
- One-file state/body/feed/inclusion publication, all four injected commit outcomes,
  exact retained retry, lost acknowledgement, restart, idempotent step/configuration,
  and real redb crash images. The engine profile rejects incompatible ordinary-engine
  opens and validates block-to-manifest/root association without scanning history.
- Strict shared Rust/TS header and feed-digest fixtures, integer extremes, typed
  attributes, metadata whitelists, namespace/key isolation and malformed/oversized
  transport. Field/raw bytes stay on execution/proof paths; only descriptors enter
  the feed and PostgreSQL.
- Real PostgreSQL atomic block/projection/progress, request inclusion identity,
  conflicting duplicate fencing, new-run isolation, historical versions, pinned
  keysets, failed work, expiry and recreation. An independent logical 20-slot oracle
  checks the real 0–40 Rust trace at every height and page sizes 1, 3 and 64, including
  typed equality, IDs, field size/hash, namespace ownership/revision and empty raw
  maps. Expected state is not derived from the incoming feed.
- Real PostgreSQL failures after each of 33 DML/notification statements and just
  before COMMIT preserve exact contents of all eight state tables and release no
  notifications. A successful retry emits one notification. Terminating the active
  PG connection rolls its transaction back; losing the response after a successful
  COMMIT reopens/retries as an exact duplicate. Truncated chunked HTTP metadata
  retries the same missing height while preserving committed genesis progress.
- Real HTTP full replay through the private bearer body endpoint; a light process
  fetches headers/proofs and makes zero body/feed requests. Public body/control
  routes are rejected. Header gaps/stale tips/conflicts, mutated/truncated proof
  responses, pinned continuations, request caps and persisted conflict fences fail
  without releasing verified rows. Fresh bootstrap validates pinned genesis before
  creating its database; temporary source failure and an earlier empty adapter file
  can be retried safely.
- Real process/browser integration with a newly created disposable PostgreSQL
  database: twenty steps, SQL and locally verified historical Eq, continuation after
  producer advancement, same-run paused producer restart, scanner catch-up from 20
  to 24, light catalog restart, and an authenticated browser step to 25.
  Browser tests also reject a mismatched projection identity, clear stale proof
  badges on edits, recover from a definitive control rejection, and suppress a late
  uncertain control response after logout/relogin. No Ethereum RPC/wallet routes
  are requested in native mode.
- The fixed local verifier proxy strips cookies, bearer and CSRF headers; allows only
  status/verified Eq; enforces actual body/response bytes, chunk counts, deadlines
  and concurrent-request limits; rejects cross-origin browser calls and arbitrary
  target/body/control routes. Existing authentication/Origin/CSRF regression tests
  remain active.
- All five Docker images built using the dedicated compose file. The packaged
  launcher initialized a paused run, performed twenty private steps, returned the
  expected historical Eq page at height 18 (IDs 3, 4, 5; total five), stopped every
  service and reopened the same run/head 20 with PostgreSQL progress retained.
  The private node listener and PostgreSQL were not published to host ports.
  Desktop and 390-pixel mobile browsers verified the same historical page without
  JavaScript errors or page overflow; wide result tables scroll within their panel.

## Commands and test environment

Validation used only local disposable PostgreSQL on a dedicated test port, explicit
`TEST_DATABASE_URL`, and `bun --no-env-file`. Browser runs used a compatible local
Chrome via `CHROMIUM_EXECUTABLE`; the runner accepts installed Playwright Chromium
by default. The ordinary suite does not require either PostgreSQL or a node.

The final combined backend/frontend run with isolated PostgreSQL and the actual
Rust lifecycle fixture passed **1,173 tests, zero failures**, with 16 opt-in
external/browser cases skipped (6,552 assertions across 90 files). The standalone
real simulator/browser harness above ran separately and passed. Both TypeScript
checks and the production frontend build passed; the existing large-bundle build
warning remains. The ordinary no-database run also passed.

```sh
bun --no-env-file test ./src ./frontend
bun --no-env-file run typecheck
bun --no-env-file run typecheck:frontend-tests
npm --prefix frontend run build
TEST_DATABASE_URL=postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DB \
  TEST_SIMULATOR_FIXTURE=/tmp/arkiv-simulator-fixtures.json \
  bun --no-env-file test ./src ./frontend
TEST_DATABASE_URL=postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DB \
  CHROMIUM_EXECUTABLE=/path/to/chrome \
  bun --no-env-file scripts/testSimulatorIntegration.ts
docker compose --env-file .env.simulator.example --file compose.simulator.yml \
  --profile local config --quiet
docker compose --env-file .env.simulator.example --file compose.simulator.yml \
  --profile local build
```

`TEST_SIMULATOR_FIXTURE` is optional. To reproduce the long oracle fixture, start a
fresh default workload using the launcher, step exactly 40 times while paused,
then capture only its public metadata (adjust the loopback port if configured):

```sh
python3 - <<'PY'
import json, urllib.request
base = "http://127.0.0.1:9400/sim/v1"
def read(path):
    with urllib.request.urlopen(base + path, timeout=5) as response:
        return json.loads(response.read(4 * 1024 * 1024 + 1))
status = read("/status")
assert status["paused"] and status["head"]["height"] == "40"
fixture = {"status": status, "blocks": [read(f"/feed/blocks/{h}") for h in range(41)]}
with open("/tmp/arkiv-simulator-fixtures.json", "w") as out:
    json.dump(fixture, out)
PY
```

Rust workspace verification passed **825 tests, zero failures**, with the three
existing expensive redb torn-write sweeps remaining ignored by default:
`every_crash_point_in_steady_state_heavy`,
`every_crash_point_is_parent_or_candidate_heavy`, and
`growing_commit_every_crash_point_heavy`. The new simulator crash sweep ran all
33 mutating cuts across 99 crash images (89 parent, 10 candidate), including node
body/feed/inclusion/state linkage. Maintained-crate Clippy, format checks, Rust
1.90 and the separate real-process signed-demo 200-block adversarial/oracle suite
also passed:

```sh
cargo test --workspace --locked --offline
cargo clippy --workspace --exclude alloy-trie --exclude reth-trie \
  --all-targets --locked --offline -- -D warnings
cargo +1.90.0 check --workspace --all-targets --locked --offline
cargo fmt -p arkiv-db -p arkiv-db-trie -p arkiv-db-memory -p arkiv-db-storage \
  -p arkiv-db-redb -p arkiv-node -- --check
python3 scripts/test-full-light-demo.py
```

Simulator-specific
fixtures are in `arkiv-node/tests/simulator{,_crash,_http}.rs` and
`arkiv-db/tests/simulator_composition.rs`; pre-existing engine, trie, redb and signed
node tests remain unchanged except the additive observation hook.

## Explicit boundaries

A proof badge verifies consistency against a locally accepted **unsigned trusted
root**. It does not authenticate a producer, establish consensus/finality, or prove
execution. A dishonest trusted source can endorse an internally consistent invalid
state; a full follower independently executing the block can reject it. Only
conflicts actually observed can be detected. Metadata/SQL remain unverified even
when their feed/header digests match.

The selected bounded genesis serves one complete metadata block capped at 4 MiB,
rather than the proposal's fragmented sections. Admission enforces transportability
before publication; partial response retry replaces section-download recovery in
this profile. Numeric/typed metadata and terminal after-images are native; no gas,
fees, balances, signatures, logs, wallet sender or calldata panel is invented.
The internal v1 workload has no pricing-admin transaction. Rich SQL text syntax,
aggregate payload-size charts and external payload retrieval are not included.

Retained history grows on disk. Cache/queue/response bounds and root-only head
ownership do not bound whole-process RSS. Measurements distinguish actual resident
memory, JavaScript heap, encoded cache ownership, redb/PostgreSQL disk allocation
and warm operating-system/database caches; isolated active decoder/backend heap
peaks are not measured. Proof posting/work caps can reject a query over a stored
snapshot without making that snapshot unavailable. The light continuation registry
is limited to 64 entries and is volatile; after restart, request the first page of
the same historical query again. SQL cursors remain portable within the same run.

Local Docker communication explicitly permits configured private HTTP peers; remote
configuration defaults to HTTPS and redirects are refused. The experimental hosted
deployment ([runbook](simulator-deployment.md)) is an operator-run stack behind
nginx, not a production rollout. Google OAuth live-account HTTPS callbacks were
not exercised; existing mocked OAuth/JWKS and session/token security tests plus
real localhost opt-in token login were exercised.
