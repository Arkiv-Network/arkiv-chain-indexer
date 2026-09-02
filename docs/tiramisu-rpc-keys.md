# Getting RPC keys for tiramisu (and any new db-chain network)

**Resolved 2026-09-02 (evening):** the stage Hub now issues keys per network
(arkiv-hub PR #63) and is wired to tiramisu's control-service, and the
api-key-generator mints network-scoped keys when told `HUB_NETWORK`
(`RPC_PROXY_HUB_NETWORK=tiramisu` in the compose profile). The tiramisu indexer
went from 0 to ~385 blocks/min the moment it switched to the proxy. The rest of
this note is the analysis from earlier that day, kept for the next network.

Status 2026-09-02 (morning): the tiramisu indexer at kalarepa.arkiv-global.net
is deployed but its scanners sit on HTTP 429 — tiramisu's RPC edge accepts no
key we can mint. This note explains why, and lists what unblocks it, cheapest
first.

## Why the cheesecake setup does not carry over

Every db-chain network runs its own **bouncer** (Arkiv-Network/bouncer):

- `auth-proxy` at `rpc.<net>.db-chain.<baseDomain>` — the data plane. It
  validates keys against a per-network Valkey projection and nothing else.
- `control-service` at `rpc-control.<net>.db-chain.<baseDomain>` — the only
  writer of that projection. `PUT /keys/{key}` etc., guarded by
  `Authorization: Bearer $ADMIN_AUTH_TOKEN`.

The **Arkiv Hub** (Arkiv-Network/arkiv-hub) is the system of record for keys.
It pushes every key it creates into exactly **one** control-service, set by
`CONTROL_SERVICE_URL` + `CONTROL_SERVICE_ADMIN_TOKEN` (see
`src/lib/control-service/config.ts`; there is no multi-network fan-out).

| Hub                            | Projects into                         | API-keys page |
| ------------------------------ | ------------------------------------- | ------------- |
| `stage.hub.arkiv.network`      | cheesecake's control-service          | live          |
| `hub.arkiv.network` (prod)     | nothing (`CONTROL_SERVICE_URL` unset) | **404** — built without `NEXT_PUBLIC_FEATURE_API_KEYS=true` |

So a stage-Hub key is only known to cheesecake's bouncer. Verified against
tiramisu: fresh stage-Hub mints, cheesecake's 150-key pool, and a bogus key all
answer `{"error":"INVALID_KEY","message":"unknown API key"}`. Anonymous traffic
is `ANON_RATE_LIMIT` = 50 calls/**hour**/IP (the 429 says "get an API key at
https://hub.arkiv.network" — the prod Hub, which cannot issue any yet).

Our `rpc-proxy` compose profile (api-key-generator) mints Hub keys, so it can
only ever be as good as the Hub it points at. `RPC_PROXY_HUB_BASE` (added
2026-09-02) selects that Hub; it defaults to stage.

## Where tiramisu's admin token lives

db-chain-mgr provisions it. The chart (`service/chart/templates/bouncer.yaml`)
syncs the k8s secret `bouncer-secrets` in namespace `db-chain-network-tiramisu`
from the **edge** Doppler project via the `db-chain-edge-secret-store`
ClusterSecretStore:

```
adminToken     <- DB_CHAIN_TIRAMISU_BOUNCER_TOKEN
valkeyPassword <- DB_CHAIN_TIRAMISU_VALKEY_PASSWORD
```

(`DB_CHAIN_<NAME>_BOUNCER_TOKEN`, name upper-cased by `vaultNameSegment`.)
Either Doppler or `kubectl -n db-chain-network-tiramisu get secret
bouncer-secrets -o jsonpath='{.data.adminToken}' | base64 -d` yields it.

## Options, cheapest first

### A. Hand us the token — 5 minutes, no infra change

Give the indexer team `DB_CHAIN_TIRAMISU_BOUNCER_TOKEN`. We mint our own pool
straight into tiramisu's control-service:

```
cd arkiv-chain-indexer-tiramisu
RPC_CONTROL_URL=https://rpc-control.tiramisu.db-chain.testnet.arkiv.network \
RPC_CONTROL_ADMIN_TOKEN=<token> \
bun run scripts/provisionRpcKeys.ts --count 100 --quota 100000000 --out rpc-keys/keys.json
# then in .env: RPC_KEY_POOL_FILE=/app/rpc-keys/keys.json
docker compose restart scanner gap-filler backfill-scanner backend
```

The script upserts `PUT /keys/{key}` with locally generated `ark_live_…`
values (the control-service takes caller-supplied keys). Re-running merges.
Nothing else changes; the `rpc-proxy` profile stays off.

### B. Wire the production Hub to tiramisu — the intended end state

In the Hub's **prd** Doppler config:

```
CONTROL_SERVICE_URL=https://rpc-control.tiramisu.db-chain.testnet.arkiv.network
CONTROL_SERVICE_ADMIN_TOKEN=<DB_CHAIN_TIRAMISU_BOUNCER_TOKEN>
```

and rebuild `hub-prod` with build-arg `NEXT_PUBLIC_FEATURE_API_KEYS=true`
(build-time flag — `src/lib/features.ts`; the deploy workflow passes it).
After the deploy run `pnpm reproject` once (`scripts/reproject.ts`) so any
keys already in the prod DB reach the new control-service.

Then everyone — us included — mints keys the normal way, and our proxy works
unchanged with `RPC_PROXY_HUB_BASE=https://hub.arkiv.network`.

### C. One-off: project the stage Hub's keys into tiramisu too

If B is not ready and A is not wanted, a single command on the stage Hub host
makes every existing stage key (ours included) valid on tiramisu:

```
CONTROL_SERVICE_URL=https://rpc-control.tiramisu.db-chain.testnet.arkiv.network \
CONTROL_SERVICE_ADMIN_TOKEN=<DB_CHAIN_TIRAMISU_BOUNCER_TOKEN> \
pnpm reproject
```

Caveats: `reproject` sends the COMPLETE active set and the control-service
deletes anything not in it, so it must run from the stage DB, not an empty one;
keys created later are not synced (the Hub keeps projecting only to cheesecake);
usage drained from tiramisu is not accounted in the stage Hub. Good enough to
unblock an indexer, not a product setup.

### D. Not viable

- Making the tiramisu bouncer "trust Hub keys" is not a setting — there is no
  remote validation; the bouncer only knows what was `PUT` into its own
  Valkey. Cheesecake "accepting Hub keys" since 2026-08-20 simply means the
  stage Hub was pointed at cheesecake's control-service.
- Raising `ANON_RATE_LIMIT` (allowed in `spec.bouncer.settings`, e.g.
  `ANON_RATE_LIMIT: "200"`) would let the scanner crawl, but per-IP anonymous
  budgets are hourly and shared with baseload — a stopgap at best.

## What is already prepared on our side

- `arkiv-chain-indexer-tiramisu/.env` is fully tiramisu (chain id 7738577,
  RPC/faucet URLs, ports 3001/23561, `COMPOSE_PROJECT_NAME`), backfill from
  block 0, `rpc-proxy` profile off, services pointed at the public RPC.
- `RPC_PROXY_HUB_BASE` compose passthrough, for option B.
- `scripts/provisionRpcKeys.ts`, for options A.
