/**
 * goal-runner/red-line.ts — deny-by-EFFECT red-line guard.
 *
 * Per Round 16 binding amendment item 1: classification is by EFFECT, not
 * by wording. Every planned task carries a closed, typed effect set supplied
 * by the registered Hand/adapter. Unknown action kind, unknown effect,
 * missing environment, or disagreement between plan and Hand capability
 * → ESCALATED, executor call count 0.
 *
 * The red-line set covers all irreversible/CEO-only operations. The planner/
 * runner cannot downgrade the class — highest risk wins.
 */

import type { TypedEffect, EffectKind, EffectClass } from './types.js';
import { getHand } from '../hands/registry.js';

// Complete red-line set from Round 16 Item 1 binding amendment.
const RED_LINE_EFFECTS: ReadonlySet<EffectKind> = new Set([
  'submit', 'credentials', 'upload', 'payment', 'consent-oauth',
  'live-db-apply', 'deploy', 'merge-to-main', 'deletion', 'money',
  'external-send', 'mutating-http', 'account-change', 'auth-change',
  'legal-acceptance', 'dns-mutation', 'env-secret-mutation',
  'prod-data-write', 'remote-vcs-mutation', 'destructive-overwrite',
  'install-uninstall', 'paid-api',
]);

/** Classify a single effect kind. Unknown → red-line (deny by default). */
export function classifyEffect(kind: EffectKind): EffectClass {
  if (kind === 'unknown') return 'red-line';
  if (RED_LINE_EFFECTS.has(kind)) return 'red-line';
  return 'safe';
}

/** Map Hand allowedActions to typed effects via the adapter vocabulary. */
const ACTION_TO_EFFECT: Record<string, EffectKind> = {
  'browser-navigate': 'browser-navigate',
  'browser-read': 'browser-read',
  'browser-fill': 'browser-fill',
  'browser-click': 'browser-click',
  'browser-select': 'browser-select',
  'browser-submit': 'submit',
  'read-file': 'read-file',
  'grep': 'grep',
  'git-readonly': 'git-readonly',
  'write-scoped-code': 'destructive-overwrite',
  'deploy': 'deploy',
  'credential-access': 'credentials',
  'upload': 'upload',
  'payment': 'payment',
  'command-exec': 'unknown',
  'command-readonly': 'read-file',
  'swarm-run': 'swarm-run',
  'analyze': 'analyze',
};

/** Derive typed effects from a registered Hand's allowedActions. */
export function deriveEffectsFromHand(handId: string): TypedEffect[] {
  const hand = getHand(handId);
  return hand.allowedActions.map(action => {
    const kind = ACTION_TO_EFFECT[action] ?? 'unknown';
    return { kind, class: classifyEffect(kind) };
  });
}

/** True if any effect in the set is red-lined. */
export function hasRedLine(effects: TypedEffect[]): boolean {
  return effects.some(e => e.class === 'red-line');
}

/** Human-readable reason for the red-line halt. */
export function redLineReason(effects: TypedEffect[]): string {
  const redLines = effects.filter(e => e.class === 'red-line');
  return `Red-line effects detected: ${redLines.map(e => e.kind).join(', ')}`;
}

/**
 * Check if a URL target is external (non-loopback, non-file:).
 * Non-loopback/non-file: browser target is external by default (Round 16).
 */
export function isExternalTarget(url?: string): boolean {
  if (!url) return false;
  if (url.startsWith('file://') || url.startsWith('file:///')) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
    if (host.endsWith('.local') || host.endsWith('.localhost')) return false;
    return true;
  } catch {
    return true; // unparseable = assume external = deny
  }
}
