#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node-v22.14.0-linux-x64/bin:$PATH"
cd "$HOME"
rm -rf atlas-repro
git clone --depth 1 https://github.com/ganbaroff/atlas-cli.git atlas-repro
cd atlas-repro
npm ci --legacy-peer-deps 2>&1 | tail -3
npx vitest run src/__tests__/m4-instance-lease.test.ts 2>&1 | tail -25
