import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildControlContext,
  describeControlBlock,
  nextControlState,
  parseControlCommand,
  validateControlState,
  activeHardOverlays,
  effectivelyPaused,
} from '../atlas/control-plane.js';

describe('control plane', () => {
  it('parses slash and plain control commands', () => {
    expect(parseControlCommand('/pause maintenance')).toEqual({
      command: 'pause',
      note: 'maintenance',
    });
    expect(parseControlCommand('reroute browser-proof')).toEqual({
      command: 'reroute',
      lane: 'browser-proof',
    });
    expect(parseControlCommand('hello there')).toBeNull();
  });

  it('does not treat caveman style escape as control stop', () => {
    expect(parseControlCommand('stop caveman')).toBeNull();
    expect(parseControlCommand('stop caveman please')).toBeNull();
    expect(parseControlCommand('/stop maintenance')).toEqual({
      command: 'stop',
      note: 'maintenance',
    });
  });

  it('transitions pause, resume, and reroute in one state machine', () => {
    const initial = {
      phase: { next: 'pick next lane' },
      control: { mode: 'active' as const, next_lane: 'pick next lane' },
    };

    const rerouted = nextControlState(initial, { command: 'reroute', lane: 'browser-proof' }, 'cli');
    expect(rerouted.state.phase?.next).toBe('browser-proof');
    expect(rerouted.state.control?.next_lane).toBe('browser-proof');
    expect(rerouted.message).toBe('Control rerouted to browser-proof.');

    const paused = nextControlState(rerouted.state, { command: 'pause' }, 'cli');
    expect(paused.state.control?.mode).toBe('paused');
    expect(describeControlBlock(paused.state)).toBe('Control paused. Use /resume.');

    const resumed = nextControlState(paused.state, { command: 'resume' }, 'cli');
    expect(resumed.state.control?.mode).toBe('active');
    expect(resumed.message).toBe('Control resumed.');
  });

  it('builds prompt context and validates state', () => {
    const state = {
      phase: { next: 'browser-proof' },
      control: {
        mode: 'active' as const,
        next_lane: 'browser-proof',
        last_validation: {
          at: '2026-05-31T00:00:00.000Z',
          passed: true,
          issues: [],
          summary: 'control state valid',
        },
      },
    };

    expect(buildControlContext(state)).toContain('browser-proof');
    expect(buildControlContext(state)).toContain('active');

    const validation = validateControlState(state);
    expect(validation.passed).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });

  it('flags drift between phase.next and control.next_lane', () => {
    const validation = validateControlState({
      phase: { next: 'browser-proof' },
      control: { mode: 'active' as const, next_lane: 'executor-proof' },
    });

    expect(validation.passed).toBe(false);
    expect(validation.issues).toContain('phase.next and control.next_lane drift: browser-proof != executor-proof');
  });

  it('M7: resume reports active hard overlays when env pause is set', () => {
    const initial = {
      phase: { next: 'test-lane' },
      control: { mode: 'paused' as const, next_lane: 'test-lane' },
    };
    const priorPause = process.env.ATLAS_PAUSE;
    process.env.ATLAS_PAUSE = '1';
    try {
      const result = nextControlState(initial, { command: 'resume' }, 'telegram');
      expect(result.state.control?.mode).toBe('active');
      expect(result.message).toContain('WARNING');
      expect(result.message).toContain('ATLAS_PAUSE env var');
    } finally {
      if (priorPause === undefined) delete process.env.ATLAS_PAUSE;
      else process.env.ATLAS_PAUSE = priorPause;
    }
  });

  it('M7: resume without hard overlays has no WARNING', () => {
    const initial = {
      phase: { next: 'test-lane' },
      control: { mode: 'paused' as const, next_lane: 'test-lane' },
    };
    const priorPause = process.env.ATLAS_PAUSE;
    delete process.env.ATLAS_PAUSE;
    try {
      const result = nextControlState(initial, { command: 'resume' }, 'telegram');
      expect(result.message).toBe('Control resumed.');
      expect(result.message).not.toContain('WARNING');
    } finally {
      if (priorPause !== undefined) process.env.ATLAS_PAUSE = priorPause;
    }
  });

  it('M7: effectivelyPaused returns true when control-state is paused', () => {
    const state = {
      control: { mode: 'paused' as const, next_lane: 'test' },
    };
    expect(effectivelyPaused(state)).toBe(true);
  });

  it('M7: effectivelyPaused returns true when ATLAS_PAUSE env is set even if control is active', () => {
    const state = {
      control: { mode: 'active' as const, next_lane: 'test' },
    };
    const prior = process.env.ATLAS_PAUSE;
    process.env.ATLAS_PAUSE = '1';
    try {
      expect(effectivelyPaused(state)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.ATLAS_PAUSE;
      else process.env.ATLAS_PAUSE = prior;
    }
  });

  it('M7: effectivelyPaused returns false when both control-active and no env pause', () => {
    const state = {
      control: { mode: 'active' as const, next_lane: 'test' },
    };
    const prior = process.env.ATLAS_PAUSE;
    delete process.env.ATLAS_PAUSE;
    try {
      expect(effectivelyPaused(state)).toBe(false);
    } finally {
      if (prior !== undefined) process.env.ATLAS_PAUSE = prior;
    }
  });

  it('M7: pause -> goal/task blocked -> resume -> allowed round-trip', () => {
    // Simulate the round-trip with temp state
    const initial = {
      phase: { next: 'test-lane' },
      control: { mode: 'active' as const, next_lane: 'test-lane' },
    };

    // Step 1: Pause
    const paused = nextControlState(initial, { command: 'pause' }, 'telegram');
    expect(paused.state.control?.mode).toBe('paused');
    expect(effectivelyPaused(paused.state)).toBe(true);

    // Step 2: Resume
    const prior = process.env.ATLAS_PAUSE;
    delete process.env.ATLAS_PAUSE;
    try {
      const resumed = nextControlState(paused.state, { command: 'resume' }, 'telegram');
      expect(resumed.state.control?.mode).toBe('active');
      expect(effectivelyPaused(resumed.state)).toBe(false);
    } finally {
      if (prior !== undefined) process.env.ATLAS_PAUSE = prior;
    }
  });

  it('accepts retry-aware evaluation chain when proof is durable', () => {
    const tracePath = resolve(process.cwd(), 'README.md');
    const validation = validateControlState({
      phase: { next: 'evaluator loop' },
      control: { mode: 'active' as const, next_lane: 'evaluator loop' },
      last_run: {
        proof_tokens: ['proof:result-quality'],
        trace_path: tracePath,
        evaluation: {
          passed: true,
          score: 100,
          summary: 'Result quality passed after retry.',
          issues: [],
          evaluated_at: '2026-06-01T00:00:00.000Z',
          evaluator: 'atlas-operator-evaluator',
          final_verdict: 'passed',
          retryable_route: true,
          retry_used: true,
          source_result_path: tracePath,
          retry_result_path: tracePath,
          winning_result_path: tracePath,
          result_chain_paths: [tracePath, tracePath],
          evidence_chain_paths: [tracePath],
          attempts: [
            {
              attempt: 'source',
              result_path: tracePath,
              result_status: 'success',
              verdict: 'blocked',
              score: 40,
              summary: 'Source result failed quality.',
              issues: [],
              proof_tokens: ['proof:source'],
              evidence_paths: [tracePath],
            },
            {
              attempt: 'retry',
              result_path: tracePath,
              result_status: 'success',
              verdict: 'passed',
              score: 100,
              summary: 'Retry passed quality.',
              issues: [],
              proof_tokens: ['proof:retry'],
              evidence_paths: [tracePath],
            },
          ],
        },
        promotion: {
          promoted: true,
          status: 'promoted',
          reason: 'promotion passed: evaluator verdict and durable proof present',
          safe_reply: 'Не подтверждено. Проверю.',
          proof_tokens: ['proof:result-quality'],
          current_turn_proof_tokens: [],
          winning_result_path: tracePath,
          source_result_path: tracePath,
          retry_result_path: tracePath,
          final_verdict: 'passed',
        },
      },
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });
});
