import { describe, it, expect } from 'vitest';
import { exitCodeForStatus } from '../../research-swarm/artifact.js';

describe('research-swarm CLI exit codes', () => {
  it('SUCCESS → exit 0', () => {
    expect(exitCodeForStatus('SUCCESS')).toBe(0);
  });

  it('TIMEOUT → exit 1', () => {
    expect(exitCodeForStatus('TIMEOUT')).toBe(1);
  });

  it('PROVIDER_FAILURE → exit 1', () => {
    expect(exitCodeForStatus('PROVIDER_FAILURE')).toBe(1);
  });

  it('JUDGE_FAILURE → exit 1', () => {
    expect(exitCodeForStatus('JUDGE_FAILURE')).toBe(1);
  });

  it('LIMITED_DIVERSITY → exit 1 (research-only, not production success)', () => {
    expect(exitCodeForStatus('LIMITED_DIVERSITY')).toBe(1);
  });

  it('MULTIMODEL_UNAVAILABLE → exit 1', () => {
    expect(exitCodeForStatus('MULTIMODEL_UNAVAILABLE')).toBe(1);
  });
});
