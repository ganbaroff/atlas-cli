/**
 * runner-liveness-lease.test.ts — `runner status` must describe the
 * RUNNER, not whoever is asking.
 *
 * Regression cover for the defect found during P0 live activation
 * (2026-07-28): runnerLivenessNow() computed `authEnforcement` from
 * getSigningKey() in the READING process, so any caller that had not
 * loaded .env (a direct tsx probe, a cron script, another shell)
 * reported "off" while enforcement was actually on. The field described
 * the reader's environment and was silently wrong about the system.
 *
 * The fix: the runner declares its own state into the instance lease at
 * startup; readers report that value and never consult their own env.
 * These tests prove the reader's environment cannot change the answer
 * IN EITHER DIRECTION.
 *
 * Real lease file in a temp dir — no network, no spawn, no Supabase.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLease,
  annotateInstanceLease,
  heartbeatInstanceLease,
  clearInstanceLeaseForTests,
  getInstanceLeaseInfo,
  type InstanceLease,
} from '../atlas/instance-lease.js';
import {
  describeRunnerLiveness,
  runnerLivenessNow,
  recordRunnerStartState,
} from '../atlas/atlas-runner.js';

const KEY_ENV = 'ATLAS_QUEUE_SIGNING_KEY';

let leaseDir: string;
let savedLeaseDir: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  leaseDir = mkdtempSync(join(tmpdir(), 'atlas-lease-liveness-'));
  savedLeaseDir = process.env.ATLAS_INSTANCE_LEASE_DIR;
  savedKey = process.env[KEY_ENV];
  process.env.ATLAS_INSTANCE_LEASE_DIR = leaseDir;
});

afterEach(() => {
  clearInstanceLeaseForTests();
  if (savedLeaseDir === undefined) delete process.env.ATLAS_INSTANCE_LEASE_DIR;
  else process.env.ATLAS_INSTANCE_LEASE_DIR = savedLeaseDir;
  if (savedKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = savedKey;
  rmSync(leaseDir, { recursive: true, force: true });
});

function leaseFile(): InstanceLease {
  return JSON.parse(readFileSync(join(leaseDir, 'instance-lease.json'), 'utf8')) as InstanceLease;
}

// ── The headline regression ────────────────────────────────────────────

describe('authEnforcement is read from the lease, not the reader env', () => {
  it('a reader with NO signing key still reports the running runner as on', () => {
    // The runner starts, holding the lease, with enforcement live.
    const lease = acquireInstanceLease();
    const record = recordRunnerStartState(
      lease.instanceId,
      { getSigningKey: () => 'runner-side-key-present' },
      { status: 'unknown', reason: 'synthetic — build check not under test here' },
    );
    expect(record.recorded).toBe(true);
    expect(record.authEnforcement).toBe('on');

    // A separate reader asks — and its own environment has no key at all.
    // This is exactly the tsx probe that produced the misleading "off".
    delete process.env[KEY_ENV];

    const report = runnerLivenessNow();
    expect(report.status).toBe('running');
    expect(report.authEnforcement).toBe('on');
  });

  it('a reader WITH a signing key still reports a runner that started without one as off', () => {
    // The inverse direction: the reader's env must not manufacture a
    // false "on" either. Enforcement off is a real, reportable state.
    const lease = acquireInstanceLease();
    recordRunnerStartState(
      lease.instanceId,
      { getSigningKey: () => undefined },
      { status: 'unknown', reason: 'synthetic' },
    );

    process.env[KEY_ENV] = 'reader-side-key-that-must-be-ignored';

    expect(runnerLivenessNow().authEnforcement).toBe('off');
  });

  it('reports occupied without runner fields when a non-runner holds the lease', () => {
    acquireInstanceLease();
    process.env[KEY_ENV] = 'reader-side-key-that-must-be-ignored';

    const report = runnerLivenessNow();
    expect(report.status).toBe('occupied');
    expect(report.authEnforcement).toBeUndefined();
    expect(report.build).toBeUndefined();
  });

  it('reports not-started with no enforcement claim when there is no lease at all', () => {
    clearInstanceLeaseForTests();
    process.env[KEY_ENV] = 'reader-side-key-that-must-be-ignored';

    const report = runnerLivenessNow();
    expect(report.status).toBe('not-started');
    expect(report.authEnforcement).toBeUndefined();
  });
});

// ── Annotation durability + ownership ──────────────────────────────────

describe('annotateInstanceLease', () => {
  it('persists the declaration into the lease file', () => {
    const lease = acquireInstanceLease();
    expect(annotateInstanceLease(lease.instanceId, {
      kind: 'runner',
      authEnforcement: 'on',
    })).toBe(true);

    const onDisk = leaseFile();
    expect(onDisk.runner?.kind).toBe('runner');
    expect(onDisk.runner?.authEnforcement).toBe('on');
    expect(onDisk.runner?.recordedAt).toBeTruthy();
  });

  it('survives a heartbeat — the liveness ping must not erase the declaration', () => {
    const lease = acquireInstanceLease();
    annotateInstanceLease(lease.instanceId, {
      kind: 'runner',
      authEnforcement: 'on',
      buildFreshness: 'fresh',
    });

    expect(heartbeatInstanceLease(lease.instanceId)).toBe(true);

    const onDisk = leaseFile();
    expect(onDisk.runner?.authEnforcement).toBe('on');
    expect(onDisk.runner?.buildFreshness).toBe('fresh');
  });

  it('merges successive patches instead of replacing them', () => {
    const lease = acquireInstanceLease();
    annotateInstanceLease(lease.instanceId, { kind: 'runner', authEnforcement: 'on' });
    annotateInstanceLease(lease.instanceId, { buildFreshness: 'stale' });

    const onDisk = leaseFile();
    expect(onDisk.runner?.authEnforcement).toBe('on');
    expect(onDisk.runner?.buildFreshness).toBe('stale');
  });

  it('refuses to annotate a lease owned by another process', () => {
    const lease = acquireInstanceLease();
    const foreign = { ...leaseFile(), pid: 999_999 };
    writeFileSync(join(leaseDir, 'instance-lease.json'), JSON.stringify(foreign), 'utf8');

    expect(annotateInstanceLease(lease.instanceId, {
      kind: 'runner',
      authEnforcement: 'on',
    })).toBe(false);
    expect(getInstanceLeaseInfo()?.runner).toBeUndefined();
  });

  it('refuses a same-PID caller with the wrong acquisition identity', () => {
    acquireInstanceLease({ instanceId: 'writer-id' });

    expect(annotateInstanceLease('different-id', { kind: 'runner' })).toBe(false);
    expect(getInstanceLeaseInfo()?.runner).toBeUndefined();
  });

  it('returns false when there is no lease to annotate', () => {
    clearInstanceLeaseForTests();
    expect(annotateInstanceLease('missing-id', {
      kind: 'runner',
      authEnforcement: 'on',
    })).toBe(false);
  });

  it('reports recorded:false from the runner when it does not own the lease', () => {
    const lease = acquireInstanceLease();
    const foreign = { ...leaseFile(), pid: 999_999 };
    writeFileSync(join(leaseDir, 'instance-lease.json'), JSON.stringify(foreign), 'utf8');

    const record = recordRunnerStartState(
      lease.instanceId,
      { getSigningKey: () => 'key' },
      { status: 'unknown', reason: 'synthetic' },
    );
    expect(record.recorded).toBe(false);
    // Rejected annotation cannot make the foreign holder look like a runner.
    const report = describeRunnerLiveness(getInstanceLeaseInfo(), Date.now(), () => true);
    expect(report.status).toBe('occupied');
    expect(report.authEnforcement).toBeUndefined();
  });
});

// ── Build stamp surfaced through the same channel ──────────────────────

describe('build stamp in runner status', () => {
  it('reports which build the runner is actually executing', () => {
    const lease = acquireInstanceLease();
    const builtAt = Date.parse('2026-07-28T09:15:00.000Z');
    recordRunnerStartState(
      lease.instanceId,
      { getSigningKey: () => 'key' },
      {
        status: 'fresh',
        entryPath: 'C:\\repo\\ANUS\\dist\\cli.js',
        distMtimeMs: builtAt,
        newestSrcFile: 'C:\\repo\\ANUS\\src\\cli.ts',
        newestSrcMtimeMs: builtAt - 60_000,
      },
    );

    const report = runnerLivenessNow();
    expect(report.build?.entryPath).toContain('dist');
    expect(report.build?.builtAt).toBe('2026-07-28T09:15:00.000Z');
    expect(report.build?.freshnessAtStart).toBe('fresh');
  });

  it('records a stale-at-start runner so status shows it was overridden', () => {
    const lease = acquireInstanceLease();
    recordRunnerStartState(
      lease.instanceId,
      { getSigningKey: () => undefined },
      {
        status: 'stale',
        lagMs: 3_600_000,
        entryPath: '/repo/dist/cli.js',
        distMtimeMs: Date.parse('2026-07-20T00:00:00.000Z'),
        newestSrcFile: '/repo/src/atlas/queue-auth.ts',
        newestSrcMtimeMs: Date.parse('2026-07-20T01:00:00.000Z'),
      },
    );

    expect(runnerLivenessNow().build?.freshnessAtStart).toBe('stale');
  });

  it('omits the build block entirely when the runner could not determine one', () => {
    const lease = acquireInstanceLease();
    recordRunnerStartState(
      lease.instanceId,
      { getSigningKey: () => 'key' },
      { status: 'unknown', reason: 'not running from dist' },
    );

    const report = runnerLivenessNow();
    expect(report.authEnforcement).toBe('on');
    expect(report.build).toBeUndefined();
  });
});
