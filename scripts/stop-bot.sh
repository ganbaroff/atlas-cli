#!/usr/bin/env bash
set -euo pipefail

if pkill -f "tsx.*telegram" 2>/dev/null; then
  echo "Bot stopped."
else
  echo "No bot process found."
fi
