# Run the native simulator explorer

The simulator uses an unsigned internal Rust producer, an independently executing
full follower, an independent PostgreSQL explorer, and a Rust light verifier. The
existing Ethereum stack and signed full/light demo remain separate. History is
retained; no pruning or reset is performed by these commands. The hosted
deployment on `experimental.arkiv-global.net` and
`explorer.experimental.arkiv-global.net` is described in
[the deployment runbook](simulator-deployment.md).

## All-local Docker stack

Check out `arkiv-db-pure-astra` beside this `arkiv-chain-indexer-experimental`
checkout. Use Docker Compose with build contexts support, Python 3, and sufficient
space for retained redb/PostgreSQL history. Stay on the indexer's `experimental`
branch. These commands never read the application's `.env`:

```sh
python3 scripts/simulator.py init
python3 scripts/simulator.py control step
python3 scripts/simulator.py control resume
python3 scripts/simulator.py status
python3 scripts/simulator.py control pause
python3 scripts/simulator.py stop
python3 scripts/simulator.py up
python3 scripts/simulator.py compose ps
python3 scripts/simulator.py compose -- logs --tail 50 producer
```

Open **http://localhost:23561**. The producer public endpoint is loopback port
9400. Its private control/body port, PostgreSQL, the full follower and the light
process are only on the compose network. `init` builds the images, starts a
paused producer (`--producer-start running` makes every start resume production
instead), records its random run ID and genesis hash, then starts the followers
and consumers. `up` verifies those same pins before starting them. A mismatch
stops the launcher; it never rebinds an existing database to a new chain.
`compose` passes its arguments to Docker Compose with the same private env file,
project name and profiles; put `--` before arguments that start with a dash.

The primary frontend serves the explorer by default; `init --ui-mode debug`
serves the operational debug console instead (topology and lag of every node,
block inspector with budgets and ordered outcomes, historical record lookups,
proof inspection with size and timing, producer controls). `--hosted-explorer`
adds a second read-only backend/frontend pair without controls or login for a
separate origin. Deployment-only values such as Google OAuth credentials, the
exact public origin and operator URLs come from a private `KEY=VALUE` file passed
as `init --private-env FILE`; they are never command-line arguments.

Private passwords/tokens and identity pins live in `.simulator/.env.simulator.local`
(mode 0600). Each state-directory path has its own compose project and named
volumes. Keep the configuration with its volumes. `stop` retains everything;
`up` reopens the same run, with the producer paused. For another independent run,
use a **new** `--state-dir`, `--public-port`, and `--frontend-port` rather than
reusing/deleting another run's state. Do not run `down -v` on history to preserve.
The Rust path can be changed with `SIMULATOR_RUST_REPO` in that private file.

A permanent observed identity/version/chain conflict fences native ingestion across
scanner restarts; read-only retained data stays available. Review the source and
pins before recovery. To rebuild the explorer deliberately while preserving its
old projection, set `SIMULATOR_SCHEMA` to a fresh `sim_...` name in the private file
and run `up`. It ingests the same pinned chain from genesis into that new schema.
There is no public clear-fence/reset endpoint and no automatic deletion of history.

For an explicit local test login, start with `init --local-login`. The UI's
“Admin login” accepts `operator@example.test` and `AUTH_TOKEN_LOGIN_TOKEN` from
that private file. The launcher never prints credentials. This is the existing
localhost-only token-login option; it is disabled by default. Normal deployments
use the existing Google OAuth configuration and exact public Origin. UI controls
still require an administrator session and CSRF token. CLI controls are operator
calls inside the private compose network. Protect access to Docker and the private
configuration as administrator access.

## Historical inspection

1. Start paused and issue `control step` twenty times. Block 7 rolls back its
   transaction; block 8 deletes a record; block 9 recreates the same key with a new
   ID; block 12 transfers namespace ownership; block 14 expires the earlier row.
2. Browse blocks, transactions, ordered operation outcomes, namespace revisions,
   typed records and separate raw descriptors. Select a record to inspect that
   incarnation's operations. Every ordinary result is an **unverified projection**.
3. In Query choose height **18**, namespace **1**, attribute **group**, type
   **u64**, value **1**, page size **3**. Read the SQL projection or select
   **Verify Eq locally** (on a stack opened on the same machine; a hosted
   deployment labels the same button and badge **server-side**, because the
   light process then belongs to the server, not to the browser). The light
   process verifies the complete posting witness and row proofs and reports the
   proof size and its fetch/verify timing. Its result has five matching IDs,
   paged as 3 and 2.
