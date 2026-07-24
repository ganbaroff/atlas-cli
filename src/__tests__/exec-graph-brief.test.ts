import { describe, it, expect } from 'vitest';
import { type Task, type TaskStatus, TASK_STATUSES, taskSchema } from '../exec-graph/contracts.js';
import type { StatusSummary } from '../exec-graph/api.js';
import { formatStatusMessage, formatMorningBriefSection } from '../exec-graph/brief.js';

const NOW_ISO = '2026-07-17T12:00:00.000Z';
const NOW = new Date(NOW_ISO);

/** Builds a schema-valid Task without touching the ledger — pure fixture data. */
function makeTask(id: string, status: TaskStatus, extra: Partial<Task> = {}): Task {
  const needsRefs = status === 'verified' || status === 'evidence-submitted';
  const needsEvidence = status === 'verified' || status === 'closed';
  const base = {
    id,
    goalId: 'gol_test0000000000000001',
    title: 'test task',
    source: { kind: 'exec-graph' as const, ref: 'test' },
    owner: 'atlas',
    status,
    riskClass: 'low' as const,
    idempotencyKey: `exec-graph:${id}`,
    evidence: needsEvidence ? [{ ref: 'seed-ref', kind: 'other' as const }] : [],
    createdAt: NOW_ISO,
    transitions: [{
      from: null,
      to: status,
      ts: NOW_ISO,
      actor: 'atlas',
      evidenceRefs: needsRefs ? ['seed-ref'] : undefined,
    }],
  };
  return taskSchema.parse({ ...base, ...extra });
}

/** Mirrors exec-graph/api.ts's statusSummary() fold, without touching disk. */
function buildSummary(tasks: Task[]): StatusSummary {
  const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of tasks) counts[t.status] += 1;
  const waiting = tasks.filter((t) => (['escalated', 'blocked', 'evidence-submitted'] as TaskStatus[]).includes(t.status));
  return { counts, waiting };
}

// ─── formatStatusMessage ────────────────────────────────────────────────────

describe('formatStatusMessage', () => {
  it('returns the fixed empty-graph message when there are no tasks', () => {
    const msg = formatStatusMessage(buildSummary([]), []);
    expect(msg).toBe('Exec-graph: задач нет. Новая работа заводится через atlas task add.');
  });

  it('renders a counts line plus escalated/evidence-submitted/blocked sections', () => {
    const tasks = [
      makeTask('tsk_esc1', 'escalated'),
      makeTask('tsk_ev1', 'evidence-submitted'),
      makeTask('tsk_blk1', 'blocked'),
      makeTask('tsk_prop1', 'proposed'),
    ];
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    expect(msg).toContain('proposed: 1');
    expect(msg).toContain('escalated: 1');
    expect(msg).toContain('⚠ ждут решения (1):');
    expect(msg).toContain('- tsk_esc1 test task');
    expect(msg).toContain('🔍 на проверке (1):');
    expect(msg).toContain('- tsk_ev1 test task');
    expect(msg).toContain('⛔ blocked (1):');
    expect(msg).toContain('- tsk_blk1 test task');
    // no markdown tables, no bold headers — voice.md structural rules
    expect(msg).not.toMatch(/^\s*\|[-:\s|]+\|\s*$/m);
    expect(msg).not.toMatch(/^\*\*/m);
  });

  it('caps each section at 5 entries and reports the overflow', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => makeTask(`tsk_esc${i}`, 'escalated'));
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    expect(msg).toContain('⚠ ждут решения (7):');
    const listedLines = msg.split('\n').filter((l) => l.startsWith('- tsk_esc'));
    expect(listedLines).toHaveLength(5);
    expect(msg).toContain('…+2 ещё');
  });

  it('truncates long titles to ~60 chars', () => {
    const longTitle = 'x'.repeat(120);
    const tasks = [makeTask('tsk_long1', 'escalated', { title: longTitle })];
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    const line = msg.split('\n').find((l) => l.startsWith('- tsk_long1'))!;
    // "- tsk_long1 " prefix + the truncated title (<=60 chars, ends with an ellipsis)
    const titlePart = line.replace('- tsk_long1 ', '');
    expect(titlePart.length).toBeLessThanOrEqual(60);
    expect(titlePart.endsWith('…')).toBe(true);
  });

  it('omits a section entirely when nothing matches that status', () => {
    const tasks = [makeTask('tsk_p1', 'proposed')];
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    expect(msg).not.toContain('⚠ ждут решения');
    expect(msg).not.toContain('🔍 на проверке');
    expect(msg).not.toContain('⛔ blocked');
  });
});

// ─── formatMorningBriefSection ──────────────────────────────────────────────

