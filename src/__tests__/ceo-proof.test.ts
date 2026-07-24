import { describe, it, expect } from 'vitest';
import { ceoControlProof } from '../atlas/ceo-proof.js';

describe('ceoControlProof', () => {
  it('returns the exact CEO-CONTROL-VERIFIED string', () => {
    expect(ceoControlProof()).toBe('CEO-CONTROL-VERIFIED 2026-07-23 — Yusif commanded, Atlas coded.');
  });
});
