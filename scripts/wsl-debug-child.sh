#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/node-v22.14.0-linux-x64/bin:$PATH"
cd "$HOME/atlas-repro"
LEASE_DIR=$(mktemp -d)
cat > /tmp/lease-probe.mts <<EOF
import { acquireInstanceLease } from 'file://$HOME/atlas-repro/src/atlas/instance-lease.ts';
const r = acquireInstanceLease({ instanceId: 'debug-probe', ttlMs: 120000 });
process.stdout.write(JSON.stringify(r) + '\n');
EOF
echo "--- running child with 15s timeout ---"
ATLAS_INSTANCE_LEASE_DIR="$LEASE_DIR" timeout 15 node node_modules/tsx/dist/cli.mjs /tmp/lease-probe.mts
echo "exit code: $?"
