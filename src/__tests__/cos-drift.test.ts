import { describe, it, expect } from 'vitest';
import { detectDrift, type DriftInputs } from '../atlas/cos/drift.js';
import type { TaskStatus } from '../exec-graph/contracts.js';

describe('detectDrift', () => {
  describe('unpushed-commits', () => {
    it('aheadRemote 3 -> one drift finding, ref=branch, reason contains "3 commit"', () => {
      const findings = detectDrift({ git: { branch: 'main', aheadRemote: 3, behindRemote: 0 } });
      const unpushed = findings.filter((f) => f.kind === 'unpushed-commits');
      expect(unpushed).toHaveLength(1);
      expect(unpushed[0]).toMatchObject({ kind: 'unpushed-commits', severity: 'drift', sourceAuthority: 'git', ref: 'main', evidenceFreshness: 'now' });
      expect(unpushed[0]?.reason).toContain('3 commit');
    });

    it('ahead 0 -> no finding', () => {
      const findings = detectDrift({ git: { branch: 'main', aheadRemote: 0, behindRemote: 0 } });
      expect(findings.filter((f) => f.kind === 'unpushed-commits')).toHaveLength(0);
    });

    it('git null -> one unknown finding', () => {
      const findings = detectDrift({ git: null });
      const unpushed = findings.filter((f) => f.kind === 'unpushed-commits');
      expect(unpushed).toHaveLength(1);
      expect(unpushed[0]).toMatchObject({
        kind: 'unpushed-commits',
        severity: 'unknown',
        sourceAuthority: 'git',
        reason: 'could not read git ahead/behind vs origin',
        evidenceFreshness: 'UNKNOWN',
      });
    });

    it('git undefined -> one unknown finding', () => {
      const findings = detectDrift({});
      const unpushed = findings.filter((f) => f.kind === 'unpushed-commits');
      expect(unpushed).toHaveLength(1);
      expect(unpushed[0]?.severity).toBe('unknown');
    });
  });

  describe('graph-verify-failed', () => {
    it('false -> drift', () => {
      const findings = detectDrift({ graphVerifyOk: false });
      const gv = findings.filter((f) => f.kind === 'graph-verify-failed');
      expect(gv).toHaveLength(1);
      expect(gv[0]).toMatchObject({
        kind: 'graph-verify-failed',
        severity: 'drift',
        sourceAuthority: 'exec-graph',
        reason: 'graph verify failed — on-disk snapshot diverges from the ledger rebuild',
        evidenceFreshness: 'now',
      });
    });

    it('true -> no finding', () => {
      const findings = detectDrift({ graphVerifyOk: true });
      expect(findings.filter((f) => f.kind === 'graph-verify-failed')).toHaveLength(0);
    });

    it('null -> unknown', () => {
      const findings = detectDrift({ graphVerifyOk: null });
      const gv = findings.filter((f) => f.kind === 'graph-verify-failed');
      expect(gv).toHaveLength(1);
      expect(gv[0]).toMatchObject({
        severity: 'unknown',
        reason: 'could not run graph verify',
        evidenceFreshness: 'UNKNOWN',
      });
    });
  });

  describe('stale-heartbeat', () => {
    it('ageHours 30 (>24) -> stale, freshness 30.0h', () => {
      const findings = detectDrift({ heartbeat: { ageHours: 30 } });
      const hb = findings.filter((f) => f.kind === 'stale-heartbeat');
      expect(hb).toHaveLength(1);
      expect(hb[0]).toMatchObject({
        kind: 'stale-heartbeat',
        severity: 'stale',
        sourceAuthority: 'heartbeat-file',
        evidenceFreshness: '30.0h',
      });
      expect(hb[0]?.reason).toContain('30.0h');
    });

    it('ageHours 2 -> no finding', () => {
      const findings = detectDrift({ heartbeat: { ageHours: 2 } });
      expect(findings.filter((f) => f.kind === 'stale-heartbeat')).toHaveLength(0);
    });

    it('heartbeat null -> unknown', () => {
      const findings = detectDrift({ heartbeat: null });
      const hb = findings.filter((f) => f.kind === 'stale-heartbeat');
      expect(hb).toHaveLength(1);
      expect(hb[0]).toMatchObject({
        severity: 'unknown',
        reason: 'could not read heartbeat freshness',
        evidenceFreshness: 'UNKNOWN',
      });
    });

    it('ageHours null -> unknown', () => {
      const findings = detectDrift({ heartbeat: { ageHours: null } });
      const hb = findings.filter((f) => f.kind === 'stale-heartbeat');
      expect(hb).toHaveLength(1);
      expect(hb[0]?.severity).toBe('unknown');
    });

    it('custom threshold respected', () => {
      const belowCustom = detectDrift({ heartbeat: { ageHours: 5 }, thresholds: { heartbeatStaleHours: 4 } });
      expect(belowCustom.filter((f) => f.kind === 'stale-heartbeat')).toHaveLength(1);

      const withinCustom = detectDrift({ heartbeat: { ageHours: 3 }, thresholds: { heartbeatStaleHours: 4 } });
      expect(withinCustom.filter((f) => f.kind === 'stale-heartbeat')).toHaveLength(0);
    });
  });

  describe('stuck-task', () => {
    it('two tasks, one at 50h (>48) one at 10h -> exactly one drift finding for the 50h task', () => {
      const stuckTasks: DriftInputs['stuckTasks'] = [
        { taskId: 'tsk_a', status: 'in-progress' as TaskStatus, ageHours: 50 },
        { taskId: 'tsk_b', status: 'blocked' as TaskStatus, ageHours: 10 },
      ];
      const findings = detectDrift({ stuckTasks });
      const stuck = findings.filter((f) => f.kind === 'stuck-task');
      expect(stuck).toHaveLength(1);
      expect(stuck[0]).toMatchObject({ kind: 'stuck-task', severity: 'drift', sourceAuthority: 'exec-graph', ref: 'tsk_a' });
      expect(stuck[0]?.reason).toContain('in-progress');
    });

    it('custom threshold respected', () => {
      const stuckTasks: DriftInputs['stuckTasks'] = [
        { taskId: 'tsk_c', status: 'delegated' as TaskStatus, ageHours: 12 },
      ];
      const findings = detectDrift({ stuckTasks, thresholds: { stuckTaskHours: 10 } });
      expect(findings.filter((f) => f.kind === 'stuck-task')).toHaveLength(1);

      const noFindings = detectDrift({ stuckTasks, thresholds: { stuckTaskHours: 20 } });
      expect(noFindings.filter((f) => f.kind === 'stuck-task')).toHaveLength(0);
    });

    it('empty stuckTasks -> no finding', () => {
      const findings = detectDrift({ stuckTasks: [] });
      expect(findings.filter((f) => f.kind === 'stuck-task')).toHaveLength(0);
    });

    it('undefined stuckTasks -> no finding', () => {
      const findings = detectDrift({});
      expect(findings.filter((f) => f.kind === 'stuck-task')).toHaveLength(0);
    });
  });

  it('all-clean inputs -> []', () => {
    const findings = detectDrift({
      git: { branch: 'main', aheadRemote: 0, behindRemote: 0 },
      graphVerifyOk: true,
      heartbeat: { ageHours: 1 },
      stuckTasks: [],
    });
    expect(findings).toEqual([]);
  });

  it('fixed emission order: unpushed-commits, graph-verify-failed, stale-heartbeat, stuck-task', () => {
    const inputs: DriftInputs = {
      git: { branch: 'main', aheadRemote: 2, behindRemote: 0 },
      graphVerifyOk: false,
      heartbeat: { ageHours: 30 },
      stuckTasks: [{ taskId: 'tsk_x', status: 'escalated' as TaskStatus, ageHours: 60 }],
    };
    const findings = detectDrift(inputs);
    expect(findings.map((f) => f.kind)).toEqual([
      'unpushed-commits',
      'graph-verify-failed',
      'stale-heartbeat',
      'stuck-task',
    ]);
  });

  it('determinism: two calls with same inputs -> deep-equal, inputs not mutated', () => {
    const inputs: DriftInputs = {
      git: { branch: 'main', aheadRemote: 2, behindRemote: 1 },
      graphVerifyOk: false,
      heartbeat: { ageHours: 30 },
      stuckTasks: [
        { taskId: 'tsk_x', status: 'escalated' as TaskStatus, ageHours: 60 },
        { taskId: 'tsk_y', status: 'blocked' as TaskStatus, ageHours: 1 },
      ],
    };
    const inputsSnapshot = JSON.parse(JSON.stringify(inputs));

    const first = detectDrift(inputs);
    const second = detectDrift(inputs);

    expect(first).toEqual(second);
    expect(inputs).toEqual(inputsSnapshot);
  });

  it('never throws on empty inputs object', () => {
    expect(() => detectDrift({})).not.toThrow();
  });
});
