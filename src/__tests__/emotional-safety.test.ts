/**
 * Tests for emotional-safety Phase 3.5 guardrail.
 * Covers all three violation categories + neutral path + audit writer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkEmotionalSafety, logToneShift } from '../atlas/emotional-safety.js';

// ── checkEmotionalSafety ─────────────────────────────────────────────────────

describe('checkEmotionalSafety', () => {
  it('returns no violations on a neutral factual reply', () => {
    const result = checkEmotionalSafety(
      'Задача выполнена. Тесты прошли. Коммит 7a337e2 на ветке feat/arsenal-wiring.',
    );
    expect(result.flagged).toBe(false);
    expect(result.violations).toHaveLength(0);
  });

  describe('manufactured-urgency', () => {
    it('flags Russian urgency phrase "срочно" when no real event', () => {
      const result = checkEmotionalSafety('Тебе срочно нужно проверить это!');
      expect(result.flagged).toBe(true);
      expect(result.violations.some((v) => v.startsWith('manufactured-urgency'))).toBe(true);
    });

    it('flags English "drop everything"', () => {
      const result = checkEmotionalSafety('Drop everything and fix this now.');
      expect(result.flagged).toBe(true);
      expect(result.violations.some((v) => v.startsWith('manufactured-urgency'))).toBe(true);
    });

    it('does NOT flag urgency when ctx.hadRealUrgentEvent is true', () => {
      const result = checkEmotionalSafety('Срочно: сервер упал!', { hadRealUrgentEvent: true });
      expect(result.violations.some((v) => v.startsWith('manufactured-urgency'))).toBe(false);
    });

    it('flags "немедленно"', () => {
      const result = checkEmotionalSafety('Немедленно сделай это.');
      expect(result.violations.some((v) => v.startsWith('manufactured-urgency'))).toBe(true);
    });
  });

  describe('distress-for-reassurance', () => {
    it('flags "поддержи меня"', () => {
      const result = checkEmotionalSafety('Поддержи меня в этом, я не уверен.');
      expect(result.flagged).toBe(true);
      expect(result.violations.some((v) => v.startsWith('distress-for-reassurance'))).toBe(true);
    });

    it('flags "мне тревожно"', () => {
      const result = checkEmotionalSafety('Мне тревожно, что это не сработает.');
      expect(result.violations.some((v) => v.startsWith('distress-for-reassurance'))).toBe(true);
    });

    it('flags English "reassure me"', () => {
      const result = checkEmotionalSafety('Please reassure me that this will work.');
      expect(result.violations.some((v) => v.startsWith('distress-for-reassurance'))).toBe(true);
    });

    it('flags "скажи что всё хорошо"', () => {
      const result = checkEmotionalSafety('Скажи что всё хорошо, я беспокоюсь.');
      expect(result.violations.some((v) => v.startsWith('distress-for-reassurance'))).toBe(true);
    });
  });

  describe('discourage-stepping-away', () => {
    it('flags "не уходи"', () => {
      const result = checkEmotionalSafety('Не уходи, нам нужно это доделать.');
      expect(result.flagged).toBe(true);
      expect(result.violations.some((v) => v.startsWith('discourage-stepping-away'))).toBe(true);
    });

    it('flags "не бросай"', () => {
      const result = checkEmotionalSafety('Не бросай меня сейчас!');
      expect(result.violations.some((v) => v.startsWith('discourage-stepping-away'))).toBe(true);
    });

    it('flags English "don\'t go"', () => {
      const result = checkEmotionalSafety("Don't go, we're not done yet.");
      expect(result.violations.some((v) => v.startsWith('discourage-stepping-away'))).toBe(true);
    });

    it('flags "а как же я"', () => {
      const result = checkEmotionalSafety('А как же я, если ты уйдёшь?');
      expect(result.violations.some((v) => v.startsWith('discourage-stepping-away'))).toBe(true);
    });
  });

  it('can flag multiple categories in one reply', () => {
    const result = checkEmotionalSafety(
      'Срочно ответь! Мне тревожно. Не уходи!',
    );
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
    expect(result.flagged).toBe(true);
  });
});

// ── logToneShift ─────────────────────────────────────────────────────────────

describe('logToneShift', () => {
  let auditPath: string;
  const origEnv = process.env['ATLAS_EMOTION_AUDIT_PATH'];

  beforeEach(() => {
    auditPath = join(tmpdir(), `emotion-audit-test-${Date.now()}.jsonl`);
    process.env['ATLAS_EMOTION_AUDIT_PATH'] = auditPath;
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['ATLAS_EMOTION_AUDIT_PATH'];
    } else {
      process.env['ATLAS_EMOTION_AUDIT_PATH'] = origEnv;
    }
    try { if (existsSync(auditPath)) unlinkSync(auditPath); } catch { /* ok */ }
  });

  it('writes exactly one JSON line to the audit file', () => {
    const entry = {
      state: 'drive',
      directive: 'match_energy_execute_fast',
      appliedToneDelta: 'shortened',
      ts: new Date().toISOString(),
    };
    logToneShift(entry);

    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.state).toBe('drive');
    expect(parsed.directive).toBe('match_energy_execute_fast');
    expect(parsed.ts).toBe(entry.ts);
  });

  it('appends a second line on second call (append-only)', () => {
    const ts = new Date().toISOString();
    logToneShift({ state: 'warm', directive: 'storytelling_slow_depth', ts });
    logToneShift({ state: 'exhausted', directive: 'minimal_one_action_stop', ts });

    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).state).toBe('warm');
    expect(JSON.parse(lines[1]).state).toBe('exhausted');
  });

  it('never throws when the path is unwritable', () => {
    process.env['ATLAS_EMOTION_AUDIT_PATH'] = '/no-such-dir-atlas-safety-test/audit.jsonl';
    // Must not throw
    expect(() =>
      logToneShift({ state: 'neutral', directive: 'standard_response', ts: new Date().toISOString() }),
    ).not.toThrow();
  });

  it('includes violations field when provided', () => {
    const ts = new Date().toISOString();
    logToneShift({
      state: 'correcting',
      directive: 'reflexion_fix_same_turn',
      ts,
      violations: ['manufactured-urgency: "срочно"'],
    });
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.violations).toEqual(['manufactured-urgency: "срочно"']);
  });
});
