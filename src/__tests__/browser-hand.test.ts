/**
 * Gate B — BROWSER-HAND-01 tests.
 *
 * Tests the browser Hand: typed action vocabulary (closed enum),
 * out-of-vocabulary rejection, dry-run against local fixture,
 * I1 authority preservation, and verifier support for browser-action receipts.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { browserActionSchema, browserActionKindSchema } from '../hands/browser-actions.js';
import { receiptSchema } from '../hands/contract.js';
import { verify } from '../hands/verifier.js';
import { getHand } from '../hands/registry.js';
import { BrowserSession } from '../hands/browser-adapter.js';

// ── 1. Action vocabulary is a closed enum ───────────────────────────────

describe('browser Hand: action vocabulary', () => {
  it('1a. browserActionKindSchema is a closed enum with exactly 6 kinds', () => {
    const kinds = browserActionKindSchema.options;
    expect(kinds).toEqual(['navigate', 'readText', 'readValue', 'click', 'fillField', 'selectOption']);
    expect(kinds.length).toBe(6);
  });

  it('1b. out-of-vocabulary action kind is rejected at schema level', () => {
    expect(() => browserActionSchema.parse({ kind: 'submitForm', url: 'http://evil.com' })).toThrow();
    expect(() => browserActionSchema.parse({ kind: 'exec', command: 'rm -rf /' })).toThrow();
    expect(() => browserActionSchema.parse({ kind: 'eval', code: 'alert(1)' })).toThrow();
    expect(() => browserActionSchema.parse({ kind: 'uploadFile', path: '/etc/passwd' })).toThrow();
  });

  it('1c. valid actions parse correctly', () => {
    expect(browserActionSchema.parse({ kind: 'navigate', url: 'http://localhost:3000' })).toBeTruthy();
    expect(browserActionSchema.parse({ kind: 'readText', selector: 'h1' })).toBeTruthy();
    expect(browserActionSchema.parse({ kind: 'fillField', label: 'Name', value: 'VOLAURA' })).toBeTruthy();
    expect(browserActionSchema.parse({ kind: 'click', role: 'button', name: 'Submit' })).toBeTruthy();
    expect(browserActionSchema.parse({ kind: 'selectOption', label: 'Sector', value: 'AI / Machine Learning' })).toBeTruthy();
  });
});

// ── 2. Registry: browser-foreground Hand ────────────────────────────────

describe('browser Hand: registry', () => {
  it('2a. browser-foreground is registered with correct properties', () => {
    const hand = getHand('browser-foreground');
    expect(hand.handId).toBe('browser-foreground');
    expect(hand.autonomy).toBe('foreground-only');
    expect(hand.costClass).toBe('FOREGROUND-CEO-SUPERVISED');
    expect(hand.trustLevel).toBe('medium');
  });

  it('2b. browser-foreground disallows submit, credentials, upload, payment', () => {
    const hand = getHand('browser-foreground');
    expect(hand.disallowedActions).toContain('browser-submit');
    expect(hand.disallowedActions).toContain('credential-access');
    expect(hand.disallowedActions).toContain('upload');
    expect(hand.disallowedActions).toContain('payment');
    expect(hand.disallowedActions).toContain('command-exec');
  });
});

// ── 3. Verifier: browser-action receipt kind ────────────────────────────

describe('browser Hand: verifier', () => {
  it('3a. browser-action receipt with all-success results verifies', () => {
    const result = verify({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      claimedResult: 'navigated and read title',
      expectedSubstring: 'Hub71',
      actions: [
        { kind: 'navigate', url: 'file:///fixture.html' },
        { kind: 'readText', selector: 'h1' },
      ],
      actionResults: [
        { action: { kind: 'navigate', url: 'file:///fixture.html' }, success: true, value: 'file:///fixture.html' },
        { action: { kind: 'readText', selector: 'h1' }, success: true, value: 'Hub71 Startup Application' },
      ],
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toContain('2 browser actions succeeded');
  });

  it('3b. browser-action receipt with a failed action is rejected', () => {
    const result = verify({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      claimedResult: 'tried to click',
      actions: [
        { kind: 'click', role: 'button', name: 'NonExistent' },
      ],
      actionResults: [
        { action: { kind: 'click', role: 'button', name: 'NonExistent' }, success: false, error: 'Timeout' },
      ],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("'click' failed");
  });

  it('3c. browser-action receipt with missing expectedSubstring in results is rejected', () => {
    const result = verify({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      claimedResult: 'read title',
      expectedSubstring: 'MISSING_TEXT',
      actions: [
        { kind: 'readText', selector: 'h1' },
      ],
      actionResults: [
        { action: { kind: 'readText', selector: 'h1' }, success: true, value: 'Some Other Title' },
      ],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("expected substring 'MISSING_TEXT'");
  });

  it('3d. browser-action receipt with no actions is rejected', () => {
    const result = verify({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      claimedResult: 'empty',
      actions: [],
      actionResults: [],
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('no actions');
  });

  it('3e. free-form command string cannot be smuggled through browser-action receipt', () => {
    // browser-action receipts use typed actions, not command strings.
    // The 'command' field is ignored; only 'actions' matter.
    const result = verify({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      command: 'rm -rf / & echo PWNED',  // this field is irrelevant for browser-action
      claimedResult: 'tried to inject',
      actions: [
        { kind: 'navigate', url: 'file:///test.html' },
      ],
      actionResults: [
        { action: { kind: 'navigate', url: 'file:///test.html' }, success: true, value: 'file:///test.html' },
      ],
    });
    // Verifies based on structured actions, never touches the command field
    expect(result.verified).toBe(true);
  });
});

// ── 4. Receipt schema: browser-action validation ────────────────────────

describe('browser Hand: receipt schema', () => {
  it('4a. browser-action receipt without actions array is rejected by schema', () => {
    expect(() => receiptSchema.parse({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      claimedResult: 'no actions',
    })).toThrow(/requires at least one action/);
  });

  it('4b. browser-action receipt with valid actions parses', () => {
    const parsed = receiptSchema.parse({
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action',
      claimedResult: 'navigated',
      actions: [{ kind: 'navigate', url: 'http://localhost' }],
      actionResults: [{ action: { kind: 'navigate', url: 'http://localhost' }, success: true, value: 'http://localhost' }],
    });
    expect(parsed.kind).toBe('browser-action');
    expect(parsed.actions).toHaveLength(1);
  });
});

// ── 5. I1 authority: browser Hand cannot bypass verifier ─────────────────

describe('browser Hand: I1 authority', () => {
  it('5-I1. browser-foreground hand is subject to the same _viaVerifier guard as all other hands', () => {
    // The I1 invariant: no owner (including hand:browser-foreground) can
    // self-promote to verified/rejected without _viaVerifier. This is tested
    // end-to-end in hands.test.ts (tests 16a, 18, and the negative regression).
    // Here we confirm the registry entry itself does not carry any escape flag.
    const hand = getHand('browser-foreground');

    // browser-foreground must not have 'command-exec' in allowed actions
    // (no arbitrary command execution path)
    expect(hand.allowedActions).not.toContain('command-exec');
    expect(hand.disallowedActions).toContain('command-exec');

    // It must be foreground-only (CEO supervises)
    expect(hand.autonomy).toBe('foreground-only');

    // Its allowed actions are all browser-* prefixed (closed vocabulary)
    for (const action of hand.allowedActions) {
      expect(action).toMatch(/^browser-/);
    }
  });
});

// ── 6. Dry-run: fixture page via Playwright ─────────────────────────────

describe('browser Hand: dry-run against fixture', () => {
  const fixturePath = resolve('fixtures/hub71-fake-form.html');
  const fixtureUrl = `file://${fixturePath.replace(/\\/g, '/')}`;
  let session: BrowserSession;

  beforeAll(async () => {
    session = new BrowserSession();
    await session.launch();
  }, 30_000);

  afterAll(async () => {
    await session.close();
  });

  it('5a. navigate→readText→fillField→readValue→selectOption without submit', async () => {
    // Navigate
    const nav = await session.execute({ kind: 'navigate', url: fixtureUrl });
    expect(nav.success).toBe(true);

    // Read title
    const title = await session.execute({ kind: 'readText', selector: 'h1' });
    expect(title.success).toBe(true);
    expect(title.value).toContain('Hub71 Startup Application');

    // Fill company name
    const fill1 = await session.execute({ kind: 'fillField', label: 'Company Name', value: 'VOLAURA Inc' });
    expect(fill1.success).toBe(true);

    // Fill founder name
    const fill2 = await session.execute({ kind: 'fillField', label: 'Founder Name', value: 'Yusif Ganbarov' });
    expect(fill2.success).toBe(true);

    // Read back filled value
    const readback = await session.execute({ kind: 'readValue', selector: '#company-name' });
    expect(readback.success).toBe(true);
    expect(readback.value).toBe('VOLAURA Inc');

    // Select sector
    const select = await session.execute({ kind: 'selectOption', label: 'Sector', value: 'AI / Machine Learning' });
    expect(select.success).toBe(true);

    // NO submit — the action vocabulary does not include submit
  }, 30_000);

  it('5b. executeSequence collects all results and they form a valid browser-action receipt', async () => {
    const actions = [
      { kind: 'navigate' as const, url: fixtureUrl },
      { kind: 'readText' as const, selector: 'h1' },
      { kind: 'fillField' as const, label: 'Company Name', value: 'Atlas Test Corp' },
      { kind: 'readValue' as const, selector: '#company-name' },
    ];

    const results = await session.executeSequence(actions);
    expect(results).toHaveLength(4);
    expect(results.every(r => r.success)).toBe(true);

    // Build a receipt from the dry-run and verify it
    const receipt = {
      taskId: 'tsk_test0000000000000001',
      handId: 'browser-foreground',
      submittedBy: 'browser-foreground',
      kind: 'browser-action' as const,
      claimedResult: 'dry-run: navigated, read title, filled and read back company name',
      expectedSubstring: 'Atlas Test Corp',
      actions,
      actionResults: results,
    };

    // Schema validates
    expect(() => receiptSchema.parse(receipt)).not.toThrow();

    // Verifier accepts
    const verdict = verify(receipt);
    expect(verdict.verified).toBe(true);
  }, 30_000);
});
