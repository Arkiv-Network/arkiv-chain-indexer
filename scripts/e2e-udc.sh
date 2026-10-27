#!/usr/bin/env bash
# End-to-end check of the explorer on a throwaway UDC chain (docs/udc-e2e.md):
#
#   devnet up (scripts/udc-devnet.py) → explorer compose up (project
#   arkiv-explorer-e2e, docker-compose.yml + docker-compose.prefill.yml) →
#   node smoke exercise + SDK network-health + scripts/udcExplorerTraffic.ts
#   (with a decoder outage and a scanner restart in the middle) → wait for the
#   index → scripts/verifyUdcExplorer.ts → compareEntityQuery at the
#   checkpoints → Postgres dump grep for bytes contents → optional screenshots
#   → teardown.
#
# Usage: scripts/e2e-udc.sh [--keep] [--no-chaos] [--screenshots] [--skip-explorer]
#                           [--skip-smoke] [--skip-health] [--no-build]
#
#   --keep           leave the devnet and the explorer running (and print where)
#   --no-chaos       skip the decoder outage and scanner restart
#   --screenshots    Playwright screenshots (needs `bun install` and
#                    `bunx playwright install chromium` in this checkout)
#   --skip-explorer  devnet, traffic and the node-side checks only
#   --skip-smoke / --skip-health   leave out those traffic stages
#   --no-build       reuse the compose images already built
#
# Environment:
#   NODE_DIR             arkiv-state-db-experiment checkout (read only)
#   ARKIV_PROPOSER_BIN   arkiv-proposer release binary
#   ARKIV_SDK_DIR        built arkiv-sdk-js 0.9.0-next checkout, with test/ installed
#   UDC_E2E_DIR          state, logs and reports (default ~/.cache/arkiv-udc-e2e)
#   ARKIV_DECODER_IMAGE  an existing decoder image to run as is (default: compose builds
#                        the decoder from the commit docker-compose.yml pins)
#   E2E_INDEX_TIMEOUT    seconds to wait for the index to reach the traffic's end (default 600)
#
# Secrets (account keys, the private-control token) stay in the devnet's
# 0600 secrets.json and reach child processes through their environment only.
set -euo pipefail

IDX="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NODE_DIR="${NODE_DIR:-$(dirname "$IDX")/arkiv-state-db-experiment}"
export ARKIV_PROPOSER_BIN="${ARKIV_PROPOSER_BIN:-$NODE_DIR/target/release/arkiv-proposer}"
ARKIV_SDK_DIR="${ARKIV_SDK_DIR:-$(dirname "$IDX")/arkiv-sdk-js}"
export UDC_E2E_DIR="${UDC_E2E_DIR:-$HOME/.cache/arkiv-udc-e2e}"
DECODER_IMAGE="${ARKIV_DECODER_IMAGE:-}"
INDEX_TIMEOUT="${E2E_INDEX_TIMEOUT:-600}"
PROJECT=arkiv-explorer-e2e
BACKEND=http://127.0.0.1:13101
FRONTEND=http://127.0.0.1:23661
NODE_RPC=http://127.0.0.1:28545

KEEP=0 CHAOS=1 SHOTS=0 EXPLORER=1 SMOKE=1 HEALTH=1 BUILD=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-chaos) CHAOS=0 ;;
    --screenshots) SHOTS=1 ;;
    --skip-explorer) EXPLORER=0 ;;
    --skip-smoke) SMOKE=0 ;;
    --skip-health) HEALTH=0 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

STATE="$UDC_E2E_DIR"
RUN="$STATE/devnet"
LOGS="$STATE/logs"
TS="$STATE/ts"
ENV_FILE="$STATE/explorer.env"
ADMIN_TOKEN_FILE="$STATE/explorer-admin-token"
ADMIN_EMAIL=udc-e2e@example.com
MANIFEST="$STATE/manifest.json"
mkdir -p "$STATE" "$LOGS"
FAILURES=()

say() { printf '\n==> %s\n' "$*"; }
note_failure() { FAILURES+=("$1"); printf 'FAILED: %s\n' "$1"; }
dc() {
  sg docker -c "$(printf '%q ' docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$IDX/docker-compose.yml" -f "$IDX/docker-compose.prefill.yml" "$@")"
}
# One value from the devnet's 0600 secrets.json: `secret token` or `secret key <account>`.
# Callers export it inside a subshell, so it never lands in argv or on stdout.
secret() {
  python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
print(d["privateControlToken"] if sys.argv[2] == "token" else d["accounts"][sys.argv[3]]["privateKey"])' \
    "$RUN/secrets.json" "$@"
}

