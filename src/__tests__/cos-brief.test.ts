import { describe, it, expect } from 'vitest';
import {
  composeCosBriefItems,
  composeCosBrief,
  formatCosBrief,
  NO_CEO_DECISION_LINE,
  type BriefItem,
} from '../atlas/cos/brief.js';
import type { CosFacts, WaitingItem, ShippedItem } from '../atlas/cos/facts.js';
import type { DriftFinding } from '../atlas/cos/drift.js';
import type { TaskStatus } from '../exec-graph/contracts.js';

const NOW = '2026-07-19T12:00:00.000Z';

function makeFacts(overrides: Partial<CosFacts> = {}): CosFacts {
  return {
    waiting: [],
    shipped: [],
    counts: {} as Record<TaskStatus, number>,
    controlMode: 'active',
    spend: { costUsd: 0, calls: 0, tokens: 0 },
    generatedAt: NOW,
    ...overrides,
  };
}

function makeWaiting(overrides: Partial<WaitingItem> & { taskId: string; status: TaskStatus }): WaitingItem {
  return {
    taskId: overrides.taskId,
    title: overrides.title ?? `title-${overrides.taskId}`,
    status: overrides.status,
    owner: overrides.owner ?? 'atlas',
    ageHours: overrides.ageHours ?? 1,
  };
}

function makeShipped(overrides: Partial<ShippedItem> & { taskId: string; status: 'verified' | 'closed' }): ShippedItem {
  return {
    taskId: overrides.taskId,
    title: overrides.title ?? `title-${overrides.taskId}`,
    status: overrides.status,
  };
}

function makeDrift(overrides: Partial<DriftFinding> = {}): DriftFinding {
  return {
    kind: 'unpushed-commits',
    severity: 'drift',
    sourceAuthority: 'git',
    reason: 'local is 2 commit(s) ahead of origin — unpushed',
    evidenceFreshness: 'now',
    ...overrides,
  };
}

