import { existsSync } from 'node:fs';
import type { OperatorEvidence, OperatorResult, OperatorTask } from './contracts.js';
import { validateResultEvidence } from './contracts.js';

export interface OperatorEvaluationIssue {
  code: string;
  message: string;
}

export interface OperatorEvaluation {
  passed: boolean;
  score: number;
  summary: string;
  issues: OperatorEvaluationIssue[];
  evaluated_at: string;
  evaluator: string;
}

function uniqueProofTokens(evidence: OperatorEvidence[]): string[] {
  return [...new Set(
    evidence
      .map((item) => item.proof_token?.trim())
      .filter((token): token is string => Boolean(token && token.length > 0)),
  )];
}

function addIssue(issues: OperatorEvaluationIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

export function evaluateOperatorResult(
  task: OperatorTask,
  result: OperatorResult,
): OperatorEvaluation {
  const issues: OperatorEvaluationIssue[] = [];
  const proofTokens = uniqueProofTokens(result.evidence);
  const evidenceGate = validateResultEvidence(task, result);

  if (result.status !== 'success') {
    addIssue(issues, 'result_not_success', `result status is ${result.status}`);
  }

  if (!evidenceGate.passed) {
    addIssue(issues, 'missing_expected_evidence', `missing expected evidence: ${evidenceGate.missing.join(', ')}`);
  }

  if (result.status === 'success' && proofTokens.length === 0) {
    addIssue(issues, 'missing_proof_tokens', 'success result has no proof tokens');
  }

  if (result.status === 'success' && result.evidence.some((item) => !item.proof_token)) {
    addIssue(issues, 'missing_evidence_proof', 'success result has evidence without proof_token');
  }

  if (result.status === 'success' && result.trace_path && !existsSync(result.trace_path)) {
    addIssue(issues, 'trace_missing', `trace missing on disk: ${result.trace_path}`);
  }

  if (result.status === 'success' && result.errors.length > 0) {
    addIssue(issues, 'unexpected_errors', `success result still has errors: ${result.errors.join('; ')}`);
  }

  const browserObservations = result.evidence.filter((item) => item.type === 'browser_observation');
  const browserTraces = result.evidence.filter((item) => item.type === 'browser_session_trace');
  if (browserObservations.length > 0 && browserTraces.length === 0) {
    addIssue(issues, 'missing_browser_trace', 'browser observation exists without browser session trace');
  }

  const passed = issues.length === 0;
  const score = passed ? 100 : Math.max(0, 100 - (issues.length * 20));

  return {
    passed,
    score,
    summary: passed
      ? `Result quality passed for ${task.id}.`
      : `Result quality blocked for ${task.id}: ${issues.map((issue) => issue.message).join('; ')}`,
    issues,
    evaluated_at: new Date().toISOString(),
    evaluator: 'atlas-operator-evaluator',
  };
}
