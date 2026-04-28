import { describe, it, expect } from 'vitest';
import { validateCompletion, hasDoneClaim, hasToolEvidence } from '../gates/verify-before-done.js';

describe('Jidoka gate', () => {
  it('passes when text has no done claim', () => {
    expect(validateCompletion('Still working on it.')).toEqual({ passed: true, violation: null });
  });

  it('fails when "done" claimed without tool evidence', () => {
    expect(validateCompletion('All done!')).toMatchObject({ passed: false, violation: expect.stringContaining('JIDOKA') });
  });

  it('passes when "done" claimed with Bash evidence', () => {
    expect(validateCompletion('done — ran Bash to verify')).toEqual({ passed: true, violation: null });
  });

  it('fails for Russian "готово" without evidence', () => {
    expect(validateCompletion('готово')).toMatchObject({ passed: false });
  });

  it('passes for "verified" with "git log" evidence', () => {
    expect(validateCompletion('verified via git log output')).toEqual({ passed: true, violation: null });
  });
});
