import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildControlContext,
  describeControlBlock,
  nextControlState,
  parseControlCommand,
  validateControlState,
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
      },
    });

    expect(validation.passed).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });
});
