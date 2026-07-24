/**
 * M5 / M4-debt — readonly guard + heartbeat idle safety.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertWritable, ReadonlyModeError, isAtlasReadonly } from '../atlas/readonly-guard.js';
import {
  acquireInstanceLease,
  clearInstanceLeaseForTests,
  startInstanceLeaseHeartbeat,
  stopInstanceLeaseHeartbeat,
  DEFAULT_LEASE_TTL_MS,
} from '../atlas/instance-lease.js';
import { createGoal } from '../exec-graph/api.js';

describe('M5 M4-debt guards', () => {
  let leaseDir: string;
  let graphDir: string;

  beforeEach(() => {
    leaseDir = mkdtempSync(join(tmpdir(), 'atlas-lease-'));
    graphDir = mkdtempSync(join(tmpdir(), 'atlas-graph-'));
    process.env.ATLAS_INSTANCE_LEASE_DIR = leaseDir;
    process.env.ATLAS_EXEC_GRAPH_DIR = graphDir;
    delete process.env.ATLAS_READONLY;
    clearInstanceLeaseForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_INSTANCE_LEASE_DIR;
    delete process.env.ATLAS_EXEC_GRAPH_DIR;
    delete process.env.ATLAS_READONLY;
    clearInstanceLeaseForTests();
    rmSync(leaseDir, { recursive: true, force: true });
    rmSync(graphDir, { recursive: true, force: true });
  });

  it('assertWritable throws under ATLAS_READONLY', () => {
    process.env.ATLAS_READONLY = '1';
    expect(isAtlasReadonly()).toBe(true);
    expect(() => assertWritable('test')).toThrow(ReadonlyModeError);
  });

  it('createGoal refuses writes in readonly mode', () => {
    process.env.ATLAS_READONLY = '1';
    expect(() => createGoal({ title: 'should fail' })).toThrow(ReadonlyModeError);
  });

  it('heartbeat keeps lease fresh past TTL without takeover', async () => {
    const ttl = 200;
    const writer = acquireInstanceLease({ instanceId: 'hb-writer', ttlMs: ttl });
    expect(writer.mode).toBe('writer');
    startInstanceLeaseHeartbeat(writer.instanceId, 50);
    await new Promise((r) => setTimeout(r, ttl + 150));
    const probe = acquireInstanceLease({ instanceId: 'hb-probe', ttlMs: ttl });
    expect(probe.mode).toBe('readonly');
    stopInstanceLeaseHeartbeat(writer.instanceId);
    expect(DEFAULT_LEASE_TTL_MS).toBeGreaterThan(0);
  }, 10_000);
});
