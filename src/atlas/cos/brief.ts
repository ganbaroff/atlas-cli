/**
 * Chief-of-Staff brief composer (W3) — composes CosFacts (./facts.ts) +
 * DriftFinding[] (./drift.ts) into the CEO-facing brief: a fixed set of six
 * categories, each item carrying its source authority, source ref, status,
 * evidence freshness (or 'UNKNOWN'), and why it's shown. PURE: no I/O, no
 * writes, never mutates its inputs — a projection over already-gathered
 * inputs, same discipline as facts.ts/drift.ts.
 *
 * Reuses exec-graph/brief.ts's CEO_DECISION_OWNERS so the escalated /
 * evidence-submitted "is this genuinely your call, or handed off" split
 * stays identical to what /status already shows — one classification, not a
 * second one invented here.
 */

import { CEO_DECISION_OWNERS } from '../../exec-graph/brief.js';
import type { CosFacts, WaitingItem, ShippedItem, RejectedItem } from './facts.js';
import type { DriftFinding } from './drift.js';

export type BriefCategory =
  | 'CEO DECISION REQUIRED'
  | 'WAITING ON EXTERNAL OWNER'
  | 'BLOCKED'
  | 'DRIFT / STALE SIGNAL'
  | 'RECENTLY VERIFIED'
  | 'NO ACTION REQUIRED';

export interface BriefItem {
  category: BriefCategory;
  sourceAuthority: string;
  /** task id / branch / file path — omitted when not applicable. */
  sourceRef?: string;
  status: string;
  /** e.g. '2.0h' | 'now' | 'UNKNOWN'. */
  evidenceFreshness: string;
  why: string;
}

export interface CosBrief {
  items: BriefItem[];
  text: string;
  generatedAt: string;
}

/** CEO-verbatim fallback line (contract, 2026-07-18) — printed literally, never paraphrased. */
export const NO_CEO_DECISION_LINE = 'No CEO decision required.';

const CATEGORY_ORDER: readonly BriefCategory[] = [
  'CEO DECISION REQUIRED',
  'WAITING ON EXTERNAL OWNER',
  'BLOCKED',
  'DRIFT / STALE SIGNAL',
  'RECENTLY VERIFIED',
  'NO ACTION REQUIRED',
];

const CATEGORY_LABEL_RU: Record<BriefCategory, string> = {
  'CEO DECISION REQUIRED': 'Ждёт твоего решения',
  'WAITING ON EXTERNAL OWNER': 'Передано другому владельцу',
  BLOCKED: 'Заблокировано',
  'DRIFT / STALE SIGNAL': 'Дрейф / протухший сигнал',
  'RECENTLY VERIFIED': 'Отгружено (подтверждено)',
  'NO ACTION REQUIRED': 'Закрыто — без действий',
};

function isCeoDecisionOwner(owner: string): boolean {
  return CEO_DECISION_OWNERS.includes(owner);
}

function fmtAge(ageHours: number): string {
  return `${ageHours.toFixed(1)}h`;
}

/**
 * `waiting` (escalated/blocked/evidence-submitted) items split three ways:
 * blocked -> BLOCKED regardless of owner; escalated/evidence-submitted ->
 * CEO DECISION REQUIRED when owned by ceo/external-cto/atlas (a live call),
 * else WAITING ON EXTERNAL OWNER (handed off, informational — mirrors
 * exec-graph/brief.ts's splitEscalatedByOwner so a parked item doesn't
 * re-spam as a decision prompt).
 */
function waitingItemsToBriefItems(waiting: readonly WaitingItem[]): BriefItem[] {
  return waiting.map((w): BriefItem => {
    if (w.status === 'blocked') {
      return {
        category: 'BLOCKED',
        sourceAuthority: 'exec-graph',
        sourceRef: w.taskId,
        status: w.status,
        evidenceFreshness: fmtAge(w.ageHours),
        why: `task '${w.title}' has sat blocked for ${fmtAge(w.ageHours)}`,
      };
    }
    const decision = isCeoDecisionOwner(w.owner);
    return {
      category: decision ? 'CEO DECISION REQUIRED' : 'WAITING ON EXTERNAL OWNER',
      sourceAuthority: 'exec-graph',
      sourceRef: w.taskId,
      status: w.status,
      evidenceFreshness: fmtAge(w.ageHours),
      why: decision
        ? `task '${w.title}' is ${w.status}, owner '${w.owner}' — awaits your call`
        : `task '${w.title}' is ${w.status}, handed off to owner '${w.owner}'`,
    };
  });
}

/** Every drift finding -> DRIFT / STALE SIGNAL, verbatim reason/freshness — drift.ts already carries the "why". */
function driftFindingsToBriefItems(drift: readonly DriftFinding[]): BriefItem[] {
  return drift.map((f): BriefItem => ({
    category: 'DRIFT / STALE SIGNAL',
    sourceAuthority: f.sourceAuthority,
    sourceRef: f.ref,
    status: f.kind,
    evidenceFreshness: f.evidenceFreshness,
    why: f.reason,
  }));
}

