#!/usr/bin/env bash

set -euo pipefail
set -x

docker compose down

docker compose up -d --build
