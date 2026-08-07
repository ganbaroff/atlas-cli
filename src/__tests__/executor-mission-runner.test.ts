/**
 * Wave 5 acceptance: bounded repair, and an honest REJECT after it.
 *
 * The property that matters is structural — a third attempt must be
 * unrepresentable, not merely discouraged. These tests count invocations
 * rather than trusting the verdict string.
 */

import { describe, expect, it } from 'vitest';

import {
  buildRepairInstruction,
  MAX_REPAIR_CYCLES,
  runMissionWithBoundedRepair,
  type AcceptanceCheck,
} from '../atlas/executor/mission-runner.js';
import type { ExecutorAdapter, ExecutorRunContext, ExecutorRunResult } from '../atlas/executor/adapter.js';

const RESULT: ExecutorRunResult = {
  status: 'succeeded',
  outputText: 'done',
  turns: 3,
  toolCallsRequested: 4,
  toolCallsRefused: 0,
  events: [],
};

const adapter = {} as ExecutorAdapter;
const context = { instruction: 'add a /health route' } as ExecutorRunContext;

/** Check that flips to passing once `passAfter` attempts have run. */
function flakyCheck(id: string, passAfter: number, counter: { attempts: number }): AcceptanceCheck {
  return {
    id,
    repairHint: `add the ${id} thing`,
    run: () => ({ ok: counter.attempts >= passAfter, detail: `attempts=${counter.attempts}` }),
  };
}

describe('runMissionWithBoundedRepair', () => {
  it('VERIFIED on the first attempt runs the executor exactly once', async () => {
    const counter = { attempts: 0 };
    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks: [flakyCheck('health-route', 1, counter)],
      runAttempt: async () => {
        counter.attempts += 1;
        return RESULT;
      },
    });
    expect(outcome.verdict).toBe('VERIFIED');
    expect(outcome.repairCycles).toBe(0);
    expect(counter.attempts).toBe(1);
    expect(outcome.attempts).toHaveLength(1);
  });

  it('repairs exactly once when the planted condition fails first', async () => {
    const counter = { attempts: 0 };
    const instructions: string[] = [];
    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks: [flakyCheck('ready-route', 2, counter)],
      runAttempt: async (instruction) => {
        counter.attempts += 1;
        instructions.push(instruction);
        return RESULT;
      },
    });
    expect(outcome.verdict).toBe('VERIFIED');
    expect(outcome.repairCycles).toBe(1);
    expect(counter.attempts).toBe(2);
    expect(instructions[0]).toBe('add a /health route');
    expect(instructions[1]).toContain('ready-route');
    expect(instructions[1]).toContain('only repair attempt');
  });

  it('REJECTs honestly after one repair and never attempts a third time', async () => {
    const counter = { attempts: 0 };
    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks: [flakyCheck('impossible', 99, counter)],
      runAttempt: async () => {
        counter.attempts += 1;
        return RESULT;
      },
    });
    expect(outcome.verdict).toBe('REJECT');
    expect(counter.attempts).toBe(2);
    expect(outcome.repairCycles).toBe(MAX_REPAIR_CYCLES);
    expect(outcome.rejectReason).toContain('impossible');
    expect(outcome.failedChecks.map((f) => f.id)).toEqual(['impossible']);
  });

  it('REJECTs even when the executor reports success, because Atlas checks disk', async () => {
    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks: [{ id: 'never-passes', repairHint: 'x', run: () => ({ ok: false, detail: 'absent' }) }],
      runAttempt: async () => ({ ...RESULT, status: 'succeeded', outputText: 'I completed everything' }),
    });
    expect(outcome.verdict).toBe('REJECT');
  });

  it('carries a failing executor status through without inventing a pass', async () => {
    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks: [{ id: 'c', repairHint: 'x', run: () => ({ ok: false, detail: 'no' }) }],
      runAttempt: async () => ({ ...RESULT, status: 'failed', error: 'provider exhausted' }),
    });
    expect(outcome.verdict).toBe('REJECT');
    expect(outcome.attempts.every((a) => a.executorStatus === 'failed')).toBe(true);
  });

  it('reports only the still-failing checks when several were planted', async () => {
    let round = 0;
    const outcome = await runMissionWithBoundedRepair({
      adapter,
      context,
      checks: [
        { id: 'first', repairHint: 'a', run: () => ({ ok: round > 0, detail: `round=${round}` }) },
        { id: 'second', repairHint: 'b', run: () => ({ ok: false, detail: 'still missing' }) },
      ],
      runAttempt: async () => {
        round += 1;
        return RESULT;
      },
    });
    expect(outcome.verdict).toBe('REJECT');
    expect(outcome.failedChecks.map((f) => f.id)).toEqual(['second']);
  });
});

describe('buildRepairInstruction', () => {
  it('names only the failed checks and forbids redoing accepted work', () => {
    const checks: AcceptanceCheck[] = [
      { id: 'health', repairHint: 'add /health', run: () => ({ ok: true, detail: '' }) },
      { id: 'ready', repairHint: 'add /ready returning { ready: true }', run: () => ({ ok: false, detail: 'absent' }) },
    ];
    const instruction = buildRepairInstruction(checks, [{ id: 'ready', detail: 'absent' }]);
    expect(instruction).toContain('add /ready returning { ready: true }');
    expect(instruction).toContain('observed: absent');
    expect(instruction).not.toContain('add /health');
    expect(instruction).toContain('Do not revert or redo work that already passed');
  });
});