4. Resume or step the producer while paging the historical result. The continuation
   retains height/hash/root/query/limit. Editing the form clears the old badge and
   results. A missing verifier, proof failure, or changed run produces no verified
   result and no SQL fallback.
5. Pause/restart the scanner to observe indexed lag, then let it catch up. Restart
   the producer and light process and repeat the old query. The explorer continues
   serving already indexed history while its source is offline.

`latest` means the indexed head for SQL. Lag is relative to the last observed
source head; it cannot detect an unobserved or withheld tip. The verified badge
means **“proof verified against trusted simulator root; unsigned source”**,
prefixed with where the verifying light process runs: **locally** only when the
deployment explicitly sets `SIMULATOR_VERIFIER_LOCATION=local` (the launcher does
so for a localhost origin), otherwise **server-side**. It is not consensus, a
signature, execution validation, or global fork detection. Only observed
conflicting headers can be detected. The bundled full follower separately
reexecutes canonical blocks over the private replication listener and checks
roots/outcomes; `GET /api/sim/v1/nodes` reports producer, full, light and
explorer heads, health, probe latency and storage sizes without inventing values
for nodes that are unconfigured or unreachable.

Positive typed Eq is the only proof query profile. SQL metadata also supports
numeric comparisons, string prefix, existence, AND/OR/NOT via the API. Unsupported
proof operators do not become verified SQL. A missing namespace differs from an
empty posting. Proof work/size caps can reject a large query even though its
history remains stored. Page sizes are at most 64 on the light path. The light process retains at most
64 verified continuation entries; restart or eviction invalidates those local
tokens. Start a fresh first page at the same explicit historical height to resume
verification. SQL keyset cursors remain bound to persisted history across restarts.

## Remote source and local verified view

Publish only the producer/full node's public metadata/header/proof listener behind
a normal HTTPS reverse proxy. Pin source UUID, run ID, genesis hash and chain ID
through an independent operator channel. The unsigned protocol does not supply
those trust anchors itself. Keep controls and canonical replication bodies on a
separate authenticated private network; never expose the private listener through
the public route. Do not disable TLS certificate verification. The bundled light service explicitly
sets `SIMULATOR_ALLOW_PRIVATE_HTTP=true` for its Docker-network peer; this permits
cleartext only by operator opt-in and must not be used over an untrusted network.
The remote launcher still requires an HTTPS source.

Run the explorer and verifier locally against those explicit pins:

```sh
python3 scripts/simulator.py init --state-dir .simulator-remote \
  --peer https://simulator.example.net \
  --source-id 01234567-89ab-4cde-8012-3456789abcde \
  --run-id REPLACE_WITH_32_LOWERCASE_HEX \
  --genesis-hash 0xREPLACE_WITH_64_LOWERCASE_HEX --chain-id 9001
```

Replace the example values with real pins. The remote source must use the same
wire/profile version. Local PostgreSQL and the light catalog retain independent
progress. This mode starts no local producer and exposes no remote controls. The
local UI serves `/local-sim/v1/...` through a fixed proxy to its local light process;
it forwards no cookies, bearer tokens or CSRF headers. Only status and verified Eq
are allowed. An HTTPS dashboard elsewhere cannot assume browser access to localhost
HTTP; use this local view. A remote dashboard without a configured local verifier
keeps projection-only badges.

For a server hosting the complete stack, bind the existing loopback UI/public-node
ports behind your HTTPS ingress, configure exact `AUTH_PUBLIC_ORIGIN` and Google
OAuth settings through `init --auth-public-origin` and `--private-env`, and leave
localhost token login disabled. Do not publish PostgreSQL or the producer's
private listener to the Internet. The experimental deployment described in
[simulator-deployment.md](simulator-deployment.md) publishes the producer's public
listener at `https://experimental.arkiv-global.net/sim/v1/` behind nginx rate
limits, so that origin is a valid `--peer` for the local light-client workflow
above; the debug console prints the exact command with the run's pins.

## Direct Rust processes and optional full follower

Build in the sibling Rust checkout:

```sh
cargo build --release -p arkiv-node --bin arkiv-simulator
```

Producer example (set a random private `SIMULATOR_ADMIN_TOKEN` of at least 32 bytes
in the environment; do not place it in command-line arguments):

```sh
target/release/arkiv-simulator producer --unsigned-simulator \
  --run-dir ./target/my-simulator --listen 127.0.0.1:9400 \
  --admin-listen 127.0.0.1:9401
```