teardown() {
  local code=$?
  if [ -n "${CHAOS_PID:-}" ]; then kill "$CHAOS_PID" 2>/dev/null || true; fi
  if [ "$KEEP" = 1 ]; then
    say "kept: devnet $NODE_RPC (udc-e2e-node), explorer $BACKEND / $FRONTEND (project $PROJECT)"
    echo "    tear down: docker compose -p $PROJECT --env-file $ENV_FILE -f docker-compose.yml -f docker-compose.prefill.yml down -v"
    echo "               UDC_E2E_DIR=$UDC_E2E_DIR python3 scripts/udc-devnet.py down --purge"
    exit "$code"
  fi
  say "teardown"
  if [ "$EXPLORER" = 1 ] && [ -f "$ENV_FILE" ]; then dc down -v --remove-orphans >"$LOGS/compose-down.log" 2>&1 || true; fi
  python3 "$IDX/scripts/udc-devnet.py" down --purge || true
  exit "$code"
}
trap teardown EXIT

say "preflight"
[ -x "$ARKIV_PROPOSER_BIN" ] || { echo "no arkiv-proposer at $ARKIV_PROPOSER_BIN (set ARKIV_PROPOSER_BIN)" >&2; exit 1; }
[ -f "$NODE_DIR/scripts/udc-sdk-smoke.ts" ] || { echo "no NODE_DIR checkout at $NODE_DIR" >&2; exit 1; }
[ -d "$ARKIV_SDK_DIR/node_modules/viem" ] || { echo "ARKIV_SDK_DIR=$ARKIV_SDK_DIR is not a built SDK checkout" >&2; exit 1; }
if [ "$HEALTH" = 1 ] && [ ! -d "$ARKIV_SDK_DIR/test/node_modules" ]; then
  echo "no $ARKIV_SDK_DIR/test/node_modules (cd test && bun install), or pass --skip-health" >&2; exit 1
fi
if [ "$EXPLORER" = 1 ] && [ -n "$DECODER_IMAGE" ] && ! sg docker -c "docker image inspect $(printf %q "$DECODER_IMAGE")" >/dev/null 2>&1; then
  echo "decoder image $DECODER_IMAGE not found (build it, or unset ARKIV_DECODER_IMAGE for the compose pin)" >&2; exit 1
fi
echo "node $NODE_DIR ($(git -C "$NODE_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')), sdk $ARKIV_SDK_DIR, decoder ${DECODER_IMAGE:-built from the docker-compose.yml pin}"

# The harness's TypeScript runs from a directory whose node_modules links the
# UDC SDK and its viem, independent of this checkout's dependencies.
rm -rf "$TS"
mkdir -p "$TS/node_modules/@arkiv-network"
ln -s "$ARKIV_SDK_DIR" "$TS/node_modules/@arkiv-network/sdk"
ln -s "$ARKIV_SDK_DIR/node_modules/viem" "$TS/node_modules/viem"
cp "$IDX"/scripts/{udcE2eModel,udcE2eNodeTruth,udcExplorerApi,udcExplorerTraffic,verifyUdcExplorer}.ts "$TS/"
cp "$NODE_DIR/scripts/udc-sdk-smoke.ts" "$TS/"

say "devnet up"
python3 "$IDX/scripts/udc-devnet.py" up

if [ "$EXPLORER" = 1 ]; then
  say "explorer up (project $PROJECT)"
  mkdir -p "$STATE/explorer-artifacts" "$STATE/rpc-keys"
  # /shadow-rpc is an admin surface: the verifier signs in with token login.
  # The token lives in two 0600 files (it and the env file) and nowhere else.
  (umask 077; python3 -c 'import secrets,sys; open(sys.argv[1],"w").write(secrets.token_urlsafe(32))' "$ADMIN_TOKEN_FILE")
  (umask 077; : >"$ENV_FILE")
  cat >"$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
