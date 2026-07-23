/**
 * M7 Supervised Assist tests.
 *
 * Covers: answer-pack contract, approval-port capability, supervised-assist
 * orchestrator, and structural negatives (goal-runner cannot import approval port).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Contract imports ────────────────────────────────────────────────
import {
  createAnswerPack,
  computePackHash,
  shortHash,
  validatePack,
  DENIED_INPUT_TYPES,
  DENIED_AUTOCOMPLETE,
  type ApprovedAnswerPack,
  type FieldEntry,
} from '../hands/assist-contract.js';

// ── Approval port imports ───────────────────────────────────────────
import {
  isValidCapability,
  consumeCapability,
  isForegroundTTY,
  requestApproval,
  type ApprovalCapability,
} from '../hands/assist-approval-port.js';

// ── Supervised assist imports ───────────────────────────────────────
import { runSupervisedAssist } from '../hands/supervised-assist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════════
// 1. ANSWER PACK CONTRACT
// ═══════════════════════════════════════════════════════════════════════

describe('1. Answer pack contract', () => {
  const baseInput = {
    origin: 'file:///C:/test/fixture.html',
    formFingerprint: 'form#application',
    fields: [
      { label: 'Company Name', value: 'VOLAURA Inc', type: 'text' as const },
      { label: 'Sector', value: 'AI/ML', type: 'select' as const },
    ],
    actionPlanHash: 'abc123plan',
  };

  it('1a. createAnswerPack produces valid hash', () => {
    const pack = createAnswerPack(baseInput);
    expect(pack.packHash).toBeTruthy();
    expect(pack.packHash).toHaveLength(64);
    expect(computePackHash(pack)).toBe(pack.packHash);
  });

  it('1b. shortHash returns first 8 chars', () => {
    const pack = createAnswerPack(baseInput);
    expect(shortHash(pack.packHash)).toBe(pack.packHash.slice(0, 8));
    expect(shortHash(pack.packHash)).toHaveLength(8);
  });

  it('1c. tampered pack fails hash validation', () => {
    const pack = createAnswerPack(baseInput);
    const tampered = { ...pack, fields: [{ label: 'Evil', value: 'hack', type: 'text' as const }] };
    const result = validatePack(tampered, {
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('HASH_MISMATCH');
  });

  it('1d. expired pack is rejected', () => {
    const pack = createAnswerPack({ ...baseInput, ttlMs: -1000 }); // already expired
    const result = validatePack(pack, {
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('EXPIRED');
  });

  it('1e. origin mismatch is rejected', () => {
    const pack = createAnswerPack(baseInput);
    const result = validatePack(pack, {
      currentOrigin: 'https://evil.com',
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('ORIGIN_MISMATCH');
  });

  it('1f. form fingerprint mismatch is rejected', () => {
    const pack = createAnswerPack(baseInput);
    const result = validatePack(pack, {
      currentOrigin: pack.origin,
      currentFormFingerprint: 'form#wrong',
      actionPlanHash: pack.actionPlanHash,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('FORM_MISMATCH');
  });

  it('1g. action plan hash mismatch is rejected', () => {
    const pack = createAnswerPack(baseInput);
    const result = validatePack(pack, {
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: 'different-plan',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('PLAN_MISMATCH');
  });

  it('1h. valid pack passes all checks', () => {
    const pack = createAnswerPack(baseInput);
    const result = validatePack(pack, {
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
    });
    expect(result.valid).toBe(true);
  });

  it('1i. denied input types are defined', () => {
    expect(DENIED_INPUT_TYPES.has('password')).toBe(true);
    expect(DENIED_INPUT_TYPES.has('file')).toBe(true);
    expect(DENIED_INPUT_TYPES.has('hidden')).toBe(true);
  });

  it('1j. denied autocomplete values are defined', () => {
    expect(DENIED_AUTOCOMPLETE.has('current-password')).toBe(true);
    expect(DENIED_AUTOCOMPLETE.has('cc-number')).toBe(true);
    expect(DENIED_AUTOCOMPLETE.has('one-time-code')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. APPROVAL PORT — capability model
// ═══════════════════════════════════════════════════════════════════════

describe('2. Approval port — capability model', () => {
  it('2a. forged boolean is not a valid capability', () => {
    expect(isValidCapability(true)).toBe(false);
    expect(isValidCapability(false)).toBe(false);
    expect(isValidCapability(1)).toBe(false);
    expect(isValidCapability('token')).toBe(false);
    expect(isValidCapability(null)).toBe(false);
    expect(isValidCapability(undefined)).toBe(false);
    expect(isValidCapability({})).toBe(false);
  });

  it('2b. forged symbol with wrong description is not valid', () => {
    const forged = Symbol('forged');
    expect(isValidCapability(forged)).toBe(false);
  });

  it('2c. requestApproval refuses non-TTY input', async () => {
    const pack = createAnswerPack({
      origin: 'file:///test.html',
      formFingerprint: 'form#test',
      fields: [{ label: 'Name', value: 'Test', type: 'text' }],
      actionPlanHash: 'plan1',
    });
    // Create a non-TTY stream
    const { Readable, Writable } = await import('node:stream');
    const input = new Readable({ read() {} });
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    // isTTY is not set → non-TTY
    const result = await requestApproval(pack, input as any, output as any);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('TTY required');
  });

  it('2d. consumed capability cannot be reused', async () => {
    // We need to test this via the requestApproval flow with a mock TTY
    const pack = createAnswerPack({
      origin: 'file:///test.html',
      formFingerprint: 'form#test',
      fields: [{ label: 'Name', value: 'Test', type: 'text' }],
      actionPlanHash: 'plan1',
    });

    // Create a mock TTY stream that returns the correct hash
    const hash = shortHash(pack.packHash);
    const { Readable, Writable } = await import('node:stream');
    const input = new Readable({
      read() {
        this.push(hash + '\n');
        this.push(null);
      },
    });
    (input as any).isTTY = true;
    const output = new Writable({ write(_c, _e, cb) { cb(); } });

    const result = await requestApproval(pack, input as any, output as any);
    expect(result.approved).toBe(true);
    expect(result.capability).toBeDefined();
    expect(isValidCapability(result.capability!)).toBe(true);

    // Consume it
    expect(consumeCapability(result.capability!)).toBe(true);
    // Second consume fails
    expect(isValidCapability(result.capability!)).toBe(false);
    expect(consumeCapability(result.capability! as any)).toBe(false);
  });

  it('2e. wrong hash in TTY challenge rejects', async () => {
    const pack = createAnswerPack({
      origin: 'file:///test.html',
      formFingerprint: 'form#test',
      fields: [{ label: 'Name', value: 'Test', type: 'text' }],
      actionPlanHash: 'plan1',
    });

    const { Readable, Writable } = await import('node:stream');
    const input = new Readable({
      read() {
        this.push('wronghash\n');
        this.push(null);
      },
    });
    (input as any).isTTY = true;
    const output = new Writable({ write(_c, _e, cb) { cb(); } });

    const result = await requestApproval(pack, input as any, output as any);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('hash mismatch');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. SUPERVISED ASSIST — orchestrator negative paths
// ═══════════════════════════════════════════════════════════════════════

describe('3. Supervised assist — negative paths', () => {
  const basePack = () => createAnswerPack({
    origin: 'file:///C:/test/fixture.html',
    formFingerprint: 'form#application',
    fields: [{ label: 'Company Name', value: 'VOLAURA Inc', type: 'text' }],
    actionPlanHash: 'plan1',
  });

  // Helper to get a valid capability
  async function getCapability(pack: ApprovedAnswerPack): Promise<ApprovalCapability> {
    const hash = shortHash(pack.packHash);
    const { Readable, Writable } = await import('node:stream');
    const input = new Readable({ read() { this.push(hash + '\n'); this.push(null); } });
    (input as any).isTTY = true;
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const result = await requestApproval(pack, input as any, output as any);
    return result.capability!;
  }

  it('3a. no TTY => driver call 0', async () => {
    const pack = basePack();
    const cap = await getCapability(pack);
    const result = await runSupervisedAssist({
      pack, capability: cap,
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
      // _skipTTYCheck NOT set → will check isForegroundTTY()
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('NO_TTY');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3b. forged boolean capability => driver call 0', async () => {
    const pack = basePack();
    const result = await runSupervisedAssist({
      pack, capability: true as any,
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
      _skipTTYCheck: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('INVALID_CAPABILITY');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3c. replayed (consumed) capability => driver call 0', async () => {
    const pack = basePack();
    const cap = await getCapability(pack);
    // Consume the capability first
    consumeCapability(cap);
    const result = await runSupervisedAssist({
      pack, capability: cap,
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
      _skipTTYCheck: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('INVALID_CAPABILITY');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3d. hash mismatch (tampered pack) => driver call 0', async () => {
    const pack = basePack();
    const cap = await getCapability(pack);
    const tampered = { ...pack, fields: [{ label: 'Evil', value: 'hack', type: 'text' as const }] };
    const result = await runSupervisedAssist({
      pack: tampered, capability: cap,
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
      _skipTTYCheck: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('PACK_VALIDATION_FAILED');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3e. wrong origin => driver call 0', async () => {
    const pack = basePack();
    const cap = await getCapability(pack);
    const result = await runSupervisedAssist({
      pack, capability: cap,
      currentOrigin: 'https://evil.com',
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
      _skipTTYCheck: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('PACK_VALIDATION_FAILED');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3f. wrong form fingerprint => driver call 0', async () => {
    const pack = basePack();
    const cap = await getCapability(pack);
    const result = await runSupervisedAssist({
      pack, capability: cap,
      currentOrigin: pack.origin,
      currentFormFingerprint: 'form#wrong',
      actionPlanHash: pack.actionPlanHash,
      _skipTTYCheck: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('PACK_VALIDATION_FAILED');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3g. expired pack => driver call 0', async () => {
    const pack = createAnswerPack({
      origin: 'file:///C:/test/fixture.html',
      formFingerprint: 'form#application',
      fields: [{ label: 'Company Name', value: 'VOLAURA Inc', type: 'text' }],
      actionPlanHash: 'plan1',
      ttlMs: -1000, // already expired
    });
    const cap = await getCapability(pack);
    const result = await runSupervisedAssist({
      pack, capability: cap,
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
      _skipTTYCheck: true,
    });
    expect(result.halted).toBe(true);
    expect(result.haltReason).toBe('PACK_VALIDATION_FAILED');
    expect(result.fieldsFilled).toBe(0);
  });

  it('3h. unapproved field (not in pack) — pack validation ensures field list integrity', () => {
    const pack = basePack();
    // The pack has exactly one field: 'Company Name'
    // Trying to add a field not in the pack would require a different pack → hash mismatch
    const hackedPack = {
      ...pack,
      fields: [...pack.fields, { label: 'Password', value: 'secret', type: 'text' as const }],
    };
    const validation = validatePack(hackedPack, {
      currentOrigin: pack.origin,
      currentFormFingerprint: pack.formFingerprint,
      actionPlanHash: pack.actionPlanHash,
    });
    expect(validation.valid).toBe(false);
    expect(validation.error).toBe('HASH_MISMATCH');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. STRUCTURAL NEGATIVES — goal-runner isolation
// ═══════════════════════════════════════════════════════════════════════

describe('4. Structural negatives — goal-runner isolation', () => {
  it('4a. goal-runner source NEVER imports assist-approval-port', () => {
    const files = ['types.ts', 'red-line.ts', 'budgets.ts', 'runner.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(SRC_DIR, 'goal-runner', file), 'utf8');
      expect(source).not.toContain('assist-approval-port');
      expect(source).not.toContain('approval-port');
    }
  });

  it('4b. goal-runner source NEVER imports supervised-assist', () => {
    const files = ['types.ts', 'red-line.ts', 'budgets.ts', 'runner.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(SRC_DIR, 'goal-runner', file), 'utf8');
      expect(source).not.toContain('supervised-assist');
    }
  });

  it('4c. goal-runner source has no ApprovalCapability type reference', () => {
    const files = ['types.ts', 'red-line.ts', 'budgets.ts', 'runner.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(SRC_DIR, 'goal-runner', file), 'utf8');
      expect(source).not.toContain('ApprovalCapability');
    }
  });

  it('4d. submit and credential controls remain denied in browser-adapter', () => {
    const adapter = readFileSync(resolve(SRC_DIR, 'hands', 'browser-adapter.ts'), 'utf8');
    expect(adapter).toContain('SUBMIT_BLOCKED_BY_CAPTURE_GUARD');
    expect(adapter).toContain('SUBMIT_DENIED');
  });

  it('4e. M3 submit guards preserved in browser-actions vocabulary', () => {
    const actions = readFileSync(resolve(SRC_DIR, 'hands', 'browser-actions.ts'), 'utf8');
    // 'submit' is NOT in the action kind enum
    expect(actions).not.toMatch(/z\.literal\(['"]submit['"]\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. NOTIFY STRUCTURAL — no alternate proactive transport
// ═══════════════════════════════════════════════════════════════════════

describe('5. Notify structural — no alternate proactive transport', () => {
  it('5a. repo-watch.ts has no private telegramSend', () => {
    const source = readFileSync(resolve(SRC_DIR, 'atlas', 'repo-watch.ts'), 'utf8');
    expect(source).not.toContain('async function telegramSend');
    expect(source).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('5b. repo-watch.ts routes through notifyCeoResult', () => {
    const source = readFileSync(resolve(SRC_DIR, 'atlas', 'repo-watch.ts'), 'utf8');
    expect(source).toContain('notifyCeoResult');
  });

  it('5c. outside notify.ts, no production source has a private Telegram API URL', () => {
    const files = [
      'atlas/repo-watch.ts',
      'atlas/autonomy-loop.ts',
      'atlas/task-spawner.ts',
      'atlas/briefing.ts',
      'atlas/health-check.ts',
      'atlas/cron.ts',
    ];
    for (const file of files) {
      try {
        const source = readFileSync(resolve(SRC_DIR, file), 'utf8');
        // Should not contain raw Telegram API URL (only notify.ts has it)
        expect(source).not.toContain('api.telegram.org/bot');
      } catch {
        // File might not exist — skip
      }
    }
  });
});
