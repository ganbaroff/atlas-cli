#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/node-v22.14.0-linux-x64/bin:$PATH"
cd "$HOME/atlas-repro"
cp "/mnt/c/Users/user/OneDrive/Documents/GitHub/ANUS/src/__tests__/m4-instance-lease.test.ts" src/__tests__/
cp "/mnt/c/Users/user/OneDrive/Documents/GitHub/ANUS/src/__tests__/m4-kill-resume-e2e.test.ts" src/__tests__/
npx vitest run src/__tests__/m4-instance-lease.test.ts src/__tests__/m4-kill-resume-e2e.test.ts 2>&1 | tail -14
