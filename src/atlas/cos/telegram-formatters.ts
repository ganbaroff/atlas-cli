/**
 * Pure formatting helpers for the three CEO-board Telegram commands
 * (/brief, /drift, /tasks). No I/O, no side-effects — only data-in, string-out.
 * The bot handlers import these and test coverage targets these directly
 * (no live bot required).
 *
 * Voice rules (voice.md): Russian, terse, no bold headers, no markdown tables.
 * Telegram hard limit is 4096 chars; we aim under ~1500 for /brief,
 * ~15 lines for /tasks.
 */

import type { BriefItem, BriefCategory } from './brief.js';
import type { DriftFinding } from './drift.js';
import type { Task } from '../../exec-graph/contracts.js';

// ── Constants ────────────────────────────────────────────────────────────────

const CAP_BRIEF_CHARS = 1500;
const CAP_TASKS_LINES = 15;
const TITLE_MAX_CHARS = 40;

const CATEGORY_ORDER: readonly BriefCategory[] = [
  'CEO DECISION REQUIRED',
  'WAITING ON EXTERNAL OWNER',
  'BLOCKED',
  'DRIFT / STALE SIGNAL',
  'RECENTLY VERIFIED',
  'NO ACTION REQUIRED',
];

const CATEGORY_LABEL_RU: Record<BriefCategory, string> = {
  'CEO DECISION REQUIRED': 'Ждёт решения',
  'WAITING ON EXTERNAL OWNER': 'Передано',
  BLOCKED: 'Заблокировано',
  'DRIFT / STALE SIGNAL': 'Дрейф',
  'RECENTLY VERIFIED': 'Отгружено',
  'NO ACTION REQUIRED': 'Закрыто',
};

const TERMINAL_STATUSES = new Set(['verified', 'closed', 'rejected']);

// ── Formatters ───────────────────────────────────────────────────────────────

/**
 * Format a composed BriefItem[] for Telegram display.
 * Groups by the fixed CATEGORY_ORDER; skips empty categories (except CEO
 * DECISION REQUIRED which always appears — "no decision needed" is a fact,
 * not silence). Truncates total output at CAP_BRIEF_CHARS with a "…ещё N
 * симв." marker rather than crashing on a large graph.
 */
export function formatBriefForTelegram(items: readonly BriefItem[]): string {
  const sections: string[] = [];

  for (const category of CATEGORY_ORDER) {
    const matched = items.filter((i) => i.category === category);
    if (category === 'CEO DECISION REQUIRED' && matched.length === 0) {
      sections.push(`${CATEGORY_LABEL_RU[category]}: нет.`);
      continue;
    }
    if (matched.length === 0) continue;

    const label = `${CATEGORY_LABEL_RU[category]} (${matched.length}):`;
    const lines = matched.map((item) => {
      const ref = item.sourceRef ? ` ${item.sourceRef}` : '';
      return `- [${item.sourceAuthority}]${ref} ${item.status} (${item.evidenceFreshness})`;
    });
    sections.push([label, ...lines].join('\n'));
  }

  const full = sections.join('\n\n');
  if (full.length <= CAP_BRIEF_CHARS) return full;

  // Truncate at a newline boundary where possible so a line is never split mid-way.
  const cutRaw = full.slice(0, CAP_BRIEF_CHARS);
  const lastNl = cutRaw.lastIndexOf('\n');
  const cut = lastNl > 0 ? cutRaw.slice(0, lastNl) : cutRaw;
  const remaining = full.length - cut.length;
  return `${cut}\n…ещё ${remaining} симв.`;
}

/**
 * Format DriftFinding[] for Telegram display. Empty → plain "Дрейфа нет."
 * Each finding on its own line: kind [ref]: reason (freshness).
 */
export function formatDriftForTelegram(findings: readonly DriftFinding[]): string {
  if (findings.length === 0) return 'Дрейфа нет.';
  return findings
    .map((f) => {
      const ref = f.ref ? ` [${f.ref}]` : '';
      return `- ${f.kind}${ref}: ${f.reason} (${f.evidenceFreshness})`;
    })
    .join('\n');
}

/**
 * Format a Task[] (all tasks from the graph) for Telegram display — shows
 * only active (non-terminal) tasks. Terminal = verified | closed | rejected.
 * Capped at CAP_TASKS_LINES with a "…ещё N" line when there are more.
 * Empty active set → "Граф пуст." (never throws).
 *
 * Each line: short id (12 chars) + status + truncated title.
 */
export function formatTasksForTelegram(tasks: readonly Task[]): string {
  const active = tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
  if (active.length === 0) return 'Граф пуст.';

  const capped = active.slice(0, CAP_TASKS_LINES);
  const rest = active.length - capped.length;

  const lines = capped.map((t) => {
    const shortId = t.id.slice(0, 12);
    const title =
      t.title.length > TITLE_MAX_CHARS
        ? `${t.title.slice(0, TITLE_MAX_CHARS)}…`
        : t.title;
    return `${shortId} [${t.status}] ${title}`;
  });

  if (rest > 0) lines.push(`…ещё ${rest}`);
  return lines.join('\n');
}