/**
 * `shipped` items split literally on TaskStatus: 'verified' -> RECENTLY
 * VERIFIED (Atlas just proved it with cited evidence), 'closed' -> NO ACTION
 * REQUIRED (filed, nothing further needed). Freshness is 'UNKNOWN' — ShippedItem
 * (facts.ts) carries no per-task age, and the contract's own escape hatch
 * for exactly this ("evidence freshness or UNKNOWN") is truthful over
 * fabricating a timestamp we don't have.
 */
function shippedItemsToBriefItems(shipped: readonly ShippedItem[]): BriefItem[] {
  return shipped.map((s): BriefItem => ({
    category: s.status === 'verified' ? 'RECENTLY VERIFIED' : 'NO ACTION REQUIRED',
    sourceAuthority: 'exec-graph',
    sourceRef: s.taskId,
    status: s.status,
    evidenceFreshness: 'UNKNOWN',
    why: s.status === 'verified'
      ? `task '${s.title}' was verified with cited evidence`
      : `task '${s.title}' is closed — filed, nothing further needed`,
  }));
}

/**
 * Rejected tasks are terminal (no further transition possible on this task
 * id) -> NO ACTION REQUIRED. Commitment-capture / "what happens next" is
 * explicitly cut from this release (CEO rule 7) — this only states the fact
 * that it was rejected, it does not manufacture a follow-up obligation.
 */
function rejectedItemsToBriefItems(rejected: readonly RejectedItem[]): BriefItem[] {
  return rejected.map((r): BriefItem => ({
    category: 'NO ACTION REQUIRED',
    sourceAuthority: 'exec-graph',
    sourceRef: r.taskId,
    status: r.status,
    evidenceFreshness: 'UNKNOWN',
    why: `task '${r.title}' was rejected — filed, no further action from this projection`,
  }));
}

/**
 * Compose brief items from already-gathered facts + drift. PURE: deterministic
 * given its inputs, never mutates them, writes nothing. Output is grouped by
 * the fixed CATEGORY_ORDER; within a category, source order is preserved
 * (waiting items in facts.waiting order, then drift findings in drift.ts's
 * own fixed emission order, then shipped items in facts.shipped order, then
 * rejected items in facts.rejected order).
 */
export function composeCosBriefItems(facts: CosFacts, drift: readonly DriftFinding[]): BriefItem[] {
  const byCategory = new Map<BriefCategory, BriefItem[]>(CATEGORY_ORDER.map((c) => [c, []]));
  const all = [
    ...waitingItemsToBriefItems(facts.waiting),
    ...driftFindingsToBriefItems(drift),
    ...shippedItemsToBriefItems(facts.shipped),
    ...rejectedItemsToBriefItems(facts.rejected),
  ];
  for (const item of all) {
    byCategory.get(item.category)?.push(item);
  }
  return CATEGORY_ORDER.flatMap((c) => byCategory.get(c) ?? []);
}

function briefItemLine(item: BriefItem): string {
  const ref = item.sourceRef ? ` ${item.sourceRef}` : '';
  return `- [${item.sourceAuthority}]${ref} ${item.status} (${item.evidenceFreshness}) — ${item.why}`;
}

/**
 * Render the brief as a Russian voice-brief string, one section per non-empty
 * category (plain `- ` lines, no bold headers, no tables — see voice.md /
 * status-report.ts). CEO DECISION REQUIRED is the one exception: when empty
 * it still prints, with the CEO-verbatim NO_CEO_DECISION_LINE, instead of
 * being silently dropped — "no CEO decision" is itself a fact worth stating
 * plainly, not manufactured urgency and not silence either.
 */
export function formatCosBrief(items: readonly BriefItem[]): string {
  const sections: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const matched = items.filter((i) => i.category === category);
    if (category === 'CEO DECISION REQUIRED' && matched.length === 0) {
      sections.push(`${CATEGORY_LABEL_RU[category]}: ${NO_CEO_DECISION_LINE}`);
      continue;
    }
    if (matched.length === 0) continue;
    sections.push([`${CATEGORY_LABEL_RU[category]} (${matched.length}):`, ...matched.map(briefItemLine)].join('\n'));
  }
  return sections.join('\n\n');
}

/** Gather + compose + format in one call — the convenience wrapper, mirrors facts.ts/status-report.ts's build*() pattern. */
export function composeCosBrief(facts: CosFacts, drift: readonly DriftFinding[]): CosBrief {
  const items = composeCosBriefItems(facts, drift);
  return { items, text: formatCosBrief(items), generatedAt: facts.generatedAt };
}
