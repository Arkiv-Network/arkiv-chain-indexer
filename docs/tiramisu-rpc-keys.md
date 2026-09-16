# Kalarepa: direct Tiramisu bouncer key

Kalarepa uses one locally generated RPC key registered directly in Tiramisu's
bouncer. The scanner, gap filler, backfill scanner and Baseload workers share
the key through `RPC_KEY_POOL_FILE`; forwarded backend requests use the same
value in `SHADOW_RPC_UPSTREAM_API_KEY`. Keys are sent as `X-Api-Key` headers,
not embedded in node URLs. The Hub browser generator and pooled proxy stay off.

## Provisioning

The bouncer's control service accepts caller-generated key values through
`PUT /keys/{key}`. Its administrator credential is
`DB_CHAIN_TIRAMISU_BOUNCER_TOKEN` in Doppler project `db-chain-edge`, config
`testnet`. It is distinct from Kalarepa's login token, the deployment-page
administrator key, and the RPC key being created.

Fetch the current credential into the environment without printing it:

```sh
export RPC_CONTROL_URL=https://rpc-control.tiramisu.db-chain.testnet.arkiv.network
export RPC_CONTROL_ADMIN_TOKEN="$(doppler secrets get DB_CHAIN_TIRAMISU_BOUNCER_TOKEN \
  --project db-chain-edge --config testnet --plain)"
umask 077
bun run scripts/provisionRpcKeys.ts --source control --count 1 \
  --quota 1000000000000000 --out rpc-keys/kalarepa.json --verify
```

The script generates a random `ark_live_` key and registers it as active. The
quota is a large monthly cost-unit allowance, not an unlimited flag. It does
not alter the bouncer's request-rate limit. Reusing the same output file keeps
and re-registers its existing key; it does **not** rotate it. `--source control`
is required: the script's default source is the older Hub generator.

Keep the key file and `.env` owner-readable only and out of Git. Set these in
Kalarepa's private `.env`:

```dotenv
COMPOSE_PROFILES=
SCANNER_RPC_FULL_NODE=https://rpc.tiramisu.db-chain.testnet.arkiv.network
BASELOAD_RPC_NODE=https://rpc.tiramisu.db-chain.testnet.arkiv.network
SHADOW_RPC_UPSTREAM=https://rpc.tiramisu.db-chain.testnet.arkiv.network
RPC_KEY_POOL_FILE=/app/rpc-keys/kalarepa.json
SHADOW_RPC_UPSTREAM_API_KEY=<same key from kalarepa.json>
SCANNER_RPC_API_KEY=
BASELOAD_RPC_KEY_SERVICE_URL=
```

Compose mounts `./rpc-keys` at `/app/rpc-keys`. The one-key file requires the
September 16 fix to `attachRpcKeyRing`; older builds ignored files with exactly
one key. Build the affected images, then recreate the running consumers:

```sh
docker compose build scanner gap-filler backend backfill-scanner
docker compose up -d --wait --no-deps --no-build scanner gap-filler backend
docker compose up --no-start --no-deps --no-build backfill-scanner
```

That last command preserves Kalarepa's paused backfill. For a deployment where
backfill is already running, recreate it with the other running consumers.
Verify a keyed `eth_chainId` returns `0x7614d1`, scanner progress advances, and
scanner/Baseload logs stop reporting `ANON_RATE_LIMITED`. A successful anonymous
RPC request is not evidence that a key works.

## Rotation and recovery

There is no scheduled minting or quota-driven rotation in this setup. To replace
the credential with overlap, provision a replacement using a **new output file**,
verify it with a keyed RPC request, update the active key file and backend key,
and recreate the consumers. After they authenticate with the replacement,
deactivate the old value using `DELETE /keys/{oldKey}` with control-service auth.
Consumers load their key file at startup; changing the file alone is insufficient.

The bouncer also supports `POST /keys/{oldKey}/rotate` with body
`{"key":"<newKey>"}`. It preserves configuration and current-period usage but
invalidates the old key immediately, so coordinate the consumer restart when
using that endpoint. Rotation does not reset quota.

A direct key exists in the bouncer projection, not the Hub's database. A full
Hub reprojection can remove it, and a Valkey reset loses it. Re-register the
saved key with the provisioning command above if that happens. An administrator
`401 invalid token` requires the current Doppler credential; generating another
RPC key cannot repair an outdated control-service token.

## Earlier proxy setup

Kalarepa previously used `api-key-generator` in the `rpc-proxy` Compose profile
to mint network-specific Hub keys and refill a rotating pool automatically. It
was retired on September 8 after browser minting failures left the proxy without
usable keys. Those optional services remain in Compose for other deployments.
