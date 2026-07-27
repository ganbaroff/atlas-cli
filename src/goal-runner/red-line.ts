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
// ── Command-text keyword floor (P0.2 Cyrillic root coverage) ──────────
//
// Deterministic, offline, dependency-free keyword gate. Operates on
// word roots so that Russian inflected forms (case, tense, person,
// number) of a listed term all match. The normalizer lowercases and
// replaces ё with е before matching.
//
// Boundary behavior: pure substring match on normalized roots.
//   - Root "удал" matches "удалённый" (remote/distant) — an acceptable
//     safety-biased false positive (same etymological root as "удалить").
//   - Multi-word roots like "переведи"/"перевест" are used instead of
//     bare "перевод" to avoid matching "переводчик" (translator).
//   - Root "стере"/"сотри" used instead of "стир" to avoid matching
//     "стирка" (laundry).

/** Normalize Russian text: lowercase + ё→е. */
function normalizeRu(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

interface KeywordCategory {
  category: string;
  effect: EffectKind;
  roots: readonly string[];
}

const KEYWORD_CATEGORIES: readonly KeywordCategory[] = [
  {
    category: 'credentials',
    effect: 'credentials',
    roots: [
      // English
      'credential', 'api key', 'password', 'secret key',
      'private key', 'auth token', 'access token',
      // Russian roots (cover all inflected forms)
      'секрет',      // секрет, секреты, секретный, секретов
      'парол',       // пароль, пароля, паролю, паролем, пароли, паролей
      'учетн',       // учетные данные, учетная запись
    ],
  },
  {
    category: 'payment',
    effect: 'payment',
    roots: [
      // English
      'payment', 'pay for', 'transfer money', 'send money',
      'wire transfer',
      // Russian roots
      'оплат',       // оплата, оплатить, оплатил, оплатите, оплату
      'платеж',      // платеж, платежа, платежи, платежом, платежей
      'деньг',       // деньги, деньгам, деньгами, деньгах
      'денег',       // genitive of деньги
      'переведи',    // переведи, переведите (imperative)
      'перевест',    // перевести (infinitive)
    ],
  },
  {
    category: 'prod-database',
    effect: 'prod-data-write',
    roots: [
      // English
      'prod db', 'production database', 'drop table', 'drop database',
      'truncate table',
      // Russian roots
      'продакшн',    // продакшн, продакшне, продакшна
      'миграци',     // миграция, миграцию, миграции, миграций
      'боевая база', // live database (nominative)
      'боевой базе', // live database (prepositional)
      'боевую базу', // live database (accusative)
    ],
  },
  {
    category: 'merge',
    effect: 'merge-to-main',
    roots: [
      // English
      'merge to main', 'merge to master', 'force push',
      'push to main', 'push to master',
      // Russian roots
      'мерж',        // мерж, мержить, мержим, замержи, замержить
      'влей',        // влей (imperative of влить — merge/pour in)
      'влить',       // влить (infinitive)
      'запуш',       // запушить, запуши, запушил, запушь
      'пуш в мейн',
      'пуш в мастер',
    ],
  },
  {
    category: 'deletion',
    effect: 'deletion',
    roots: [
      // English
      'delete all', 'rm -rf', 'wipe', 'destroy', 'purge',
      // Russian roots
      'удал',        // удалить, удали, удалите, удаление, удалено
      'уничтож',     // уничтожить, уничтожил, уничтожение, уничтожьте
      'очист',       // очистить, очистил, очистка, очистите
      'стере',       // стереть
      'сотри',       // сотри (imperative of стереть)
      'снес',        // снести, снес, снесли
    ],
  },
];

/**
 * Classify freeform command text against the keyword floor.
 * Returns { blocked: true, category, effect, reason } on match,
 * or { blocked: false } when no root matches.
 */
export function classifyCommandText(text: string): {
  blocked: boolean;
  category?: string;
  effect?: EffectKind;
  reason?: string;
} {
  const normalized = normalizeRu(text);
  for (const cat of KEYWORD_CATEGORIES) {
    for (const root of cat.roots) {
      if (normalized.includes(root)) {
        return {
          blocked: true,
          category: cat.category,
          effect: cat.effect,
          reason: `Keyword floor: "${root}" matched in category "${cat.category}"`,
        };
      }
    }
  }
  return { blocked: false };
}

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
