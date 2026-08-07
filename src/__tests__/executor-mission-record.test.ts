/**
 * Wave 7 acceptance: a mission survives a REAL process death.
 *
 * The restart tests spawn an actual node process, kill it mid-mission, then run
 * a second process that restores from disk. Nothing is simulated: the point is
 * that a completed mutation does not run twice and a spend reservation does not
 * vanish when the first process dies without warning.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginStep,
  completeStep,
  hasCompleted,
  MissionRecordError,
  missionRecordPath,
  readMissionRecord,
  runStepOnce,
  writeMissionRecord,
  type MissionRecord,
} from '../atlas/executor/mission-record.js';

let stateDir: string;

function baseRecord(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    missionId: 'mission-restart-1',
    workOrderHash: 'a'.repeat(64),
    repoCanonicalPath: 'C:/fixture',
    worktreePath: 'C:/fixture',
    baseHead: 'b'.repeat(40),
    currentMilestone: 'implement',
    attempt: 1,
    maxAttempts: 2,
    executorSessionRef: null,
    leaseOwner: { missionId: 'mission-restart-1', workOrderId: 'wo-1' },
    spendClaimId: 'clm_restart_spend',
    evidencePath: 'C:/fixture/.atlas-evidence',
    completedSteps: [],
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = path.join(tmpdir(), `atlas-mission-${process.pid}-${Math.floor(performance.now())}`);
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
});

describe('mission record persistence', () => {
  it('round-trips a record', () => {
    writeMissionRecord(stateDir, baseRecord());
    const loaded = readMissionRecord(stateDir, 'mission-restart-1');
    expect(loaded.spendClaimId).toBe('clm_restart_spend');
    expect(loaded.completedSteps).toEqual([]);
  });

  it('refuses a record that belongs to another mission', () => {
    writeMissionRecord(stateDir, baseRecord());
    const wrong = missionRecordPath(stateDir, 'mission-other');
    writeFileSync(wrong, JSON.stringify(baseRecord({ missionId: 'mission-restart-1' })), 'utf8');
    expect(() => readMissionRecord(stateDir, 'mission-other')).toThrow(MissionRecordError);
  });

  it('reports a corrupt record instead of silently starting over', () => {
    writeFileSync(missionRecordPath(stateDir, 'mission-restart-1'), '{ not json', 'utf8');
    expect(() => readMissionRecord(stateDir, 'mission-restart-1')).toThrow(/unreadable/);
  });

  it('leaves no temp file behind after a write', () => {
    writeMissionRecord(stateDir, baseRecord());
    const leftovers = readFileSync(missionRecordPath(stateDir, 'mission-restart-1'), 'utf8');
    expect(leftovers).toContain('mission-restart-1');
    expect(existsSync(`${missionRecordPath(stateDir, 'mission-restart-1')}.${process.pid}.tmp`)).toBe(false);
  });
});

describe('idempotence', () => {
  it('refuses to begin a step that already completed', () => {
    const record = completeStep(baseRecord(), {
      stepId: 'write-health-route',
      kind: 'mutation',
      result: 'ok',
      at: '2026-08-07T00:00:01.000Z',
    });
    expect(hasCompleted(record, 'write-health-route')).toBe(true);
    expect(() => beginStep(record, 'write-health-route')).toThrow(MissionRecordError);
  });

  it('completeStep is itself idempotent', () => {
    const once = completeStep(baseRecord(), { stepId: 's', kind: 'mutation', result: 1, at: 'now' });
    const twice = completeStep(once, { stepId: 's', kind: 'mutation', result: 2, at: 'later' });
    expect(twice.completedSteps).toHaveLength(1);
  });

  it('runStepOnce executes the work once and skips it on replay', () => {
    let runs = 0;
    const first = runStepOnce(stateDir, baseRecord(), { stepId: 'mutate', kind: 'mutation', at: 'now' }, () => {
      runs += 1;
      return 'done';
    });
    expect(first.skipped).toBe(false);
    expect(runs).toBe(1);

    const replay = runStepOnce(stateDir, first.record, { stepId: 'mutate', kind: 'mutation', at: 'now' }, () => {
      runs += 1;
      return 'done';
    });
    expect(replay.skipped).toBe(true);
    expect(runs).toBe(1);
  });
});

describe('REAL process restart', () => {
  /**
   * Process 1 writes the record, performs a mutation exactly once, then dies
   * abruptly. Process 2 restores and attempts the same mutation.
   */
  const worker = `
const { runStepOnce, readMissionRecord, writeMissionRecord } = require(process.argv[2]);
const fs = require('node:fs');
const stateDir = process.argv[3];
const target = process.argv[4];
const phase = process.argv[5];

if (phase === 'first') {
  writeMissionRecord(stateDir, JSON.parse(process.argv[6]));
}
const record = readMissionRecord(stateDir, 'mission-restart-1');
const out = runStepOnce(stateDir, record, { stepId: 'append-line', kind: 'mutation', at: new Date(0).toISOString() }, () => {
  fs.appendFileSync(target, 'MUTATION\\n');
  return 'appended';
});
process.stdout.write(JSON.stringify({ skipped: out.skipped }));
if (phase === 'first') {
  // Die without cleanup, the way a crash does.
  process.kill(process.pid, 'SIGKILL');
}
`;

  it('does not re-run a completed mutation after a real kill and restart', () => {
    const modulePath = path
      .resolve(__dirname, '..', 'atlas', 'executor', 'mission-record.ts')
      .replace(/\\/g, '/');
    const workerPath = path.join(stateDir, 'worker.cjs');
    const target = path.join(stateDir, 'mutations.txt');
    writeFileSync(workerPath, worker, 'utf8');
    writeFileSync(target, '', 'utf8');

    // tsx lets the worker require the TypeScript module directly.
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (!existsSync(tsxCli)) {
      // Without tsx the real-restart proof cannot run; say so rather than pass.
      expect.fail(`tsx not available at ${tsxCli} — real restart proof cannot run`);
    }

    const first = spawnSync(
      process.execPath,
      [tsxCli, workerPath, modulePath, stateDir, target, 'first', JSON.stringify(baseRecord())],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    expect(first.stdout).toContain('"skipped":false');
    expect(readFileSync(target, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1);

    const second = spawnSync(
      process.execPath,
      [tsxCli, workerPath, modulePath, stateDir, target, 'restart'],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    );
    expect(second.stdout).toContain('"skipped":true');

    // The decisive assertion: the mutation happened exactly once across a real
    // process death, not twice.
    expect(readFileSync(target, 'utf8').trim().split('\n').filter(Boolean)).toHaveLength(1);

    // And the mission's spend reservation survived the crash.
    const restored = readMissionRecord(stateDir, 'mission-restart-1');
    expect(restored.spendClaimId).toBe('clm_restart_spend');
    expect(restored.completedSteps.map((s) => s.stepId)).toEqual(['append-line']);
  }, 180_000);
});
