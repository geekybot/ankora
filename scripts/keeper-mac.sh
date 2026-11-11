#!/usr/bin/env bash
# Runs the testnet keeper on this Mac: keeps the Mac awake (caffeinate) and restarts the keeper if it exits.
#   ANKORA_RELAY=<you>-mocks.testnet ANKORA_POOL=<you>-ankora.testnet scripts/keeper-mac.sh
# Logs: client/keeper.log. Status: curl localhost:8080/status. Stop: Ctrl-C.
# Limits: stops when the lid closes on battery or the Mac loses network; borrows then refund (price too old).
set -euo pipefail
: "${ANKORA_RELAY:?set ANKORA_RELAY}" "${ANKORA_POOL:?set ANKORA_POOL}"
cd "$(dirname "$0")/../client"
[ -d node_modules ] || npm install --no-audit --no-fund
trap 'echo "keeper stopped"; exit 0' INT TERM
while true; do
  caffeinate -is npx tsx bin/keeper.ts >> keeper.log 2>&1 || true
  echo "$(date -u +%FT%TZ) keeper exited; restarting in 5 s" >> keeper.log
  sleep 5
done