SCANNER_RPC_FULL_NODE=http://udc-e2e-node:8545
SHADOW_RPC_UPSTREAM=http://udc-e2e-node:8545
SHADOW_RPC_UPSTREAM_RATE_LIMIT_PER_MINUTE=0
PREFILL_NETWORK=arkiv-udc-e2e
PREFILL_ARTIFACTS=$STATE/explorer-artifacts
ENTITY_INDEX_GENESIS_PROGRESS_FILE=/tmp/genesis-import-progress.json
RPC_PROXY_UPSTREAM=http://unused.invalid
RPC_KEY_DIR=$STATE/rpc-keys
SAVE_TRANSACTION_DATA=true
ENTITY_QUERY_INDEX=true
ENTITY_INDEX_GENESIS=auto
SCANNER_OLDEST_BACKFILL_BLOCK=0
SCANNER_DISABLE_BACKFILL=false
SCANNER_POLL_MS=500
SCANNER_RETRY_MS=2000
SCANNER_TRACK_BALANCES=false
GAP_FILL_INTERVAL_MS=10000
BACKEND_HOST=127.0.0.1
BACKEND_PORT=13101
FRONTEND_HOST=127.0.0.1
FRONTEND_PORT=23661
VITE_NETWORK_NAME=UDC e2e devnet
VITE_TOKEN_SYMBOL=GLM
VITE_BLOCK_TIME_MS=500
VITE_NO_BATCHER=true
BUILD_COMMIT=$(git -C "$IDX" rev-parse --short HEAD)
AUTH_PUBLIC_ORIGIN=$BACKEND
AUTH_INSECURE_LOCALHOST=true
AUTH_TOKEN_LOGIN_ENABLED=true
AUTH_ADMIN_EMAILS=$ADMIN_EMAIL
EOF
  printf 'AUTH_TOKEN_LOGIN_TOKEN=%s\n' "$(cat "$ADMIN_TOKEN_FILE")" >>"$ENV_FILE"
  if [ -n "$DECODER_IMAGE" ]; then printf 'ARKIV_DECODER_IMAGE=%s\n' "$DECODER_IMAGE" >>"$ENV_FILE"; fi
  up_args=(up -d)
  if [ "$BUILD" = 1 ] && [ -n "$DECODER_IMAGE" ]; then
    # A given decoder image runs as is: `up --build` would rebuild its name
    # from the compose pin, so build every other image and start without building.
    services=$(dc config --services | grep -vx decoder | tr '\n' ' ')
    # shellcheck disable=SC2086
    if ! dc build $services >"$LOGS/compose-build.log" 2>&1; then
      tail -20 "$LOGS/compose-build.log"; note_failure "compose build"; exit 1
    fi
    up_args=(up -d --no-build)
  elif [ "$BUILD" = 1 ]; then
    up_args=(up -d --build)
  fi
  if ! dc "${up_args[@]}" >"$LOGS/compose-up.log" 2>&1; then
    tail -20 "$LOGS/compose-up.log"; note_failure "compose up"; exit 1
  fi
  for _ in $(seq 1 120); do
    curl -sf "$BACKEND/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "$BACKEND/health" >/dev/null || { note_failure "backend /health"; exit 1; }
  echo "backend $BACKEND, frontend $FRONTEND"
fi

if [ "$SMOKE" = 1 ]; then
  say "node smoke exercise (udc-sdk-smoke.ts)"
  if (cd "$TS" && export SDK_RPC_URL="$NODE_RPC" SDK_PRIVATE_URL=http://127.0.0.1:28546 \
      SDK_REPORT_FILE="$STATE/smoke-report.json" && export ARKIV_PROPOSER_TOKEN="$(secret token)" \
      && bun udc-sdk-smoke.ts exercise) >"$LOGS/smoke.log" 2>&1; then
    grep -E '^ok:' "$LOGS/smoke.log" | cut -c1-140 || true
  else
    tail -c 2000 "$LOGS/smoke.log"; note_failure "smoke exercise"
  fi
fi

if [ "$HEALTH" = 1 ]; then
  say "SDK network-health (known failure: paging; at 500 ms blocks also block timing and the 5-block expiry)"
  (cd "$ARKIV_SDK_DIR/test" && export RPC_URL="$NODE_RPC" && export PRIVATE_KEY="$(secret key health)" \
    && bun test src/network-health.test.ts) >"$LOGS/network-health.log" 2>&1 || true
  grep -E '^\(fail\)|^ *[0-9]+ (pass|fail)$' "$LOGS/network-health.log" | sed 's/^(fail) Network health check ([^)]*) > /(fail) /' || true
fi

if [ "$EXPLORER" = 1 ] && [ "$CHAOS" = 1 ]; then
  ( set +e
    sleep 6; echo "chaos: decoder down $(date -u +%T)"; dc stop decoder
    sleep 12; echo "chaos: decoder up $(date -u +%T)"; dc start decoder
    sleep 4; echo "chaos: scanner restart $(date -u +%T)"; dc restart scanner ) >"$LOGS/chaos.log" 2>&1 &
  CHAOS_PID=$!
fi

