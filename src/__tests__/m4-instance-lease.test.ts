import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireInstanceLease,
  clearInstanceLeaseForTests,
  heartbeatInstanceLease,
  releaseInstanceLease,
} from '../atlas/instance-lease.js';

describe('M4-C instance anti-fork lease', () => {
  let leaseDir: string;

  beforeEach(() => {
    leaseDir = mkdtempSync(join(tmpdir(), 'atlas-instance-lease-'));
    process.env.ATLAS_INSTANCE_LEASE_DIR = leaseDir;
    clearInstanceLeaseForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_INSTANCE_LEASE_DIR;
    rmSync(leaseDir, { recursive: true, force: true });
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
});
