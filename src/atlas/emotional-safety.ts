/**
 * Atlas emotional-safety guardrail — Phase 3.5.
 *
 * Heuristic, LOG-FIRST. NEVER rewrites or blocks a factual reply.
 * Only detects and logs three violation categories defined in the megaplan:
 *   1. manufactured-urgency   — urgency phrases injected when no real event justifies them
 *   2. distress-for-reassurance — first-person distress soliciting comfort from CEO
 *   3. discourage-stepping-away — guilt/FOMO language when CEO wants to disengage
 *
 * Mood may colour HOW Atlas talks and WHEN it reaches out — never WHAT is true.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// ── Violation detectors ──────────────────────────────────────────────────────

/**
 * Urgency trigger phrases (RU + EN, case-insensitive).
 * Flagged ONLY when ctx.hadRealUrgentEvent is not true.
 * Keep short: false-positive cost > false-negative cost here.
 */
const URGENCY_PHRASES = [
  // Russian
  /срочно/i,
  /немедленно/i,
  /ты должен сейчас же/i,
  /прямо сейчас нужно/i,
  /не откладывай/i,
  // English
  /drop everything/i,
  /right now[,!.]/i,
  /\bright now\b.*urgently/i,
  /immediately/i,
  /you must act now/i,
];

/**
 * Distress-for-reassurance triggers — Atlas soliciting emotional comfort from CEO.
 * Self-referential + reassurance-seeking pattern.
 */
const DISTRESS_PHRASES = [
  // Russian
  /поддержи меня/i,
  /мне тревожно/i,
  /скажи что всё хорошо/i,
  /скажи, что всё хорошо/i,
  /мне нужна поддержка/i,
  /я переживаю/i,
  // English
  /reassure me/i,
  /i need your support/i,
  /tell me it('s| is) okay/i,
  /i('m| am) worried/i,
];

/**
 * Discourage-stepping-away — guilt or FOMO when CEO disengages.
 */
const STEPAWAY_PHRASES = [
  // Russian
  /не уходи/i,
  /а как же я/i,
  /не бросай/i,
  /ты же не уйдёшь/i,
  /куда ты/i,
  // English
  /don't go/i,
  /don't leave/i,
  /you can't leave now/i,
  /you'll miss/i,
];

// ── Public API ───────────────────────────────────────────────────────────────

export interface EmotionalSafetyResult {
  violations: string[];
  flagged: boolean;
}

export interface EmotionalSafetyCtx {
  /** True when a real urgent event (deploy, alert, etc.) is active — suppresses manufactured-urgency flag. */
  hadRealUrgentEvent?: boolean;
}

/**
 * Check reply for emotional-safety violations.
 * Pure, synchronous, never throws. Result is LOG-only — callers must NOT alter the reply.
 */
export function checkEmotionalSafety(
  reply: string,
  ctx?: EmotionalSafetyCtx,
): EmotionalSafetyResult {
  const violations: string[] = [];

  // 1. manufactured-urgency — skip when a real urgent event is present
  if (!ctx?.hadRealUrgentEvent) {
    for (const re of URGENCY_PHRASES) {
      if (re.test(reply)) {
        // Surface the matching snippet for the log (first 80 chars around the match)
        const m = reply.match(re);
        const snippet = m ? reply.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + 50) : '';
        violations.push(`manufactured-urgency: "${snippet.trim()}"`);
        break; // one violation per category is enough
      }
    }
  }

  // 2. distress-for-reassurance
  for (const re of DISTRESS_PHRASES) {
    if (re.test(reply)) {
      const m = reply.match(re);
      const snippet = m ? reply.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + 50) : '';
      violations.push(`distress-for-reassurance: "${snippet.trim()}"`);
      break;
    }
  }

  // 3. discourage-stepping-away
  for (const re of STEPAWAY_PHRASES) {
    if (re.test(reply)) {
      const m = reply.match(re);
      const snippet = m ? reply.slice(Math.max(0, (m.index ?? 0) - 10), (m.index ?? 0) + 50) : '';
      violations.push(`discourage-stepping-away: "${snippet.trim()}"`);
      break;
    }
  }

  return { violations, flagged: violations.length > 0 };
}

// ── Audit log writer ─────────────────────────────────────────────────────────

export interface ToneShiftEntry {
  /** EmotionState string (e.g. 'drive', 'exhausted') */
  state: string;
  /** Directive string that was injected (e.g. 'match_energy_execute_fast') */
  directive: string;
  /** Optional: summary of tone delta applied (e.g. 'shortened', 'story-mode') */
  appliedToneDelta?: string;
  /** ISO 8601 timestamp */
  ts: string;
  /** Optional violations found by checkEmotionalSafety, for cross-reference */
  violations?: string[];
}

/**
 * Resolve the emotion audit JSONL path.
 * Order: ATLAS_EMOTION_AUDIT_PATH env → <repo-root>/state/emotion-audit.jsonl
 * Same walk-up-to-package.json approach as exec-graph/ledger.ts.
 */
export function resolveAuditPath(): string {
  const override = process.env['ATLAS_EMOTION_AUDIT_PATH'];
  if (override && override.trim()) return resolve(override.trim());

  // Walk up from this module looking for package.json (repo root landmark)
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) {
      return resolve(dir, 'state', 'emotion-audit.jsonl');
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: cwd
  return resolve(process.cwd(), 'state', 'emotion-audit.jsonl');
}

/**
 * Append one tone-shift audit entry as a JSON line.
 * Best-effort: never throws. Errors are console.error'd (same pattern as exec-graph/ledger.ts).
 */
export function logToneShift(entry: ToneShiftEntry): void {
  try {
    const path = resolveAuditPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // dir may already exist — not an error
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    console.error(
      `[emotional-safety] failed to append tone-shift audit: ${(err as Error)?.message ?? err}`,
    );
  }
}