say "explorer traffic (udcExplorerTraffic.ts)"
if (cd "$TS" && bun udcExplorerTraffic.ts --devnet "$RUN/devnet.json" --out "$MANIFEST") >"$LOGS/traffic.log" 2>&1; then
  grep -E '^ok:|^mined|^refused|^UNEXPECTED|DONE' "$LOGS/traffic.log" | cut -c1-160 || true
else
  tail -40 "$LOGS/traffic.log" | cut -c1-300; note_failure "traffic"; exit 1
fi
if [ -n "${CHAOS_PID:-}" ]; then
  wait "$CHAOS_PID" || note_failure "chaos step"
  CHAOS_PID=
  grep '^chaos:' "$LOGS/chaos.log" || true
fi

if [ "$EXPLORER" = 1 ]; then
  say "verify (index vs node at the traffic's end)"
  set +e
  (cd "$TS" && bun verifyUdcExplorer.ts --node "$NODE_RPC" --manifest "$MANIFEST" --explorer "$BACKEND" \
    --wait-seconds "$INDEX_TIMEOUT" --admin-token-file "$ADMIN_TOKEN_FILE" --admin-email "$ADMIN_EMAIL" \
    --truth-out "$STATE/truth.json" --report "$STATE/verify-report.json") \
    2>&1 | tee "$LOGS/verify.log" | cut -c1-220
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" = 0 ] || note_failure "verify"

  say "compareEntityQuery (node vs /shadow-rpc/experimental) at the checkpoints"
  for point in $(python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["checkpoints"]; print(0, c["mid"], c["afterExpiry"], c["end"])' "$MANIFEST"); do
    if bun "$IDX/scripts/compareEntityQuery.ts" --node "$NODE_RPC" --index "$BACKEND/shadow-rpc/experimental" \
        --at-block "$point" --since-block 0 --report "$STATE/compare-$point.json" >"$LOGS/compare-$point.log" 2>&1; then
      echo "block $point: no differences"
    else
      echo "block $point: differences (see $LOGS/compare-$point.log)"; tail -5 "$LOGS/compare-$point.log" | cut -c1-200 || true
      note_failure "compareEntityQuery at $point"
    fi
  done

  say "Postgres dump: no bytes contents"
  dc exec -T postgres pg_dump -U gas -d gas >"$STATE/pg-dump.sql" 2>"$LOGS/pg-dump.log" || note_failure "pg_dump"
  if ! python3 - "$MANIFEST" "$STATE/pg-dump.sql" <<'EOF'
import base64, json, sys
manifest = json.load(open(sys.argv[1]))
dump = open(sys.argv[2], "rb").read()
needles = []
for m in manifest["bytesMarkers"]:
    text = m["text"].encode()
    needles += [(m["label"], text), (m["label"], m["hex"][2:].encode()), (m["label"], m["hex"][2:].upper().encode())]
    for shift in range(3):  # base64 of the text at any alignment
        needles.append((m["label"], base64.b64encode(b"\0" * shift + text)[4:-4]))
for label in ("alpha", "beta", "gamma"):  # the genesis prefill's bytes
    text = f"prefilled {label}".encode()
    needles += [(f"prefill {label}", text), (f"prefill {label}", text.hex().encode())]
found = sorted({label for label, needle in needles if needle and needle in dump})
print(f"{len(dump)} bytes dumped, {len(needles)} needles, found: {', '.join(found) or 'none'}")
sys.exit(1 if found else 0)
EOF
  then note_failure "bytes contents in the Postgres dump"; fi

  if [ "$SHOTS" = 1 ]; then
    say "screenshots"
    if [ -d "$IDX/node_modules/playwright" ]; then
      bun "$IDX/scripts/udcE2eScreenshots.ts" "$FRONTEND" "$MANIFEST" "$STATE/screenshots" || note_failure "screenshots"
    else
      echo "skipped: no playwright in $IDX/node_modules (bun install && bunx playwright install chromium)"
    fi
  fi
else
  say "node-side checks (no explorer)"
  set +e
  (cd "$TS" && bun verifyUdcExplorer.ts --node "$NODE_RPC" --manifest "$MANIFEST" --node-only \
    --truth-out "$STATE/truth.json" --report "$STATE/verify-report.json") 2>&1 | tee "$LOGS/verify.log" | cut -c1-220
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" = 0 ] || note_failure "node-side verify"
fi

say "result"
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "E2E PASSED (logs and reports in $STATE)"
else
  printf 'E2E FAILED: %s\n' "${FAILURES[@]}"
  echo "logs and reports in $STATE"
  exit 1
fi
