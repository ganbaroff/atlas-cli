/**
 * exec-graph/brief.ts — pure formatting functions that turn exec-graph task
 * state into the strings the Telegram `/status` command and the morning
 * briefing print.
 *
 * PURE: no I/O, no filesystem, no network, no Telegram imports. Everything
 * here is `(summary, tasks[, opts]) -> string`. Callers (src/telegram.ts)
 * are responsible for loading the live state via `./api.js`
 * (`statusSummary()` / `listTasks()`) and handing the results in — this
 * module only formats what it's given, and only ever imports *types* from
 * `./api.js` / `./contracts.js` (erased at compile time), so it carries zero
 * runtime dependency on the ledger.
 *
 * Voice: Russian, short lines, no bold headers, no markdown tables (see
 * src/atlas/voice.ts for the enforced chat-voice rules) — plain
 * `- <id> <title>` lines, capped at 5 per section so a busy graph never
 * floods a Telegram message.
 */

import type { StatusSummary } from './api.js';
import type { Task, TaskStatus } from './contracts.js';

const MAX_TITLE_LEN = 60;
const MAX_LIST_ITEMS = 5;
const CLOSED_WINDOW_MS = 24 * 60 * 60 * 1000;

const EMPTY_GRAPH_MESSAGE = 'Exec-graph: задач нет. Новая работа заводится через atlas task add.';

function truncateTitle(title: string, max = MAX_TITLE_LEN): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}

function taskLine(task: Task): string {
  return `- ${task.id} ${truncateTitle(task.title)}`;
}

function byStatus(tasks: readonly Task[], status: TaskStatus): Task[] {
  return tasks.filter((t) => t.status === status);
}

/** `label (N):` + up to MAX_LIST_ITEMS `- id title` lines + an overflow marker. Empty input -> no lines at all. */
function formatSection(label: string, matched: Task[]): string[] {
  if (matched.length === 0) return [];
  const shown = matched.slice(0, MAX_LIST_ITEMS);
  const lines = [`${label} (${matched.length}):`, ...shown.map(taskLine)];
  const hidden = matched.length - shown.length;
  if (hidden > 0) lines.push(`  …+${hidden} ещё`);
  return lines;
}

/** One line of non-zero status counts, in TASK_STATUSES order. Empty graph -> undefined (caller short-circuits earlier). */
function formatCounts(counts: Record<TaskStatus, number>): string | undefined {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${status}: ${n}`);
  if (parts.length === 0) return undefined;
  return `Статусы — ${parts.join(', ')}.`;
}

/**
 * Compact `/status` rendering: counts line, then up to 5 escalated
 * ("⚠ ждут решения"), up to 5 evidence-submitted ("🔍 на проверке"), up to 5
 * blocked ("⛔ blocked"). Empty graph short-circuits to a fixed message.
 */
export function formatStatusMessage(summary: StatusSummary, tasks: readonly Task[]): string {
  if (tasks.length === 0) {
    return EMPTY_GRAPH_MESSAGE;
  }

  const lines: string[] = [];
  const countsLine = formatCounts(summary.counts);
  if (countsLine) lines.push(countsLine);

  lines.push(...formatSection('⚠ ждут решения', byStatus(tasks, 'escalated')));
  lines.push(...formatSection('🔍 на проверке', byStatus(tasks, 'evidence-submitted')));
  lines.push(...formatSection('⛔ blocked', byStatus(tasks, 'blocked')));

  return lines.join('\n');
}

/** The `ts` of a task's most recent transition into 'closed', or undefined if it never closed. */
function lastClosedTransitionTs(task: Task): string | undefined {
  for (let i = task.transitions.length - 1; i >= 0; i--) {
    if (task.transitions[i].to === 'closed') return task.transitions[i].ts;
  }
  return undefined;
}

function closedWithin(tasks: readonly Task[], now: Date, windowMs: number): Task[] {
  const nowMs = now.getTime();
  const cutoffMs = nowMs - windowMs;
  return tasks.filter((t) => {
    if (t.status !== 'closed') return false;
    const ts = lastClosedTransitionTs(t);
    if (!ts) return false;
    const closedMs = new Date(ts).getTime();
    return closedMs > cutoffMs && closedMs <= nowMs;
  });
}

function closedLine(task: Task): string {
  return `- ${task.id} ${truncateTitle(task.title)} (evidence: ${task.evidence.length})`;
}

export interface MorningBriefOpts {
  /** Injected "now" — deterministic, no wall-clock reads inside this module. */
  now: Date;
}

/**
 * Decision-framed section appended to the morning brief: «Ждут твоего
 * решения» (escalated, up to 5), «В работе» (in-progress + delegated count),
 * «Закрыто за 24ч» (tasks last transitioned to 'closed' within 24h of
 * opts.now, each with its evidence count). Sections with nothing to show are
 * omitted entirely — an all-empty graph yields an empty string, so callers
 * can `if (section) append` without a separate emptiness check.
 */
export function formatMorningBriefSection(
  summary: StatusSummary,
  tasks: readonly Task[],
  opts: MorningBriefOpts,
): string {
  const sections: string[] = [];

  const escalated = byStatus(tasks, 'escalated');
  if (escalated.length > 0) {
    sections.push(formatSection('Ждут твоего решения', escalated).join('\n'));
  }

  const inProgressCount = (summary.counts['in-progress'] ?? 0) + (summary.counts['delegated'] ?? 0);
  if (inProgressCount > 0) {
    sections.push(`В работе: ${inProgressCount}.`);
  }

  const closedRecently = closedWithin(tasks, opts.now, CLOSED_WINDOW_MS);
  if (closedRecently.length > 0) {
    const shown = closedRecently.slice(0, MAX_LIST_ITEMS);
    const hidden = closedRecently.length - shown.length;
    const lines = [`Закрыто за 24ч (${closedRecently.length}):`, ...shown.map(closedLine)];
    if (hidden > 0) lines.push(`  …+${hidden} ещё`);
    sections.push(lines.join('\n'));
  }

  return sections.join('\n');
}