describe('formatMorningBriefSection', () => {
  it('returns an empty string when the graph has nothing decision-worthy', () => {
    const tasks = [makeTask('tsk_p1', 'proposed')];
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });
    expect(section).toBe('');
  });

  it('lists escalated tasks under "Ждут твоего решения" (capped at 5)', () => {
    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(`tsk_esc${i}`, 'escalated'));
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });

    expect(section).toContain('Ждут твоего решения (6):');
    const listedLines = section.split('\n').filter((l) => l.startsWith('- tsk_esc'));
    expect(listedLines).toHaveLength(5);
    expect(section).toContain('…+1 ещё');
  });

  it('sums in-progress + delegated into "В работе"', () => {
    const tasks = [
      makeTask('tsk_ip1', 'in-progress'),
      makeTask('tsk_ip2', 'in-progress'),
      makeTask('tsk_del1', 'delegated'),
    ];
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });
    expect(section).toContain('В работе: 3.');
  });

  it('lists tasks closed within 24h of "now" with their evidence count, and excludes older closes', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const thirtyHoursAgo = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString();

    const recentlyClosed = makeTask('tsk_closed_recent', 'closed', {
      evidence: [
        { ref: 'ev1', kind: 'other' as const },
        { ref: 'ev2', kind: 'other' as const },
      ],
      transitions: [
        { from: null, to: 'proposed', ts: NOW_ISO, actor: 'atlas' },
        { from: 'proposed', to: 'verified', ts: NOW_ISO, actor: 'atlas', evidenceRefs: ['ev1'] },
        { from: 'verified', to: 'closed', ts: twoHoursAgo, actor: 'ceo' },
      ],
    });
    const staleClosed = makeTask('tsk_closed_stale', 'closed', {
      evidence: [{ ref: 'ev1', kind: 'other' as const }],
      transitions: [
        { from: null, to: 'proposed', ts: NOW_ISO, actor: 'atlas' },
        { from: 'proposed', to: 'verified', ts: NOW_ISO, actor: 'atlas', evidenceRefs: ['ev1'] },
        { from: 'verified', to: 'closed', ts: thirtyHoursAgo, actor: 'ceo' },
      ],
    });

    const tasks = [recentlyClosed, staleClosed];
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });

    expect(section).toContain('Закрыто за 24ч (1):');
    expect(section).toContain('- tsk_closed_recent test task (evidence: 2)');
    expect(section).not.toContain('tsk_closed_stale');
  });

  it('omits empty sections and joins present ones without extra blank lines', () => {
    const tasks = [
      makeTask('tsk_esc1', 'escalated'),
      makeTask('tsk_ip1', 'in-progress'),
    ];
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });

    expect(section).toContain('Ждут твоего решения (1):');
    expect(section).toContain('В работе: 1.');
    expect(section).not.toContain('Закрыто за 24ч');
    expect(section).not.toMatch(/\n\n/);
  });

  it('is deterministic across calls given the same injected now (no wall-clock reads)', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const closedTask = makeTask('tsk_closed1', 'closed', {
      evidence: [{ ref: 'ev1', kind: 'other' as const }],
      transitions: [
        { from: null, to: 'proposed', ts: NOW_ISO, actor: 'atlas' },
        { from: 'proposed', to: 'verified', ts: NOW_ISO, actor: 'atlas', evidenceRefs: ['ev1'] },
        { from: 'verified', to: 'closed', ts: twoHoursAgo, actor: 'ceo' },
      ],
    });
    const tasks = [closedTask];
    const a = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });
    const b = formatMorningBriefSection(buildSummary(tasks), tasks, { now: new Date(NOW_ISO) });
    expect(a).toBe(b);
  });
});

// ─── owner-aware escalated split (anti-spam — CEO decision 2026-07-17: an ──
// ─── escalated task reassigned away from ceo/external-cto/atlas must NOT ──
// ─── keep re-rendering as "your decision") ─────────────────────────────────

describe('owner-aware escalated split — formatStatusMessage', () => {
  it('escalated task owned by atlas renders under "⚠ ждут решения", not under "📤 передано"', () => {
    const tasks = [makeTask('tsk_esc_atlas', 'escalated', { owner: 'atlas' })];
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    expect(msg).toContain('⚠ ждут решения (1):');
    expect(msg).toContain('- tsk_esc_atlas test task');
    expect(msg).not.toContain('📤 передано');
  });

  it('escalated task owned by volaura-product-chat renders under "📤 передано", not under "⚠ ждут решения" (anti-spam)', () => {
    const tasks = [makeTask('tsk_esc_handed', 'escalated', { owner: 'volaura-product-chat' })];
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    expect(msg).toContain('📤 передано (1):');
    expect(msg).toContain('- tsk_esc_handed test task (ждёт: volaura-product-chat)');
    expect(msg).not.toContain('⚠ ждут решения');
  });

  it('splits mixed-owner escalated tasks into both sections in one message', () => {
    const tasks = [
      makeTask('tsk_esc_ceo', 'escalated', { owner: 'ceo' }),
      makeTask('tsk_esc_ext', 'escalated', { owner: 'external-cto' }),
      makeTask('tsk_esc_hand', 'escalated', { owner: 'hand:volaura' }),
    ];
    const msg = formatStatusMessage(buildSummary(tasks), tasks);

    expect(msg).toContain('⚠ ждут решения (2):');
    expect(msg).toContain('- tsk_esc_ceo test task');
    expect(msg).toContain('- tsk_esc_ext test task');
    expect(msg).toContain('📤 передано (1):');
    expect(msg).toContain('- tsk_esc_hand test task (ждёт: hand:volaura)');
  });
});

describe('owner-aware escalated split — formatMorningBriefSection', () => {
  it('escalated task owned by atlas renders under "Ждут твоего решения", not under "Передано владельцу"', () => {
    const tasks = [makeTask('tsk_esc_atlas', 'escalated', { owner: 'atlas' })];
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });

    expect(section).toContain('Ждут твоего решения (1):');
    expect(section).not.toContain('Передано владельцу');
  });

  it('escalated task owned by volaura-product-chat renders under "Передано владельцу", NOT under "Ждут твоего решения" (anti-spam)', () => {
    const tasks = [makeTask('tsk_esc_handed', 'escalated', { owner: 'volaura-product-chat' })];
    const section = formatMorningBriefSection(buildSummary(tasks), tasks, { now: NOW });

    expect(section).toContain('Передано владельцу (1):');
    expect(section).toContain('- tsk_esc_handed test task → volaura-product-chat');
    expect(section).not.toContain('Ждут твоего решения');
  });
});
