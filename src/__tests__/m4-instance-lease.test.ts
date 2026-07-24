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
// Single-process launch: `node --import tsx script.ts`. The tsx CLI wrapper
// re-spawns node as a grandchild, so SIGKILL to the wrapper orphans the real
// script on POSIX and `close` never fires (lease stays held by a live pid).
const TSX_IMPORT = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const LEASE_MODULE = pathToFileURL(join(ROOT, 'src/atlas/instance-lease.ts')).href;

function writeTempScript(body: string): string {
  const path = join(tmpdir(), `atlas-lease-e2e-${randomUUID()}.mts`);
  writeFileSync(path, body, 'utf8');
  return path;
}

interface LeaseChild {
  kill: () => void;
  /** Resolves once the script printed its acquire result (first newline on stdout). */
  ready: Promise<void>;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function spawnLeaseScript(scriptPath: string, leaseDir: string): LeaseChild {
  const child = spawn(process.execPath, ['--import', TSX_IMPORT, scriptPath], {
    cwd: ROOT,
    env: { ...process.env, ATLAS_INSTANCE_LEASE_DIR: leaseDir, NODE_NO_WARNINGS: '1' },
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let markReady: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  child.stdout.on('data', (c) => {
    stdout += String(c);
    if (stdout.includes('\n')) markReady();
  });
  child.stderr.on('data', (c) => { stderr += String(c); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        markReady(); // never leave `ready` hanging if the child dies silently
        resolve({ code, stdout, stderr });
      });
    },
  );
  return { kill: () => child.kill('SIGKILL'), ready, done };
}

async function runLeaseScript(
  scriptPath: string,
  leaseDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return spawnLeaseScript(scriptPath, leaseDir).done;
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

    const holder = spawnLeaseScript(holderScript, leaseDir);
    await holder.ready; // holder has acquired the writer lease
    const probe = await runLeaseScript(probeScript, leaseDir);
    holder.kill();
    await holder.done;

    const probeResult = JSON.parse(probe.stdout.trim()) as { mode: string; reason?: string };
    expect(probeResult.mode).toBe('readonly');
    expect(probeResult.reason).toMatch(/another Atlas instance/);
  }, 60_000);

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

    const holder = spawnLeaseScript(holderScript, leaseDir);
    await holder.ready; // holder has acquired the writer lease
    holder.kill();
    await holder.done;
    const takeover = await runLeaseScript(probeScript, leaseDir);

    const result = JSON.parse(takeover.stdout.trim()) as { mode: string };
    expect(result.mode).toBe('writer');
  }, 60_000);
});