The startup/status JSON gives the generated identity. Supply those explicit pins
to a light or full process:

```sh
target/release/arkiv-simulator light --unsigned-simulator \
  --run-dir ./target/my-light --listen 127.0.0.1:9402 \
  --peer http://127.0.0.1:9400 --source-id SOURCE_UUID \
  --run-id RUN_HEX --genesis-hash GENESIS_HEX --chain-id 9001
```

A full follower uses role `full`, its own directory and listener, the same pins,
and `--replication-peer http://127.0.0.1:9401`. Set
`SIMULATOR_REPLICATION_TOKEN` to the producer's private bearer through a protected
environment. This token is sent only to the configured replication endpoint, never
to its public peer. Full followers retain all canonical bodies and independently
execute them. Light clients store bounded individual header records in `headers.redb`
and never fetch bodies or metadata feeds. Producer/full history resides in one
`node.redb` file: state, manifest/head, body, inclusions, workload revision and feed
are one atomic publication. Cold reopen loads the head, not the chain into RAM.
A changed storage/wire profile needs explicit migration or a new run.

## Wire and resource contract

The selected genesis has at most 128 user operations, 16 expiry steps, 16 cells per
row and 1,024 bytes per value. Its profile serves one complete metadata-only block
at `GET /sim/v1/feed/blocks/H`, capped at **4 MiB**, rather than the proposal's
fragmented 1 MiB sections. A binary digest binds the closed DTO before publication;
the node rejects an unservable block before committing it. Scanner transport caps
actual streamed bytes before JSON parse, then validates canonical header bytes,
identity, ordering, counts, provenance and the feed digest before one PG transaction.
There is one scanner block in flight. No canonical input/body fetch enters this path.

The feed digest uses the existing domain-separated `digest` function with domain
`arkiv/simulator-feed-block/v1` and a binary tagged encoding of the entire whitelisted
feed DTO except `feedDigest`: null 0; false 1; true 2; JSON u32 3 + big-endian u32;
string 4 + byte-length u32 + UTF-8; array 5 + u32 count + items; object 6 + u32 count
+ string-key/value pairs sorted by UTF-8 key bytes. Decimal u64/i64 values stay
strings. Cross-language golden fixtures freeze this encoding; JSON object order
is irrelevant. A feed digest establishes integrity relative to the trusted source,
not execution truth.

PG stores namespace-local numeric record IDs and distinct key incarnations, typed
attributes, and terminal field/raw **descriptors** (name/type/byte length/digest).
It never receives field/raw bytes or calldata. Canonical bodies remain on the
private replication path; full-row proof bytes remain on the proof path. Legitimate
NUL attribute strings use text JSON storage plus bytea indexes where PostgreSQL
JSONB would reject them. The API uses decimal strings and bounded ascending keysets.
Native counters update with block progress; HTTP statistics do not scan all history.

The explorer has bounded requests/responses, query timeouts, and keyset cursors;
its local proof proxy allows 16 concurrent requests, 64 KiB bodies, 8 MiB responses,
chunk-count bounds and deadlines. These limits and the engine's encoded-object cache
are not claims of a fixed whole-process RSS: redb/PostgreSQL caches, allocation
retention, active proof decoding and caller-owned transients also consume memory.
See the acceptance report for measured limits.

## Validation

Ordinary tests require neither a database nor a node. Opt-in tests use a disposable
local PostgreSQL server, never the application's `.env` or production credentials:

```sh
bun --no-env-file test ./src ./frontend
bun --no-env-file run typecheck
bun --no-env-file run typecheck:frontend-tests
(cd frontend && npm ci && npm run build)
TEST_DATABASE_URL=postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DB \
  bun --no-env-file test ./src ./frontend
TEST_DATABASE_URL=postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/TEST_DB \
  bun --no-env-file scripts/testSimulatorIntegration.ts
```

The process/browser harness creates and drops a separate database, runs real
producer/light/scanner/API/UI processes, restarts durable services, and tests proof
paging plus admin login/step/logout. Install Playwright Chromium first, or provide
`CHROMIUM_EXECUTABLE` to a compatible local Chrome. It leaves test logs/screenshots
in its printed temporary directory and stops its processes. `SIMULATOR_BINARY`
can point to a release binary. Rust tests separately cover full replay, header/proof
tampering, publication faults, and real redb crash images. See
[the acceptance report](simulator-acceptance.md) for commands and observations.
