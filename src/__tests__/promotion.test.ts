import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOperatorResult, type OperatorEvaluation } from '../operator/contracts.js';
import { decidePromotion } from '../operator/promotion.js';

function tempArtifact(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anus-promotion-'));
  const path = join(dir, `${name}.result.json`);
  writeFileSync(path, '{"ok":true}\n', 'utf-8');
  return path;
}

function evaluation(overrides: Partial<OperatorEvaluation> = {}): OperatorEvaluation {
  const winning = overrides.winning_result_path ?? tempArtifact('winning');
  return {
    passed: true,
    score: 100,
    summary: 'Result quality passed.',
    issues: [],
    evaluated_at: '2026-06-01T00:00:00.000Z',
    evaluator: 'atlas-operator-evaluator',
    final_verdict: 'passed',
    retryable_route: true,
    retry_used: false,
    source_result_path: winning,
    winning_result_path: winning,
    result_chain_paths: [winning],
    evidence_chain_paths: [winning],
    attempts: [],
    ...overrides,
  };
}

function resultWithEvaluation(overrides: Partial<OperatorEvaluation> = {}) {
  return parseOperatorResult({
    task_id: 'result-quality-evaluator-smoke',
    status: 'success',
    executor: 'manual',
    started_at: '2026-06-01T00:00:00.000Z',
    completed_at: '2026-06-01T00:01:00.000Z',
    summary: 'Evaluator result',
    evidence: [
      {
        id: 'result-quality-evaluator-smoke.verdict',
        task_id: 'result-quality-evaluator-smoke',
        type: 'manual_note',
        source: 'operator/runs/result-quality-evaluator-smoke.result.json',
        observed_at: '2026-06-01T00:00:30.000Z',
        summary: 'Evaluator verdict',
        data: {},
        proof_token: 'result-quality-evaluator-smoke.verdict',
      },
    ],
    errors: [],
    trace_path: tempArtifact('evaluator'),
    evaluation: evaluation(overrides),
  });
}

describe('operator promotion', () => {
  it('blocks when evaluator verdict is missing', () => {
    const decision = decidePromotion({});

    expect(decision.promoted).toBe(false);
    expect(decision.reason).toBe('promotion blocked: evaluator verdict missing');
  });

  it('blocks failed evaluator verdict', () => {
    const decision = decidePromotion({
      result: resultWithEvaluation({
        passed: false,
        final_verdict: 'blocked',
        issues: [{ code: 'quality', message: 'quality failed' }],
      }),
    });

    expect(decision.promoted).toBe(false);
    expect(decision.reason).toBe('promotion blocked: evaluator verdict did not pass');
  });

  it('blocks passed evaluator verdict when winning artifact is missing', () => {
    const decision = decidePromotion({
      result: resultWithEvaluation({
        winning_result_path: 'C:/missing/winning.result.json',
      }),
    });

    expect(decision.promoted).toBe(false);
    expect(decision.reason).toContain('winning result missing');
  });

  it('promotes passed evaluator verdict with durable winning artifact and proof tokens', () => {
    const result = resultWithEvaluation();
    const decision = decidePromotion({ result });

    expect(decision.promoted).toBe(true);
    expect(decision.status).toBe('promoted');
    expect(decision.final_verdict).toBe('passed');
    expect(decision.winning_result_path).toBe(result.evaluation?.winning_result_path);
    expect(decision.proof_tokens).toContain('result-quality-evaluator-smoke.verdict');
  });

  it('promotes retry pass using retry artifact', () => {
    const retryPath = tempArtifact('retry-winning');
    const decision = decidePromotion({
      result: resultWithEvaluation({
        retry_used: true,
        retry_result_path: retryPath,
        winning_result_path: retryPath,
        result_chain_paths: [tempArtifact('source'), retryPath],
      }),
    });

    expect(decision.promoted).toBe(true);
    expect(decision.retry_result_path).toBe(retryPath);
    expect(decision.winning_result_path).toBe(retryPath);
  });

  it('blocks retry fail and waits for reroute', () => {
    const retryPath = tempArtifact('retry-fail');
    const decision = decidePromotion({
      result: resultWithEvaluation({
        passed: false,
        final_verdict: 'blocked',
        retry_used: true,
        retry_result_path: retryPath,
        winning_result_path: undefined,
      }),
    });

    expect(decision.promoted).toBe(false);
    expect(decision.status).toBe('blocked');
  });
});
