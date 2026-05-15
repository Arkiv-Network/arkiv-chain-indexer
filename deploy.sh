#!/usr/bin/env bash

set -euo pipefail
set -x

docker compose down

export BUILD_COMMIT="${BUILD_COMMIT:-$(git rev-parse HEAD)}"
export BUILD_DATE="${BUILD_DATE:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

docker compose up -d --build
