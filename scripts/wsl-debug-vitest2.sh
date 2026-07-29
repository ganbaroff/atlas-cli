#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/node-v22.14.0-linux-x64/bin:$PATH"
cd "$HOME/atlas-repro"
cat > src/__tests__/zz-spawn-debug2.test.ts <<'EOF'
import { describe, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const LEASE_MODULE = pathToFileURL(join(ROOT, 'src/atlas/instance-lease.ts')).href;

describe('spawn debug 2 — exact holder replica', () => {
  it('holder child: stdout must arrive while child still alive', async () => {
    const leaseDir = mkdtempSync(join(tmpdir(), 'dbg2-lease-'));
    const script = join(tmpdir(), 'dbg2-holder.mts');
    // exact replica of the real holder script body
    writeFileSync(script, `
      import { acquireInstanceLease } from ${JSON.stringify(LEASE_MODULE)};
      const r = acquireInstanceLease({ instanceId: 'inst-holder-a', ttlMs: 120_000 });
      process.stdout.write(JSON.stringify(r) + '\\n');
      if (r.mode !== 'writer') process.exit(2);
      await new Promise((r) => setTimeout(r, 120_000));
    `, 'utf8');

    const child = spawn(process.execPath, [TSX, script], {
      cwd: ROOT,
      env: { ...process.env, ATLAS_INSTANCE_LEASE_DIR: leaseDir, NODE_NO_WARNINGS: '1' },
      windowsHide: true,
    });
    child.on('spawn', () => console.error('EV spawn pid=', child.pid));
    child.on('error', (e) => console.error('EV error', e));
    child.on('close', (c, s) => console.error('EV close', c, s));
    child.stdout.on('data', (c) => console.error('EV stdout:', JSON.stringify(String(c))));
    child.stderr.on('data', (c) => console.error('EV stderr:', String(c)));
    await new Promise((r) => setTimeout(r, 20000));
    console.error('DONE_WAITING 20s');
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', () => r(null)));
  }, 30000);
});
EOF
npx vitest run src/__tests__/zz-spawn-debug2.test.ts 2>&1 | tail -30
rm -f src/__tests__/zz-spawn-debug2.test.ts
