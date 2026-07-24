import { describe, it, expect } from 'vitest';
import { buildEvalReport, verdictFromStatus, getFixture, EVAL_FIXTURES } from '../../research-swarm/eval-harness.js';

describe('research-swarm eval-harness', () => {
  it('has deterministic fixtures', () => {
    expect(EVAL_FIXTURES.length).toBeGreaterThan(0);
    expect(getFixture('evidence-gate-audit')).toBeDefined();
  });

  it('KEEP_DISABLED when swarm fails or single provider', () => {
    expect(verdictFromStatus('TIMEOUT', 0, 2)).toBe('KEEP_DISABLED');
    expect(verdictFromStatus('PROVIDER_FAILURE', 1, 2)).toBe('KEEP_DISABLED');
    expect(verdictFromStatus('MULTIMODEL_UNAVAILABLE', 1, 2)).toBe('KEEP_DISABLED');
  });

  it('RESEARCH_ONLY for LIMITED_DIVERSITY with enough providers', () => {
    expect(verdictFromStatus('LIMITED_DIVERSITY', 2, 2)).toBe('RESEARCH_ONLY');
  });

  it('READY_FOR_RESEARCH only on SUCCESS', () => {
    expect(verdictFromStatus('SUCCESS', 3, 2)).toBe('READY_FOR_RESEARCH');
  });

  it('buildEvalReport is deterministic', () => {
    const a = buildEvalReport({
      fixtureId: 'evidence-gate-audit',
      baselineMs: 100,
      swarmMs: 5000,
      swarmStatus: 'TIMEOUT',
      providerCount: 1,
      minProviders: 2,
    });
    const b = buildEvalReport({
      fixtureId: 'evidence-gate-audit',
      baselineMs: 100,
      swarmMs: 5000,
      swarmStatus: 'TIMEOUT',
      providerCount: 1,
      minProviders: 2,
    });
    expect(a).toEqual(b);
    expect(a.verdict).toBe('KEEP_DISABLED');
  });
});
