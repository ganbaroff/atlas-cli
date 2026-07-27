/**
 * Unit tests for src/atlas/cos/telegram-formatters.ts
 * Pure functions — no live bot, no filesystem, no exec-graph writes.
 * Covers: populated case, empty case, truncation/cap behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  formatBriefForTelegram,
  formatDriftForTelegram,
  formatTasksForTelegram,
} from '../atlas/cos/telegram-formatters.js';
import type { BriefItem } from '../atlas/cos/brief.js';
import type { DriftFinding } from '../atlas/cos/drift.js';
import type { Task, TaskStatus } from '../exec-graph/contracts.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBriefItem(overrides: Partial<BriefItem> & { category: BriefItem['category'] }): BriefItem {
  return {
    category: overrides.category,
    sourceAuthority: overrides.sourceAuthority ?? 'exec-graph',
    sourceRef: overrides.sourceRef,
    status: overrides.status ?? 'escalated',
    evidenceFreshness: overrides.evidenceFreshness ?? '1.0h',
    why: overrides.why ?? 'test why',
  };
}

function makeDriftFinding(overrides: Partial<DriftFinding> & { kind: DriftFinding['kind'] }): DriftFinding {
  return {
    kind: overrides.kind,
    severity: overrides.severity ?? 'drift',
    sourceAuthority: overrides.sourceAuthority ?? 'git',
    ref: overrides.ref,
    reason: overrides.reason ?? 'test reason',
    evidenceFreshness: overrides.evidenceFreshness ?? 'now',
  };
}

function makeTask(overrides: Partial<Task> & { id: string; status: TaskStatus }): Task {
  return {
    id: overrides.id,
    goalId: overrides.goalId ?? 'gol_test',
    title: overrides.title ?? `task-${overrides.id}`,
    source: overrides.source ?? { kind: 'exec-graph', ref: 'test' },
    owner: overrides.owner ?? 'atlas',
    status: overrides.status,
    riskClass: overrides.riskClass ?? 'low',
    idempotencyKey: overrides.idempotencyKey ?? `key-${overrides.id}`,
    evidence: overrides.evidence ?? [],
    createdAt: overrides.createdAt ?? '2026-07-27T00:00:00.000Z',
    transitions: overrides.transitions ?? [
      { from: null, to: overrides.status, ts: '2026-07-27T00:00:00.000Z', actor: 'atlas', note: 'created' },
    ],
  };
}

// ── formatBriefForTelegram ───────────────────────────────────────────────────

describe('formatBriefForTelegram', () => {
  it('populated: includes Russian category labels and item lines', () => {
    const items: BriefItem[] = [
      makeBriefItem({ category: 'CEO DECISION REQUIRED', sourceRef: 'tsk_abc123', status: 'escalated' }),
      makeBriefItem({ category: 'BLOCKED', sourceRef: 'tsk_def456', status: 'blocked' }),
    ];
    const result = formatBriefForTelegram(items);
    expect(result).toContain('Ждёт решения');
    expect(result).toContain('Заблокировано');
    expect(result).toContain('tsk_abc123');
    expect(result).toContain('tsk_def456');
    expect(result).toContain('escalated');
    expect(result).toContain('blocked');
  });

  it('empty CEO DECISION REQUIRED still appears with "нет." marker', () => {
    const result = formatBriefForTelegram([]);
    expect(result).toContain('Ждёт решения');
    expect(result).toContain('нет.');
  });

  it('empty categories (other than CEO DECISION REQUIRED) are skipped', () => {
    const result = formatBriefForTelegram([]);
    expect(result).not.toContain('Заблокировано');
    expect(result).not.toContain('Передано');
    expect(result).not.toContain('Дрейф');
  });

  it('truncation: output over 1500 chars gets "…ещё N симв." suffix', () => {
    // Build enough items to exceed 1500 chars
    const items: BriefItem[] = Array.from({ length: 50 }, (_, i) =>
      makeBriefItem({
        category: 'BLOCKED',
        sourceRef: `tsk_${i.toString().padStart(10, '0')}`,
        status: 'blocked',
        evidenceFreshness: '999.9h',
        why: `a very long reason string that pads out the output to force truncation scenario ${i}`,
      }),
    );
    const result = formatBriefForTelegram(items);
    expect(result.length).toBeLessThanOrEqual(1550); // hard cap + marker overhead
    expect(result).toContain('…ещё');
    expect(result).toContain('симв.');
  });

  it('output within 1500 chars has no truncation marker', () => {
    const items: BriefItem[] = [
      makeBriefItem({ category: 'CEO DECISION REQUIRED', sourceRef: 'tsk_001', status: 'escalated' }),
    ];
    const result = formatBriefForTelegram(items);
    expect(result).not.toContain('…ещё');
  });
});

// ── formatDriftForTelegram ───────────────────────────────────────────────────

describe('formatDriftForTelegram', () => {
  it('populated: includes kind, reason, and freshness', () => {
    const findings: DriftFinding[] = [
      makeDriftFinding({ kind: 'unpushed-commits', ref: 'main', reason: 'local is 3 commits ahead', evidenceFreshness: 'now' }),
      makeDriftFinding({ kind: 'stale-heartbeat', reason: 'heartbeat 30h old', evidenceFreshness: '30.0h' }),
    ];
    const result = formatDriftForTelegram(findings);
    expect(result).toContain('unpushed-commits');
    expect(result).toContain('[main]');
    expect(result).toContain('local is 3 commits ahead');
    expect(result).toContain('stale-heartbeat');
    expect(result).toContain('heartbeat 30h old');
    expect(result).toContain('30.0h');
  });

  it('empty: returns "Дрейфа нет."', () => {
    const result = formatDriftForTelegram([]);
    expect(result).toBe('Дрейфа нет.');
  });

  it('finding without ref omits bracket notation', () => {
    const findings: DriftFinding[] = [
      makeDriftFinding({ kind: 'graph-verify-failed', reason: 'snapshot diverges', evidenceFreshness: 'now' }),
    ];
    const result = formatDriftForTelegram(findings);
    expect(result).not.toContain('[undefined]');
    expect(result).not.toContain('[]');
    expect(result).toContain('graph-verify-failed');
  });
});

// ── formatTasksForTelegram ───────────────────────────────────────────────────

describe('formatTasksForTelegram', () => {
  it('populated: lists active tasks with short id, status, title', () => {
    const tasks: Task[] = [
      makeTask({ id: 'tsk_aabbccddeeff', status: 'in-progress', title: 'Deploy the widget' }),
      makeTask({ id: 'tsk_112233445566', status: 'escalated', title: 'CEO approval needed' }),
    ];
    const result = formatTasksForTelegram(tasks);
    expect(result).toContain('tsk_aabbccdd');     // first 12 chars of id
    expect(result).toContain('[in-progress]');
    expect(result).toContain('Deploy the widget');
    expect(result).toContain('[escalated]');
    expect(result).toContain('CEO approval needed');
  });

  it('empty / all terminal: returns "Граф пуст."', () => {
    // All terminal statuses — should produce empty active list
    const tasks: Task[] = [
      makeTask({ id: 'tsk_v1', status: 'verified' }),
      makeTask({ id: 'tsk_c1', status: 'closed' }),
      makeTask({ id: 'tsk_r1', status: 'rejected' }),
    ];
    expect(formatTasksForTelegram(tasks)).toBe('Граф пуст.');
    expect(formatTasksForTelegram([])).toBe('Граф пуст.');
  });

  it('truncation: more than 15 active tasks adds "…ещё N" line', () => {
    const tasks: Task[] = Array.from({ length: 20 }, (_, i) =>
      makeTask({ id: `tsk_${i.toString().padStart(10, '0')}`, status: 'proposed', title: `Task ${i}` }),
    );
    const result = formatTasksForTelegram(tasks);
    const lines = result.split('\n');
    // 15 task lines + 1 "…ещё N" line = 16 lines total
    expect(lines).toHaveLength(16);
    expect(lines[15]).toBe('…ещё 5');
  });

  it('exactly 15 active tasks: no truncation marker', () => {
    const tasks: Task[] = Array.from({ length: 15 }, (_, i) =>
      makeTask({ id: `tsk_${i.toString().padStart(10, '0')}`, status: 'proposed', title: `Task ${i}` }),
    );
    const result = formatTasksForTelegram(tasks);
    expect(result).not.toContain('…ещё');
  });

  it('long titles are truncated at 40 chars with ellipsis', () => {
    const longTitle = 'A'.repeat(50);
    const tasks: Task[] = [makeTask({ id: 'tsk_001', status: 'in-progress', title: longTitle })];
    const result = formatTasksForTelegram(tasks);
    expect(result).toContain('…');
    expect(result).not.toContain(longTitle);
    // Title portion should be 40 chars + '…'
    const titlePart = result.split('[in-progress] ')[1];
    expect(titlePart).toBe(`${'A'.repeat(40)}…`);
  });

  it('terminal tasks (verified/closed/rejected) are excluded from output', () => {
    const tasks: Task[] = [
      makeTask({ id: 'tsk_active', status: 'in-progress', title: 'Active task' }),
      makeTask({ id: 'tsk_done', status: 'verified', title: 'Done task' }),
      makeTask({ id: 'tsk_closed', status: 'closed', title: 'Closed task' }),
      makeTask({ id: 'tsk_rejected', status: 'rejected', title: 'Rejected task' }),
    ];
    const result = formatTasksForTelegram(tasks);
    expect(result).toContain('Active task');
    expect(result).not.toContain('Done task');
    expect(result).not.toContain('Closed task');
    expect(result).not.toContain('Rejected task');
  });
});
