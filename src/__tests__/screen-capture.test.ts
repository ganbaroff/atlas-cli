import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redactSecrets, tryConsumeVisionSlot } from '../atlas/screen-capture.js';

describe('screen_capture redactSecrets', () => {
  it('redacts common secret shapes', () => {
    expect(redactSecrets('key is sk-ABCDEFGHIJKLMNOP1234XYZ')).toContain('[REDACTED]');
    expect(redactSecrets('g AIzaSyD1234567890abcdefghijklmnopq')).toContain('[REDACTED]');
    expect(redactSecrets('pat ghp_1234567890abcdefghijklmnopqrstuv')).toContain('[REDACTED]');
    expect(redactSecrets('Authorization: Bearer abcdef1234567890abcdef')).toContain('[REDACTED]');
    const jwt = redactSecrets('token eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeKKF2');
    expect(jwt).toContain('[REDACTED]');
  });

  it('keeps the label but redacts the value for key=value', () => {
    const out = redactSecrets('api_key=supersecretvalue123');
    expect(out).toMatch(/api_key=\[REDACTED\]/i);
    expect(out).not.toContain('supersecretvalue123');
  });

  it('leaves ordinary text untouched', () => {
    const clean = 'The user is editing a file in VS Code and Chrome is open.';
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe('screen_capture vision rate limit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-cap-test-'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('allows up to the cap then denies within the same hour', () => {
    expect(tryConsumeVisionSlot(dir, 2)).toEqual({ allowed: true, count: 1 });
    expect(tryConsumeVisionSlot(dir, 2)).toEqual({ allowed: true, count: 2 });
    expect(tryConsumeVisionSlot(dir, 2)).toEqual({ allowed: false, count: 2 });
  });
});
