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

/**
 * Owners for whom an escalated task is a genuine, live CEO/Atlas decision
 * item. An escalated task owned by anything else (a product chat, `hand:*`,
 * ...) has been handed off via exec-graph/api.ts's reassignOwner() — it's
 * still status=escalated (reassignment never touches status), but it must
 * NOT keep re-spamming as "waiting on your decision". Exported so
 * src/cli.ts's `graph status` can apply the identical split in its own
 * CLI-native formatting without duplicating the owner list.
 */
export const CEO_DECISION_OWNERS: readonly string[] = ['ceo', 'external-cto', 'atlas'];

function isCeoDecisionOwner(owner: string): boolean {
  return CEO_DECISION_OWNERS.includes(owner);
}

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

/** Escalated tasks split into "genuinely awaits a CEO/Atlas decision" vs "handed off to some other owner". */
function splitEscalatedByOwner(tasks: readonly Task[]): { forDecision: Task[]; handedOff: Task[] } {
  const escalated = byStatus(tasks, 'escalated');
  return {
    forDecision: escalated.filter((t) => isCeoDecisionOwner(t.owner)),
    handedOff: escalated.filter((t) => !isCeoDecisionOwner(t.owner)),
  };
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

/** Handed-off escalated tasks: `📤 передано (N):` + up to MAX_LIST_ITEMS `- id title (ждёт: owner)` lines. */
function formatHandedOffSection(handedOff: Task[]): string[] {
  if (handedOff.length === 0) return [];
  const shown = handedOff.slice(0, MAX_LIST_ITEMS);
  const lines = [
    `📤 передано (${handedOff.length}):`,
    ...shown.map((t) => `- ${t.id} ${truncateTitle(t.title)} (ждёт: ${t.owner})`),
  ];
  const hidden = handedOff.length - shown.length;
  if (hidden > 0) lines.push(`  …+${hidden} ещё`);
  return lines;
}

/**
 * Hand Contract V0 (src/hands/*) task lines: tasks owned by `hand:<handId>`
 * sitting in delegated/evidence-submitted/verified/rejected. Deliberately
 * reads ONLY task.owner/task.evidence/task.transitions — no import from
 * src/hands/* — so this module stays pure and dependency-free per the
 * module doc above; src/hands/exec-graph-adapter.ts is the only writer of
 * this shape (tool-receipt evidence + verified/rejected transition notes).
 */
const HAND_OWNER_PREFIX = 'hand:';
const HAND_STATUSES: readonly TaskStatus[] = ['delegated', 'evidence-submitted', 'verified', 'rejected'];

function isHandOwned(task: Task): boolean {
  return task.owner.startsWith(HAND_OWNER_PREFIX);
}

/** The receipt `kind` cited by the most recent tool-receipt evidence entry, or 'none'/'unknown'. */
function latestReceiptKind(task: Task): string {
  const receipt = [...task.evidence].reverse().find((e) => e.kind === 'tool-receipt');
  if (!receipt || !receipt.note) return 'none';
  try {
    const parsed = JSON.parse(receipt.note) as { kind?: unknown };
    return typeof parsed.kind === 'string' ? parsed.kind : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The note on the most recent transition into 'verified'/'rejected' (the verifier's reason string), if any. */
function latestVerdictNote(task: Task): string | undefined {
  for (let i = task.transitions.length - 1; i >= 0; i--) {
    const t = task.transitions[i];
    if (t.to === 'verified' || t.to === 'rejected') return t.note;
  }
  return undefined;
}

function handTaskLine(task: Task): string {
  const handId = task.owner.slice(HAND_OWNER_PREFIX.length);
  const receiptKind = latestReceiptKind(task);
  const verdict = latestVerdictNote(task);
  const verdictPart = verdict ? ` — ${truncateTitle(verdict, 60)}` : '';
  return `- ${task.id} ${truncateTitle(task.title)} [${task.status}] hand=${handId} receipt=${receiptKind}${verdictPart}`;
}

/** `🤝 hands (N):` + up to MAX_LIST_ITEMS hand-owned task lines (delegated/evidence-submitted/verified/rejected). */
export function formatHandSection(tasks: readonly Task[]): string[] {
  const handTasks = tasks.filter((t) => HAND_STATUSES.includes(t.status) && isHandOwned(t));
  if (handTasks.length === 0) return [];
  const shown = handTasks.slice(0, MAX_LIST_ITEMS);
  const lines = [`🤝 hands (${handTasks.length}):`, ...shown.map(handTaskLine)];
  const hidden = handTasks.length - shown.length;
  if (hidden > 0) lines.push(`  …+${hidden} ещё`);
  return lines;
}

/**
 * Compact `/status` rendering: counts line, then up to 5 escalated
 * ("⚠ ждут решения" — only tasks owned by ceo/external-cto/atlas, i.e. a
 * genuinely live decision), then handed-off escalated tasks
 * ("📤 передано" — parked with some other owner, informational only, NOT
 * re-spammed as a decision prompt), up to 5 evidence-submitted
 * ("🔍 на проверке"), up to 5 blocked ("⛔ blocked"), then hand-owned tasks
 * ("🤝 hands" — Hand Contract V0 delegation state, see formatHandSection()).
 * Empty graph short-circuits to a fixed message.
 */
export function formatStatusMessage(summary: StatusSummary, tasks: readonly Task[]): string {
  if (tasks.length === 0) {
    return EMPTY_GRAPH_MESSAGE;
  }

  const lines: string[] = [];
  const countsLine = formatCounts(summary.counts);
  if (countsLine) lines.push(countsLine);

  const { forDecision, handedOff } = splitEscalatedByOwner(tasks);
  lines.push(...formatSection('⚠ ждут решения', forDecision));
  lines.push(...formatHandedOffSection(handedOff));
  lines.push(...formatSection('🔍 на проверке', byStatus(tasks, 'evidence-submitted')));
  lines.push(...formatSection('⛔ blocked', byStatus(tasks, 'blocked')));
  lines.push(...formatHandSection(tasks));

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

/** Handed-off escalated tasks for the morning brief: «Передано владельцу (N):» + up to MAX_LIST_ITEMS `- id title → owner` lines. */
function formatHandedOffMorningSection(handedOff: Task[]): string {
  if (handedOff.length === 0) return '';
  const shown = handedOff.slice(0, MAX_LIST_ITEMS);
  const lines = [
    `Передано владельцу (${handedOff.length}):`,
    ...shown.map((t) => `- ${t.id} ${truncateTitle(t.title)} → ${t.owner}`),
  ];
  const hidden = handedOff.length - shown.length;
  if (hidden > 0) lines.push(`  …+${hidden} ещё`);
  return lines.join('\n');
}

/**
 * Decision-framed section appended to the morning brief: «Ждут твоего
 * решения» (escalated AND owned by ceo/external-cto/atlas, up to 5),
 * «Передано владельцу» (escalated but owned by anyone else — informational,
 * NOT framed as a CEO decision, so a parked/deferred item stops re-spamming
 * the brief every morning), «В работе» (in-progress + delegated count),
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

  const { forDecision, handedOff } = splitEscalatedByOwner(tasks);
  if (forDecision.length > 0) {
    sections.push(formatSection('Ждут твоего решения', forDecision).join('\n'));
  }
  const handedOffSection = formatHandedOffMorningSection(handedOff);
  if (handedOffSection) {
    sections.push(handedOffSection);
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
