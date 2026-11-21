#!/usr/bin/env bash
# Start Kinan locally as an isolated staging copy (empty data, no production keys, no scheduled jobs),
# run the smoke check against it, then stop it. Usage: npm run staging:local
set -euo pipefail
cd "$(dirname "$0")/.."
DATA=$(mktemp -d)
PORT=${PORT:-3999}
# a clean environment: nothing from production leaks in
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=staging PORT="$PORT" DATA_DIR="$DATA" RUN_JOBS=0 \
  PUBLIC_BASE_URL="http://127.0.0.1:$PORT" ADMIN_EMAIL=staging@kinan.test ADMIN_PASSWORD=staging-only-1 \
  node src/server.js > "$DATA/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$DATA"' EXIT
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
node scripts/smoke.js "http://127.0.0.1:$PORT"
grep -q "\[jobs\] not running scheduled jobs here" "$DATA/server.log" && echo "jobs: off in staging (RUN_JOBS=0)"