describe('composeCosBriefItems', () => {
  it('escalated task owned by ceo -> CEO DECISION REQUIRED', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_1', status: 'escalated', owner: 'ceo', ageHours: 3 })] });
    const items = composeCosBriefItems(facts, []);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ category: 'CEO DECISION REQUIRED', sourceAuthority: 'exec-graph', sourceRef: 'tsk_1', status: 'escalated', evidenceFreshness: '3.0h' });
  });

  it('escalated task owned by atlas -> CEO DECISION REQUIRED (CEO_DECISION_OWNERS includes atlas)', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_2', status: 'escalated', owner: 'atlas' })] });
    const items = composeCosBriefItems(facts, []);
    expect(items[0]?.category).toBe('CEO DECISION REQUIRED');
  });

  it('escalated task owned by external-cto -> CEO DECISION REQUIRED', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_2b', status: 'escalated', owner: 'external-cto' })] });
    const items = composeCosBriefItems(facts, []);
    expect(items[0]?.category).toBe('CEO DECISION REQUIRED');
  });

  it('escalated task owned by a product chat -> WAITING ON EXTERNAL OWNER', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_3', status: 'escalated', owner: 'volaura-product-chat', ageHours: 5 })] });
    const items = composeCosBriefItems(facts, []);
    expect(items[0]).toMatchObject({ category: 'WAITING ON EXTERNAL OWNER', sourceRef: 'tsk_3', evidenceFreshness: '5.0h' });
    expect(items[0]?.why).toContain('volaura-product-chat');
  });

  it('escalated task owned by hand:x -> WAITING ON EXTERNAL OWNER', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_4', status: 'escalated', owner: 'hand:x' })] });
    const items = composeCosBriefItems(facts, []);
    expect(items[0]?.category).toBe('WAITING ON EXTERNAL OWNER');
  });

  it('evidence-submitted follows the same owner split as escalated', () => {
    const facts = makeFacts({
      waiting: [
        makeWaiting({ taskId: 'tsk_5', status: 'evidence-submitted', owner: 'ceo' }),
        makeWaiting({ taskId: 'tsk_6', status: 'evidence-submitted', owner: 'hand:y' }),
      ],
    });
    const items = composeCosBriefItems(facts, []);
    expect(items.find((i) => i.sourceRef === 'tsk_5')?.category).toBe('CEO DECISION REQUIRED');
    expect(items.find((i) => i.sourceRef === 'tsk_6')?.category).toBe('WAITING ON EXTERNAL OWNER');
  });

  it('blocked task -> BLOCKED regardless of owner', () => {
    const facts = makeFacts({
      waiting: [
        makeWaiting({ taskId: 'tsk_7', status: 'blocked', owner: 'ceo', ageHours: 8 }),
        makeWaiting({ taskId: 'tsk_8', status: 'blocked', owner: 'hand:z' }),
      ],
    });
    const items = composeCosBriefItems(facts, []);
    expect(items.every((i) => i.category === 'BLOCKED')).toBe(true);
    expect(items.find((i) => i.sourceRef === 'tsk_7')?.evidenceFreshness).toBe('8.0h');
  });

  it('every drift finding -> DRIFT / STALE SIGNAL, fields passed through verbatim', () => {
    const finding = makeDrift({ kind: 'stale-heartbeat', sourceAuthority: 'heartbeat-file', reason: 'heartbeat 30.0h old', evidenceFreshness: '30.0h' });
    const items = composeCosBriefItems(makeFacts(), [finding]);
    expect(items).toEqual([{
      category: 'DRIFT / STALE SIGNAL',
      sourceAuthority: 'heartbeat-file',
      sourceRef: undefined,
      status: 'stale-heartbeat',
      evidenceFreshness: '30.0h',
      why: 'heartbeat 30.0h old',
    }]);
  });

  it("shipped 'verified' -> RECENTLY VERIFIED, freshness UNKNOWN", () => {
    const facts = makeFacts({ shipped: [makeShipped({ taskId: 'tsk_v', status: 'verified' })] });
    const items = composeCosBriefItems(facts, []);
    expect(items[0]).toMatchObject({ category: 'RECENTLY VERIFIED', sourceRef: 'tsk_v', status: 'verified', evidenceFreshness: 'UNKNOWN' });
  });

  it("shipped 'closed' -> NO ACTION REQUIRED, freshness UNKNOWN", () => {
    const facts = makeFacts({ shipped: [makeShipped({ taskId: 'tsk_c', status: 'closed' })] });
    const items = composeCosBriefItems(facts, []);
    expect(items[0]).toMatchObject({ category: 'NO ACTION REQUIRED', sourceRef: 'tsk_c', status: 'closed', evidenceFreshness: 'UNKNOWN' });
  });

  it('groups strictly by fixed category order regardless of input interleaving', () => {
    const facts = makeFacts({
      waiting: [
        makeWaiting({ taskId: 'tsk_blocked', status: 'blocked' }),
        makeWaiting({ taskId: 'tsk_ceo', status: 'escalated', owner: 'ceo' }),
      ],
      shipped: [makeShipped({ taskId: 'tsk_v', status: 'verified' }), makeShipped({ taskId: 'tsk_c', status: 'closed' })],
    });
    const items = composeCosBriefItems(facts, [makeDrift()]);
    expect(items.map((i) => i.category)).toEqual([
      'CEO DECISION REQUIRED',
      'BLOCKED',
      'DRIFT / STALE SIGNAL',
      'RECENTLY VERIFIED',
      'NO ACTION REQUIRED',
    ]);
  });

  it('empty facts + empty drift -> empty array', () => {
    expect(composeCosBriefItems(makeFacts(), [])).toEqual([]);
  });

  it('is pure: does not mutate its inputs', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_p', status: 'blocked' })] });
    const drift = [makeDrift()];
    const factsSnapshot = JSON.parse(JSON.stringify(facts));
    const driftSnapshot = JSON.parse(JSON.stringify(drift));

    composeCosBriefItems(facts, drift);

    expect(facts).toEqual(factsSnapshot);
    expect(drift).toEqual(driftSnapshot);
  });

  it('determinism: two calls with same inputs -> deep-equal', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_d', status: 'escalated', owner: 'ceo' })] });
    const drift = [makeDrift()];
    expect(composeCosBriefItems(facts, drift)).toEqual(composeCosBriefItems(facts, drift));
  });
});

