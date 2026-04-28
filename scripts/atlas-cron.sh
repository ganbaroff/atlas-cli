#!/usr/bin/env bash
cd "C:/Users/user/OneDrive/Documents/GitHub/ANUS" || exit 1
mkdir -p logs

MAX_RESTARTS=100
COUNT=0
INTERVAL=1800  # 30 minutes

while [ $COUNT -lt $MAX_RESTARTS ]; do
  echo "$(date '+%Y-%m-%d %H:%M:%S') — Atlas cron wake #$COUNT" >> logs/cron.log
  npx tsx src/cli.ts ping >> logs/cron.log 2>&1
  if [ $? -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') — ping OK" >> logs/cron.log
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') — ping FAILED" >> logs/cron.log
  fi
  COUNT=$((COUNT + 1))
  sleep $INTERVAL
done
