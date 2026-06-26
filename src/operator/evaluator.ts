import { existsSync } from 'node:fs';
import type {
  OperatorEvidence,
  OperatorEvaluation,
  OperatorEvaluationAttempt,
  OperatorResult,
  OperatorTask,
} from './contracts.js';
import { validateResultEvidence } from './contracts.js';

export interface OperatorEvaluationIssue {
  code: string;
  message: string;
}

export interface EvaluateWithRetryRequest {
  task: OperatorTask;
  sourceResult: OperatorResult;
  sourceResultPath: string;
  retryTracePath?: string;
  retryDispatcher?: (request: {
    task: OperatorTask;
    tracePath: string;
  }) => OperatorResult;
}

export interface EvaluateWithRetryResponse {
  evaluation: OperatorEvaluation;
  sourceAttempt: OperatorEvaluationAttempt;
  retryAttempt?: OperatorEvaluationAttempt;
  retryResult?: OperatorResult;
  retryResultPath?: string;
}

const RETRYABLE_ROUTES = new Set<OperatorTask['route']>(['local', 'openmanus', 'octogent']);

function uniqueProofTokens(evidence: OperatorEvidence[]): string[] {
  return [...new Set(
    evidence
      .map((item) => item.proof_token?.trim())
      .filter((token): token is string => Boolean(token && token.length > 0)),
  )];
}

function uniqueEvidencePaths(evidence: OperatorEvidence[]): string[] {
  return [...new Set(
    evidence
      .map((item) => item.source.trim())
      .filter((source) => source.length > 0),
  )];
}

function addIssue(issues: OperatorEvaluationIssue[], code: string, message: string): void {
  issues.push({ code, message });
}

function resultAttemptVerdict(passed: boolean): 'passed' | 'blocked' {
  return passed ? 'passed' : 'blocked';
}

function deriveRetryResultPath(sourceResultPath: string): string {
  if (sourceResultPath.endsWith('.result.json')) {
    return sourceResultPath.replace(/\.result\.json$/i, '.retry-1.result.json');
  }
  return `${sourceResultPath}.retry-1.result.json`;
}

export function isRetryableRoute(route: OperatorTask['route']): boolean {
  return RETRYABLE_ROUTES.has(route);
}

export function isRetryableTask(task: OperatorTask): boolean {
  return isRetryableRoute(task.route)
    && task.mode === 'read_only'
    && task.safety.write_allowed === false;
}

export function buildOperatorEvaluationAttempt(
  attempt: 'source' | 'retry',
  resultPath: string,
  result: OperatorResult,
  evaluation: OperatorEvaluation,
): OperatorEvaluationAttempt {
  return {
    attempt,
    result_path: resultPath,
    result_status: result.status,
    verdict: resultAttemptVerdict(evaluation.passed),
    score: evaluation.score,
    summary: evaluation.summary,
    issues: evaluation.issues,
    proof_tokens: uniqueProofTokens(result.evidence),
    evidence_paths: uniqueEvidencePaths(result.evidence),
  };
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
    result_chain_paths: result.trace_path ? [result.trace_path] : [],
    evidence_chain_paths: uniqueEvidencePaths(result.evidence),
    attempts: [],
  };
}

export function composeOperatorEvaluation(input: {
  task: OperatorTask;
  sourceResultPath: string;
  sourceAttempt: OperatorEvaluationAttempt;
  retryableRoute: boolean;
  retryUsed: boolean;
  retryReason?: string;
  retryResultPath?: string;
  retryAttempt?: OperatorEvaluationAttempt;
}): OperatorEvaluation {
  const attempts = input.retryAttempt
    ? [input.sourceAttempt, input.retryAttempt]
    : [input.sourceAttempt];
  const finalAttempt = attempts[attempts.length - 1];
  const passed = finalAttempt.verdict === 'passed';
  const resultChainPaths = attempts.map((attempt) => attempt.result_path);
  const evidenceChainPaths = [...new Set(attempts.flatMap((attempt) => attempt.evidence_paths))];

  return {
    passed,
    score: finalAttempt.score,
    summary: input.retryAttempt
      ? (passed
        ? `Result quality passed for ${input.task.id} after retry.`
        : `Result quality blocked for ${input.task.id} after retry.`)
      : finalAttempt.summary,
    issues: passed ? [] : finalAttempt.issues,
    evaluated_at: new Date().toISOString(),
    evaluator: 'atlas-operator-evaluator',
    final_verdict: passed ? 'passed' : 'blocked',
    retryable_route: input.retryableRoute,
    retry_used: input.retryUsed,
    source_result_path: input.sourceResultPath,
    retry_result_path: input.retryResultPath,
    winning_result_path: passed ? finalAttempt.result_path : undefined,
    retry_reason: input.retryReason,
    result_chain_paths: resultChainPaths,
    evidence_chain_paths: evidenceChainPaths,
    attempts,
  };
}

export function evaluateOperatorResultWithRetry(
  input: EvaluateWithRetryRequest,
): EvaluateWithRetryResponse {
  const sourceEvaluation = evaluateOperatorResult(input.task, input.sourceResult);
  const sourceAttempt = buildOperatorEvaluationAttempt(
    'source',
    input.sourceResultPath,
    input.sourceResult,
    sourceEvaluation,
  );
  const retryableRoute = isRetryableTask(input.task);

  if (sourceEvaluation.passed || !retryableRoute) {
    return {
      evaluation: composeOperatorEvaluation({
        task: input.task,
        sourceResultPath: input.sourceResultPath,
        sourceAttempt,
        retryableRoute,
        retryUsed: false,
      }),
      sourceAttempt,
    };
  }

  if (!input.retryDispatcher) {
    throw new Error(`Retry dispatcher required for retryable route ${input.task.route}`);
  }

  const retryTracePath = input.retryTracePath ?? deriveRetryResultPath(input.sourceResultPath);
  const retryResult = input.retryDispatcher({
    task: input.task,
    tracePath: retryTracePath,
  });
  const retryResultPath = retryResult.trace_path ?? retryTracePath;
  const retryEvaluation = evaluateOperatorResult(input.task, retryResult);
  const retryAttempt = buildOperatorEvaluationAttempt(
    'retry',
    retryResultPath,
    retryResult,
    retryEvaluation,
  );

  return {
    evaluation: composeOperatorEvaluation({
      task: input.task,
      sourceResultPath: input.sourceResultPath,
      sourceAttempt,
      retryableRoute,
      retryUsed: true,
      retryReason: sourceAttempt.summary,
      retryResultPath,
      retryAttempt,
    }),
    sourceAttempt,
    retryAttempt,
    retryResult,
    retryResultPath,
  };
}