describe('formatCosBrief', () => {
  it('empty items -> CEO DECISION REQUIRED shows the CEO-verbatim fallback line, no other sections', () => {
    const text = formatCosBrief([]);
    expect(text).toBe(`Ждёт твоего решения: ${NO_CEO_DECISION_LINE}`);
  });

  it('never fabricates urgency: NO_CEO_DECISION_LINE only appears when the category is truly empty', () => {
    const items: BriefItem[] = [{ category: 'CEO DECISION REQUIRED', sourceAuthority: 'exec-graph', sourceRef: 'tsk_x', status: 'escalated', evidenceFreshness: '1.0h', why: 'test' }];
    const text = formatCosBrief(items);
    expect(text).not.toContain(NO_CEO_DECISION_LINE);
    expect(text).toContain('Ждёт твоего решения (1):');
  });

  it('omits empty non-CEO-decision sections entirely (no headers with 0 items)', () => {
    const items: BriefItem[] = [{ category: 'BLOCKED', sourceAuthority: 'exec-graph', sourceRef: 'tsk_b', status: 'blocked', evidenceFreshness: '2.0h', why: 'stuck' }];
    const text = formatCosBrief(items);
    expect(text).toContain('Заблокировано (1):');
    expect(text).not.toContain('Дрейф');
    expect(text).not.toContain('Отгружено');
    expect(text).not.toContain('Закрыто');
  });

  it('renders a per-item line with source authority, ref, status, freshness, why', () => {
    const items: BriefItem[] = [{ category: 'DRIFT / STALE SIGNAL', sourceAuthority: 'git', sourceRef: 'main', status: 'unpushed-commits', evidenceFreshness: 'now', why: 'local is 2 commit(s) ahead' }];
    const text = formatCosBrief(items);
    // CEO DECISION REQUIRED is empty here too, so its fallback line still renders alongside the drift section.
    expect(text).toContain('Дрейф / протухший сигнал (1):\n- [git] main unpushed-commits (now) — local is 2 commit(s) ahead');
  });

  it('item with no sourceRef renders without a dangling space', () => {
    const items: BriefItem[] = [{ category: 'DRIFT / STALE SIGNAL', sourceAuthority: 'heartbeat-file', status: 'stale-heartbeat', evidenceFreshness: 'UNKNOWN', why: 'could not read heartbeat freshness' }];
    const text = formatCosBrief(items);
    expect(text).toContain('- [heartbeat-file] stale-heartbeat (UNKNOWN) — could not read heartbeat freshness');
  });
});

describe('composeCosBrief', () => {
  it('combines items + text + generatedAt from facts', () => {
    const facts = makeFacts({ generatedAt: '2026-01-01T00:00:00.000Z' });
    const brief = composeCosBrief(facts, []);
    expect(brief.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(brief.items).toEqual([]);
    expect(brief.text).toBe(`Ждёт твоего решения: ${NO_CEO_DECISION_LINE}`);
  });

  it('text matches formatCosBrief(items) for non-trivial input', () => {
    const facts = makeFacts({ waiting: [makeWaiting({ taskId: 'tsk_z', status: 'escalated', owner: 'ceo' })] });
    const drift = [makeDrift()];
    const brief = composeCosBrief(facts, drift);
    expect(brief.text).toBe(formatCosBrief(composeCosBriefItems(facts, drift)));
  });
});
