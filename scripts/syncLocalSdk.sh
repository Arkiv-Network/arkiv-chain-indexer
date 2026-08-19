#!/usr/bin/env bash
# Rebuild the local Arkiv SDK checkout and refresh the copy this repo installs.
set -euo pipefail
SDK_DIR="${SDK_DIR:-/home/ubuntu/arkiv-network/arkiv-sdk-js}"
REPO_DIR="${REPO_DIR:-/home/ubuntu/arkiv-network/arkiv-chain-indexer}"

echo "==> building $SDK_DIR"
( cd "$SDK_DIR" && bun run package:test >/dev/null )

echo "==> refreshing $REPO_DIR/vendor/arkiv-sdk"
rm -rf "$REPO_DIR/vendor/arkiv-sdk"
mkdir -p "$REPO_DIR/vendor/arkiv-sdk"
tar -xzf "$SDK_DIR/arkiv-network-sdk-latest.tgz" -C "$REPO_DIR/vendor/arkiv-sdk" --strip-components=1

echo "==> reinstalling"
( cd "$REPO_DIR" && rm -rf node_modules/@arkiv-network/sdk && bun install >/dev/null )
echo "==> done: $(grep -m1 '"version"' "$REPO_DIR/node_modules/@arkiv-network/sdk/package.json")"
