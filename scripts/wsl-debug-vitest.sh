#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/node-v22.14.0-linux-x64/bin:$PATH"
cd "$HOME/atlas-repro"
cat > src/__tests__/zz-spawn-debug.test.ts <<'EOF'
import { describe, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const LEASE_MODULE = pathToFileURL(join(ROOT, 'src/atlas/instance-lease.ts')).href;

describe('spawn debug', () => {
  it('spawns tsx child and logs all events', async () => {
    const leaseDir = mkdtempSync(join(tmpdir(), 'dbg-lease-'));
    const script = join(tmpdir(), 'dbg-probe.mts');
    writeFileSync(script, `
      console.error('CHILD_BOOT pid=' + process.pid);
      import { acquireInstanceLease } from ${JSON.stringify(LEASE_MODULE)};
      console.error('CHILD_IMPORTED');
      const r = acquireInstanceLease({ instanceId: 'dbg', ttlMs: 120000 });
      console.error('CHILD_ACQUIRED');
      process.stdout.write(JSON.stringify(r) + '\n');
      console.error('CHILD_WROTE');
    `, 'utf8');

    console.error('PARENT execPath=', process.execPath, 'execArgv=', JSON.stringify(process.execArgv));
    console.error('PARENT NODE_OPTIONS=', process.env.NODE_OPTIONS);
    const child = spawn(process.execPath, [TSX, script], {
      cwd: ROOT,
      env: { ...process.env, ATLAS_INSTANCE_LEASE_DIR: leaseDir, NODE_NO_WARNINGS: '1' },
    });
    child.on('spawn', () => console.error('EV spawn pid=', child.pid));
    child.on('error', (e) => console.error('EV error', e));
    child.stdout.on('data', (c) => console.error('EV stdout:', String(c)));
    child.stderr.on('data', (c) => console.error('EV stderr:', String(c)));
    const code = await Promise.race([
      new Promise((r) => child.on('close', (c) => r(`close code=${c}`))),
      new Promise((r) => setTimeout(() => r('RACE_TIMEOUT_25s'), 25000)),
    ]);
    console.error('RESULT:', code);
    child.kill('SIGKILL');
  }, 30000);
});
EOF
npx vitest run src/__tests__/zz-spawn-debug.test.ts 2>&1 | tail -40
rm -f src/__tests__/zz-spawn-debug.test.ts
