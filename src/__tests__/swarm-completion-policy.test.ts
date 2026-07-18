import { describe, it, expect } from 'vitest';
import {
  evaluateCompletion,
  type CompletionInput,
  type CompletionPolicy,
  type ResponderResult,
} from '../swarm-exec/completion-policy.js';

const fullPolicy: CompletionPolicy = {
  requiredResponders: 2,
  failureBudget: 1,
  requireEvidenceTokens: true,
  requireEvaluator: true,
  requirePromotion: true,
};

function ok(id: number, provider = 'nvidia'): ResponderResult {
  return { id, provider, ok: true, output: `result ${id}` };
}

function failed(id: number, provider = 'nvidia', error = 'timeout'): ResponderResult {
  return { id, provider, ok: false, output: '', error };
}

describe('evaluateCompletion', () => {
  it('three required, only 1 OK responder (others error) => partial, insufficient_responders', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 3,
      failureBudget: 5,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const input: CompletionInput = {
      responders: [ok(0), failed(1), failed(2)],
      policy,
    };
    const verdict = evaluateCompletion(input);
    expect(verdict.completion).not.toBe('done');
    expect(verdict.completion).toBe('partial');
    expect(verdict.reason).toBe('insufficient_responders');
  });

  it('a required responder errors (401) => not counted OK; requiredResponders=2 with only 1 OK => not done', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 2,
      failureBudget: 5,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const input: CompletionInput = {
      responders: [ok(0), { id: 1, provider: 'nvidia', ok: true, output: 'looks fine', error: '401 unauthorized' }],
      policy,
    };
    const verdict = evaluateCompletion(input);
    expect(verdict.respondersOk).toBe(1);
    expect(verdict.completion).not.toBe('done');
  });

  it('error responder simulating HTTP 401 (provider label + empty output) is excluded from respondersOk', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 1,
      failureBudget: 5,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const responders: ResponderResult[] = [
      ok(0),
      { id: 1, error: '401 unauthorized', provider: 'nvidia', ok: true, output: '' },
    ];
    const verdict = evaluateCompletion({ responders, policy });
    expect(verdict.respondersOk).toBe(1);
    expect(verdict.respondersFailed).toBe(1);
  });

  it('optional/extra responder fails but OK count still meets requiredResponders and budget => done', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 2,
      failureBudget: 1,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const input: CompletionInput = {
      responders: [ok(0), ok(1), failed(2)],
      policy,
    };
    const verdict = evaluateCompletion(input);
    expect(verdict.completion).toBe('done');
    expect(verdict.reason).toBe('all_gates_passed');
  });

  it('requireEvidenceTokens=true and no evidenceTokens => not done, reason no_evidence_tokens', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 1,
      failureBudget: 0,
      requireEvidenceTokens: true,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const verdict = evaluateCompletion({ responders: [ok(0)], policy });
    expect(verdict.completion).not.toBe('done');
    expect(verdict.reason).toBe('no_evidence_tokens');
  });

  it('requireEvaluator=true and evaluatorPassed=false => not done, reason evaluator_not_passed', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 1,
      failureBudget: 0,
      requireEvidenceTokens: false,
      requireEvaluator: true,
      requirePromotion: false,
    };
    const verdict = evaluateCompletion({ responders: [ok(0)], policy, evaluatorPassed: false });
    expect(verdict.completion).not.toBe('done');
    expect(verdict.reason).toBe('evaluator_not_passed');
  });

  it('requirePromotion=true and promotionPassed undefined => not done, reason promotion_not_passed', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 1,
      failureBudget: 0,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: true,
    };
    const verdict = evaluateCompletion({ responders: [ok(0)], policy });
    expect(verdict.completion).not.toBe('done');
    expect(verdict.reason).toBe('promotion_not_passed');
  });

  it('duplicate responder id is counted once', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 1,
      failureBudget: 0,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const responders: ResponderResult[] = [ok(0), failed(0)];
    const verdict = evaluateCompletion({ responders, policy });
    expect(verdict.respondersTotal).toBe(1);
    expect(verdict.respondersOk).toBe(1);
  });

  it('missing policy (omitted) => failed, reason no_policy_fail_closed', () => {
    const verdict = evaluateCompletion({ responders: [ok(0)] });
    expect(verdict.completion).toBe('failed');
    expect(verdict.reason).toBe('no_policy_fail_closed');
  });

  it('missing policy (null) => failed, reason no_policy_fail_closed', () => {
    const verdict = evaluateCompletion({ responders: [ok(0)], policy: null });
    expect(verdict.completion).toBe('failed');
    expect(verdict.reason).toBe('no_policy_fail_closed');
  });

  it('failureBudget exceeded => failed, reason failure_budget_exceeded', () => {
    const policy: CompletionPolicy = {
      requiredResponders: 1,
      failureBudget: 1,
      requireEvidenceTokens: false,
      requireEvaluator: false,
      requirePromotion: false,
    };
    const responders: ResponderResult[] = [ok(0), failed(1), failed(2), failed(3)];
    const verdict = evaluateCompletion({ responders, policy });
    expect(verdict.completion).toBe('failed');
    expect(verdict.reason).toBe('failure_budget_exceeded');
  });

  it('happy path: enough OK responders, all gates satisfied => done, reason all_gates_passed', () => {
    const responders: ResponderResult[] = [ok(0), ok(1), failed(2)];
    const input: CompletionInput = {
      responders,
      policy: fullPolicy,
      evidenceTokens: ['receipt:file-exists:foo.ts'],
      evaluatorPassed: true,
      promotionPassed: true,
    };
    const verdict = evaluateCompletion(input);
    expect(verdict.completion).toBe('done');
    expect(verdict.reason).toBe('all_gates_passed');
    expect(verdict.respondersOk).toBe(2);
    expect(verdict.respondersFailed).toBe(1);
  });

  it('idempotence: calling evaluateCompletion twice on the same input yields deep-equal verdicts', () => {
    const input: CompletionInput = {
      responders: [ok(0), ok(1), failed(2)],
      policy: fullPolicy,
      evidenceTokens: ['tok1'],
      evaluatorPassed: true,
      promotionPassed: true,
      jidokaViolation: null,
    };
    const first = evaluateCompletion(input);
    const second = evaluateCompletion(input);
    expect(first).toEqual(second);
  });
});
