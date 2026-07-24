import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  gatherGitDrift,
  gatherHeartbeatAge,
  gatherGraphVerifyOk,
  gatherStuckTaskCandidates,
  gatherLiveDriftInputs,
} from '../atlas/cos/gather.js';

const ANUS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('gatherGitDrift (read-only, real repo)', () => {
  it('reports branch + ahead/behind for the ANUS repo itself', () => {
    const git = gatherGitDrift(ANUS_ROOT);
    expect(git).not.toBeNull();
    expect(typeof git?.branch).toBe('string');
    expect(git?.branch.length).toBeGreaterThan(0);
    expect(Number.isFinite(git?.aheadRemote)).toBe(true);
    expect(Number.isFinite(git?.behindRemote)).toBe(true);
  });

  it('returns null (never throws) for a non-repo path', () => {
    const git = gatherGitDrift(tmpdir());
    expect(git).toBeNull();
  });
});

describe('gatherHeartbeatAge (real heartbeat.md)', () => {
  it('returns a non-negative finite age, or null if unreadable — never throws', () => {
    const hb = gatherHeartbeatAge();
    expect(hb).not.toBeNull();
    if (hb?.ageHours != null) {
      expect(hb.ageHours).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(hb.ageHours)).toBe(true);
    }
  });
});

describe('gatherGraphVerifyOk (real ledger)', () => {
  it('returns a boolean (on-disk snapshot matches a fresh ledger rebuild) — never throws', () => {
    const ok = gatherGraphVerifyOk();
    expect(typeof ok).toBe('boolean');
  });
});

describe('gatherStuckTaskCandidates (real graph)', () => {
  it('returns only non-terminal tasks with a finite non-negative ageHours', () => {
    const candidates = gatherStuckTaskCandidates();
    expect(Array.isArray(candidates)).toBe(true);
    for (const c of candidates ?? []) {
      expect(['verified', 'rejected', 'closed']).not.toContain(c.status);
      expect(c.ageHours).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.ageHours)).toBe(true);
      expect(typeof c.taskId).toBe('string');
    }
  });

  it('is deterministic for a fixed injected `now`', () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    expect(gatherStuckTaskCandidates(now)).toEqual(gatherStuckTaskCandidates(now));
  });
});

describe('gatherLiveDriftInputs (composition, real environment)', () => {
  it('shapes match DriftInputs and detectDrift never throws on the real output', async () => {
    const inputs = gatherLiveDriftInputs(ANUS_ROOT);
    expect(inputs).toHaveProperty('git');
    expect(inputs).toHaveProperty('heartbeat');
    expect(inputs).toHaveProperty('graphVerifyOk');
    expect(inputs).toHaveProperty('stuckTasks');

    const { detectDrift } = await import('../atlas/cos/drift.js');
    expect(() => detectDrift(inputs)).not.toThrow();
  });
});
