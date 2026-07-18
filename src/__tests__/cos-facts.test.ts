import { describe, it, expect } from 'vitest';
import { gatherCosFacts, type CosFactProviders } from '../atlas/cos/facts.js';
import type { Task, TaskStatus } from '../exec-graph/contracts.js';

const NOW = '2026-07-18T12:00:00.000Z';

function makeTask(overrides: Partial<Task> & { id: string; status: TaskStatus }): Task {
  return {
    id: overrides.id,
    goalId: overrides.goalId ?? 'gol_test',
    title: overrides.title ?? `title-${overrides.id}`,
    source: overrides.source ?? { kind: 'exec-graph', ref: 'test' },
    owner: overrides.owner ?? 'atlas',
    status: overrides.status,
    riskClass: overrides.riskClass ?? 'low',
    idempotencyKey: overrides.idempotencyKey ?? `key-${overrides.id}`,
    evidence: overrides.evidence ?? [],
    createdAt: overrides.createdAt ?? '2026-07-18T00:00:00.000Z',
    transitions: overrides.transitions ?? [],
  };
}

function baseProviders(overrides: Partial<CosFactProviders> = {}): CosFactProviders {
  return {
    statusSummary: () => ({ counts: {} as Record<TaskStatus, number>, waiting: [] }),
    listTasks: () => [],
    controlMode: () => 'active',
    spend: () => ({ costUsd: 0, calls: 0, tokensIn: 0, tokensOut: 0 }),
    now: () => NOW,
    ...overrides,
  };
}

describe('gatherCosFacts', () => {
  it('maps waiting items from statusSummary().waiting with correct ageHours (last transition ts, now - 2h => 2.0)', () => {
    const waitingTask = makeTask({
      id: 'tsk_1',
      title: 'escalated thing',
      owner: 'hand:x',
      status: 'escalated',
      createdAt: '2026-07-18T00:00:00.000Z',
      transitions: [
        { from: null, to: 'proposed', ts: '2026-07-18T00:00:00.000Z', actor: 'atlas' },
        { from: 'proposed', to: 'escalated', ts: '2026-07-18T10:00:00.000Z', actor: 'atlas' },
      ],
    });
    const providers = baseProviders({
      statusSummary: () => ({ counts: {} as Record<TaskStatus, number>, waiting: [waitingTask] }),
    });

    const facts = gatherCosFacts(providers);

    expect(facts.waiting).toEqual([
      { taskId: 'tsk_1', title: 'escalated thing', status: 'escalated', owner: 'hand:x', ageHours: 2.0 },
    ]);
  });

  it('ageHours falls back to createdAt when transitions is empty', () => {
    const task = makeTask({
      id: 'tsk_2',
      status: 'blocked',
      createdAt: '2026-07-18T09:30:00.000Z', // 2.5h before NOW
      transitions: [],
    });
    const providers = baseProviders({
      statusSummary: () => ({ counts: {} as Record<TaskStatus, number>, waiting: [task] }),
    });

    const facts = gatherCosFacts(providers);

    expect(facts.waiting[0]?.ageHours).toBe(2.5);
  });

  it('clamps ageHours to 0 when the computed age is negative (future timestamp)', () => {
    const task = makeTask({
      id: 'tsk_3',
      status: 'blocked',
      createdAt: '2026-07-18T00:00:00.000Z',
      transitions: [
        { from: null, to: 'blocked', ts: '2026-07-19T00:00:00.000Z', actor: 'atlas' }, // after NOW
      ],
    });
    const providers = baseProviders({
      statusSummary: () => ({ counts: {} as Record<TaskStatus, number>, waiting: [task] }),
    });

    const facts = gatherCosFacts(providers);

    expect(facts.waiting[0]?.ageHours).toBe(0);
  });

  it('clamps ageHours to 0 when the timestamp is unparseable (NaN)', () => {
    const task = makeTask({
      id: 'tsk_4',
      status: 'blocked',
      createdAt: 'not-a-date',
      transitions: [],
    });
    const providers = baseProviders({
      statusSummary: () => ({ counts: {} as Record<TaskStatus, number>, waiting: [task] }),
    });

    const facts = gatherCosFacts(providers);

    expect(facts.waiting[0]?.ageHours).toBe(0);
  });

  it('shipped = verified + closed, verified first', () => {
    const verifiedTask = makeTask({ id: 'tsk_v', title: 'verified one', status: 'verified' });
    const closedTask = makeTask({ id: 'tsk_c', title: 'closed one', status: 'closed' });
    const providers = baseProviders({
      listTasks: (filter) => {
        if (filter?.status === 'verified') return [verifiedTask];
        if (filter?.status === 'closed') return [closedTask];
        return [];
      },
    });

    const facts = gatherCosFacts(providers);

    expect(facts.shipped).toEqual([
      { taskId: 'tsk_v', title: 'verified one', status: 'verified' },
      { taskId: 'tsk_c', title: 'closed one', status: 'closed' },
    ]);
  });

  it('counts are passed through from statusSummary', () => {
    const counts = { proposed: 3, accepted: 1 } as unknown as Record<TaskStatus, number>;
    const providers = baseProviders({
      statusSummary: () => ({ counts, waiting: [] }),
    });

    const facts = gatherCosFacts(providers);

    expect(facts.counts).toEqual(counts);
  });

  it('controlMode is passed through (paused)', () => {
    const providers = baseProviders({ controlMode: () => 'paused' });

    const facts = gatherCosFacts(providers);

    expect(facts.controlMode).toBe('paused');
  });

  it('spend.tokens = tokensIn + tokensOut; costUsd/calls passed through', () => {
    const providers = baseProviders({
      spend: () => ({ costUsd: 1.25, calls: 7, tokensIn: 100, tokensOut: 50 }),
    });

    const facts = gatherCosFacts(providers);

    expect(facts.spend).toEqual({ costUsd: 1.25, calls: 7, tokens: 150 });
  });

  it('generatedAt === injected now()', () => {
    const providers = baseProviders({ now: () => '2026-01-01T00:00:00.000Z' });

    const facts = gatherCosFacts(providers);

    expect(facts.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is pure: calling twice with same providers yields deep-equal facts, and does not mutate input arrays', () => {
    const waitingTask = makeTask({
      id: 'tsk_5',
      status: 'evidence-submitted',
      transitions: [{ from: null, to: 'evidence-submitted', ts: '2026-07-18T11:00:00.000Z', actor: 'atlas', evidenceRefs: ['ref'] }],
    });
    const verifiedTask = makeTask({ id: 'tsk_6', status: 'verified' });
    const waitingArr = [waitingTask];
    const verifiedArr = [verifiedTask];
    const waitingSnapshot = JSON.parse(JSON.stringify(waitingArr));
    const verifiedSnapshot = JSON.parse(JSON.stringify(verifiedArr));

    const providers = baseProviders({
      statusSummary: () => ({ counts: {} as Record<TaskStatus, number>, waiting: waitingArr }),
      listTasks: (filter) => (filter?.status === 'verified' ? verifiedArr : []),
    });

    const first = gatherCosFacts(providers);
    const second = gatherCosFacts(providers);

    expect(first).toEqual(second);
    expect(waitingArr).toEqual(waitingSnapshot);
    expect(verifiedArr).toEqual(verifiedSnapshot);
  });
});
