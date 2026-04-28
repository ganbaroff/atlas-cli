#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/telegram.log"
MAX=10

# Kill existing
pkill -f "tsx.*telegram" 2>/dev/null || true

# Load env
set -a; source "$ROOT/.env"; set +a

echo "[$(date)] Starting bot" | tee -a "$LOG"

tries=0
while [ $tries -lt $MAX ]; do
  npx tsx "$ROOT/src/telegram.ts" >> "$LOG" 2>&1
  code=$?
  tries=$((tries + 1))
  echo "[$(date)] Crashed (exit $code), restart $tries/$MAX" | tee -a "$LOG"
  [ $tries -lt $MAX ] && sleep 2
done

echo "[$(date)] Max restarts reached. Giving up." | tee -a "$LOG"
exit 1
