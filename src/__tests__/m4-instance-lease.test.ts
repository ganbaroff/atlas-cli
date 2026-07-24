import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireInstanceLease,
  clearInstanceLeaseForTests,
  heartbeatInstanceLease,
  releaseInstanceLease,
} from '../atlas/instance-lease.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const LEASE_MODULE = pathToFileURL(join(ROOT, 'src/atlas/instance-lease.ts')).href;

function writeTempScript(body: string): string {
  const path = join(tmpdir(), `atlas-lease-e2e-${randomUUID()}.mts`);
  writeFileSync(path, body, 'utf8');
  return path;
}

async function runLeaseScript(
  scriptPath: string,
  leaseDir: string,
  opts?: { killAfterMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX, scriptPath], {
      cwd: ROOT,
      env: { ...process.env, ATLAS_INSTANCE_LEASE_DIR: leaseDir, NODE_NO_WARNINGS: '1' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', reject);

    if (opts?.killAfterMs !== undefined) {
      setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs);
    }

    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('M4-C instance anti-fork lease', () => {
  let leaseDir: string;
  const scripts: string[] = [];

  beforeEach(() => {
    leaseDir = mkdtempSync(join(tmpdir(), 'atlas-instance-lease-'));
    process.env.ATLAS_INSTANCE_LEASE_DIR = leaseDir;
    clearInstanceLeaseForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_INSTANCE_LEASE_DIR;
    rmSync(leaseDir, { recursive: true, force: true });
    for (const s of scripts) {
      try { rmSync(s, { force: true }); } catch { /* ignore */ }
    }
    scripts.length = 0;
  });

  it('first acquire is writer', () => {
    const r = acquireInstanceLease({ instanceId: 'inst-writer-001' });
    expect(r.mode).toBe('writer');
    expect(r.instanceId).toBe('inst-writer-001');
  });

  it('spawn-two: second instance while first lease fresh → readonly', () => {
    acquireInstanceLease({ instanceId: 'inst-a', ttlMs: 60_000 });
    const second = acquireInstanceLease({ instanceId: 'inst-b', ttlMs: 60_000 });
    expect(second.mode).toBe('readonly');
    expect(second.reason).toMatch(/another Atlas instance/);
  });

  it('stale lease from dead pid allows new writer', () => {
    writeFileSync(
      join(leaseDir, 'instance-lease.json'),
      JSON.stringify({
        instanceId: 'inst-dead',
        pid: 999_999_999,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
    const r = acquireInstanceLease({ instanceId: 'inst-new', ttlMs: 60_000 });
    expect(r.mode).toBe('writer');
  });

  it('heartbeat refreshes lease; release clears file', () => {
    const r = acquireInstanceLease({ instanceId: 'inst-hb' });
    expect(heartbeatInstanceLease(r.instanceId)).toBe(true);
    releaseInstanceLease(r.instanceId);
    const again = acquireInstanceLease({ instanceId: 'inst-other' });
    expect(again.mode).toBe('writer');
  });

  it('spawn-two E2E: second Node process is readonly while first holds lease', async () => {
    const holderScript = writeTempScript(`
      import { acquireInstanceLease } from ${JSON.stringify(LEASE_MODULE)};
      const r = acquireInstanceLease({ instanceId: 'inst-holder-a', ttlMs: 120_000 });
      process.stdout.write(JSON.stringify(r) + '\\n');
      if (r.mode !== 'writer') process.exit(2);
      await new Promise((r) => setTimeout(r, 120_000));
    `);
    scripts.push(holderScript);

    const probeScript = writeTempScript(`
      import { acquireInstanceLease } from ${JSON.stringify(LEASE_MODULE)};
      const r = acquireInstanceLease({ instanceId: 'inst-probe-b', ttlMs: 120_000 });
      process.stdout.write(JSON.stringify(r) + '\\n');
    `);
    scripts.push(probeScript);

    const holderPromise = runLeaseScript(holderScript, leaseDir, { killAfterMs: 5000 });
    await new Promise((r) => setTimeout(r, 800));
    const probe = await runLeaseScript(probeScript, leaseDir);
    await holderPromise;

    const probeResult = JSON.parse(probe.stdout.trim()) as { mode: string; reason?: string };
    expect(probeResult.mode).toBe('readonly');
    expect(probeResult.reason).toMatch(/another Atlas instance/);
  }, 20_000);

  it('spawn-two E2E: after holder SIGKILL, new process acquires writer', async () => {
    const holderScript = writeTempScript(`
      import { acquireInstanceLease } from ${JSON.stringify(LEASE_MODULE)};
      const r = acquireInstanceLease({ instanceId: 'inst-crash-a', ttlMs: 120_000 });
      process.stdout.write(JSON.stringify(r) + '\\n');
      if (r.mode !== 'writer') process.exit(2);
      await new Promise((r) => setTimeout(r, 120_000));
    `);
    scripts.push(holderScript);

    const probeScript = writeTempScript(`
      import { acquireInstanceLease } from ${JSON.stringify(LEASE_MODULE)};
      const r = acquireInstanceLease({ instanceId: 'inst-takeover-b', ttlMs: 120_000 });
      process.stdout.write(JSON.stringify(r) + '\\n');
    `);
    scripts.push(probeScript);

    await runLeaseScript(holderScript, leaseDir, { killAfterMs: 500 });
    await new Promise((r) => setTimeout(r, 300));
    const takeover = await runLeaseScript(probeScript, leaseDir);

    const result = JSON.parse(takeover.stdout.trim()) as { mode: string };
    expect(result.mode).toBe('writer');
  }, 20_000);
});
