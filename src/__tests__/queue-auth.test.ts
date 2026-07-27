/**
 * queue-auth.test.ts — tests for work-order authenticity (P0.1 Wave D).
 *
 * ALL via injected fakes — zero network, zero real env, temp dirs for nonce ledger.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';

// Module under test — will be created next
import {
  signPayload,
  verifyPayload,
  createNonceLedger,
  type NonceLedger,
  type SignedFields,
  type VerifyResult,
} from '../atlas/queue-auth.js';

// Obviously-fake test key — never a real secret
const TEST_KEY = 'test-fake-key-not-real-do-not-use';

describe('signPayload (producer side)', () => {
  it('returns sig/ts/nonce when key is provided', () => {
    const result = signPayload(
      { command: 'check disk', chat_id: 123 },
      TEST_KEY,
    );

    expect(result).toHaveProperty('sig');
    expect(result).toHaveProperty('ts');
    expect(result).toHaveProperty('nonce');
    expect(typeof result!.sig).toBe('string');
    expect(typeof result!.ts).toBe('string');
    expect(typeof result!.nonce).toBe('string');
    // ts is ISO-8601
    expect(() => new Date(result!.ts).toISOString()).not.toThrow();
    // nonce is non-empty
    expect(result!.nonce.length).toBeGreaterThan(0);
  });

  it('HMAC recomputes correctly with the same key', () => {
    const result = signPayload(
      { command: 'run tests', chat_id: 456 },
      TEST_KEY,
    );
    expect(result).not.toBeNull();

    // Recompute HMAC over canonical {command, chat_id, ts, nonce}
    const canonical = JSON.stringify({
      command: 'run tests',
      chat_id: 456,
      ts: result!.ts,
      nonce: result!.nonce,
    });
    const expected = createHmac('sha256', TEST_KEY).update(canonical).digest('hex');
    expect(result!.sig).toBe(expected);
  });

  it('returns null when key is undefined (no signing)', () => {
    const result = signPayload(
      { command: 'check disk', chat_id: 123 },
      undefined,
    );
    expect(result).toBeNull();
  });

  it('returns null when key is empty string', () => {
    const result = signPayload(
      { command: 'check disk', chat_id: 123 },
      '',
    );
    expect(result).toBeNull();
  });
});

describe('verifyPayload (runner side)', () => {
  let tempDir: string;
  let ledger: NonceLedger;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'queue-auth-test-'));
    ledger = createNonceLedger(tempDir);
  });

  function makeSignedRow(overrides: Partial<{
    command: string;
    chat_id: number;
    ts: string;
    nonce: string;
    sig: string;
  }> = {}): { command: string; payload: Record<string, unknown>; chat_id: number } {
    const command = overrides.command ?? 'check disk';
    const chat_id = overrides.chat_id ?? 123;
    const ts = overrides.ts ?? new Date().toISOString();
    const nonce = overrides.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
    const canonical = JSON.stringify({ command, chat_id, ts, nonce });
    const sig = overrides.sig ?? createHmac('sha256', TEST_KEY).update(canonical).digest('hex');
    return {
      command,
      chat_id,
      payload: { sig, ts, nonce },
    };
  }

  it('accepts a correctly signed fresh row', () => {
    const row = makeSignedRow();
    const result = verifyPayload(row, TEST_KEY, ledger);
    expect(result.ok).toBe(true);
  });

  it('refuses an unsigned row (no sig/ts/nonce in payload)', () => {
    const result = verifyPayload(
      { command: 'check disk', chat_id: 123, payload: {} },
      TEST_KEY,
      ledger,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsigned');
  });

  it('refuses a row with null payload', () => {
    const result = verifyPayload(
      { command: 'check disk', chat_id: 123, payload: null as any },
      TEST_KEY,
      ledger,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsigned');
  });

  it('refuses a tampered command (sig mismatch)', () => {
    const row = makeSignedRow({ command: 'check disk' });
    // Tamper: change command after signing
    row.command = 'rm -rf /';
    const result = verifyPayload(row, TEST_KEY, ledger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('sig-mismatch');
  });

  it('refuses a row with ts older than 24 hours', () => {
    const oldTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const row = makeSignedRow({ ts: oldTs });
    const result = verifyPayload(row, TEST_KEY, ledger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('refuses a repeated nonce on the second claim', () => {
    const fixedNonce = 'nonce-fixed-repeat';
    const row1 = makeSignedRow({ nonce: fixedNonce });
    const result1 = verifyPayload(row1, TEST_KEY, ledger);
    expect(result1.ok).toBe(true);

    // Second use of the same nonce — must be refused
    const row2 = makeSignedRow({ nonce: fixedNonce });
    const result2 = verifyPayload(row2, TEST_KEY, ledger);
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe('nonce-reuse');
  });
});

describe('NonceLedger persistence', () => {
  it('persists across a simulated restart (fresh module state, same temp dir)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'queue-auth-ledger-'));
    const fixedNonce = 'nonce-persist-test';

    // "Boot 1": create ledger, record a nonce
    const ledger1 = createNonceLedger(tempDir);
    const row = {
      command: 'check disk',
      chat_id: 123,
      payload: {} as Record<string, unknown>,
    };
    // Sign and verify to record the nonce
    const ts = new Date().toISOString();
    const canonical = JSON.stringify({ command: 'check disk', chat_id: 123, ts, nonce: fixedNonce });
    const sig = createHmac('sha256', TEST_KEY).update(canonical).digest('hex');
    row.payload = { sig, ts, nonce: fixedNonce };

    const result1 = verifyPayload(row, TEST_KEY, ledger1);
    expect(result1.ok).toBe(true);

    // "Boot 2": fresh ledger from the same directory
    const ledger2 = createNonceLedger(tempDir);
    // Re-sign with same nonce (fresh row, same nonce)
    const ts2 = new Date().toISOString();
    const canonical2 = JSON.stringify({ command: 'check disk', chat_id: 123, ts: ts2, nonce: fixedNonce });
    const sig2 = createHmac('sha256', TEST_KEY).update(canonical2).digest('hex');
    const row2 = {
      command: 'check disk',
      chat_id: 123,
      payload: { sig: sig2, ts: ts2, nonce: fixedNonce },
    };

    const result2 = verifyPayload(row2, TEST_KEY, ledger2);
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe('nonce-reuse');
  });

  it('evicts entries older than 24h on load (bounded growth)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'queue-auth-evict-'));
    const ledgerPath = join(tempDir, 'nonce-ledger.json');

    // Write an old nonce manually (>24h ago)
    const oldEntry = {
      nonce: 'old-nonce',
      ts: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    const freshEntry = {
      nonce: 'fresh-nonce',
      ts: new Date().toISOString(),
    };
    writeFileSync(ledgerPath, JSON.stringify([oldEntry, freshEntry]), 'utf8');

    // Create ledger — should evict old, keep fresh
    const ledger = createNonceLedger(tempDir);
    // Old nonce should NOT be in the ledger (evicted), so using it is fine
    // Fresh nonce SHOULD be in the ledger, so using it is refused
    const ts = new Date().toISOString();

    // Verify fresh-nonce is still tracked (reuse refused)
    const canonical1 = JSON.stringify({ command: 'test', chat_id: 1, ts, nonce: 'fresh-nonce' });
    const sig1 = createHmac('sha256', TEST_KEY).update(canonical1).digest('hex');
    const r1 = verifyPayload(
      { command: 'test', chat_id: 1, payload: { sig: sig1, ts, nonce: 'fresh-nonce' } },
      TEST_KEY,
      ledger,
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('nonce-reuse');

    // old-nonce was evicted — using it is allowed (treated as fresh)
    const canonical2 = JSON.stringify({ command: 'test', chat_id: 1, ts, nonce: 'old-nonce' });
    const sig2 = createHmac('sha256', TEST_KEY).update(canonical2).digest('hex');
    const r2 = verifyPayload(
      { command: 'test', chat_id: 1, payload: { sig: sig2, ts, nonce: 'old-nonce' } },
      TEST_KEY,
      ledger,
    );
    expect(r2.ok).toBe(true);
  });
});
