import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { constrainMigratingStatePath } from '../atlas/state-root.js';
import {
  dispatchOperatorTask,
  loadOperatorTask,
  operatorRunsDir,
  writeOperatorTrace,
  type DispatchWriteOptions,
} from './dispatcher.js';
import type { OperatorEvidence, OperatorResult, OperatorTask } from './contracts.js';

type DispatchFn = (task: OperatorTask, options?: DispatchWriteOptions) => OperatorResult;
type WriteTraceFn = (result: OperatorResult, options?: DispatchWriteOptions) => OperatorResult;

export interface OperatorLifecycleOptions {
  dispatchTask?: DispatchFn;
  writeTrace?: WriteTraceFn;
  now?: () => string;
  tracePath?: string;
  persistState?: boolean;
}

const REPO_ROOT = process.cwd();

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}

function shortTaskId(sourceId: string, suffix: string): string {
  const raw = `${sourceId}-${suffix}`;
  if (raw.length <= 80) return raw;
  return `${sourceId.slice(0, Math.max(3, 79 - suffix.length))}-${suffix}`.slice(0, 80);
}

export function lifecycleResultPath(sourceTaskId: string): string {
  return constrainMigratingStatePath(
    'operator-runs',
    resolve(operatorRunsDir(), `${sourceTaskId}.lifecycle.result.json`),
  );
}

export function loadOperatorTaskRef(taskRef: string): OperatorTask {
  const trimmed = taskRef.trim();
  if (existsSync(resolve(trimmed)) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.endsWith('.json')) {
    return loadOperatorTask(trimmed);
  }

  return loadOperatorTask(`operator/tasks/${trimmed}.json`);
}

function resultPath(result: OperatorResult): string {
  return constrainMigratingStatePath(
    'operator-runs',
    result.trace_path ?? resolve(operatorRunsDir(), `${result.task_id}.result.json`),
  );
}

function proofTokensFromResult(result?: OperatorResult): string[] {
  return unique([
    ...(result?.evidence ?? []).map((item) => item.proof_token ?? item.id),
    ...(result?.lifecycle?.proof_tokens ?? []),
    ...(result?.promotion?.proof_tokens ?? []),
  ]);
}

function lifecycleEvidence(
  id: string,
  taskId: string,
  type: OperatorEvidence['type'],
  source: string,
  summary: string,
  data: Record<string, unknown> = {},
): OperatorEvidence {
  return {
    id,
    task_id: taskId,
    type,
    source,
    observed_at: new Date().toISOString(),
    summary,
    data,
    proof_token: id,
    verifier: 'atlas-operator-lifecycle',
  };
}

function manualLifecycleTask(
  sourceTask: OperatorTask,
  id: string,
  title: string,
  objective: string,
  inputs: Record<string, unknown>,
  createdAt: string,
): OperatorTask {
  return {
    id,
    title,
    created_at: createdAt,
    route: 'manual',
    mode: 'read_only',
    cwd: REPO_ROOT,
    allowed_paths: [
      REPO_ROOT,
      resolve(REPO_ROOT, 'operator/tasks'),
      operatorRunsDir(),
    ],
    objective,
    inputs,
    expected_evidence: ['file_read', 'manual_note', 'log_trace'],
    safety: {
      sandbox_required: false,
      network_allowed: false,
      write_allowed: false,
    },
  };
}

function blockedSummary(result: OperatorResult): string {
  return result.errors[0] ?? result.summary;
}

export function runOperatorLifecycle(
  sourceTask: OperatorTask,
  options: OperatorLifecycleOptions = {},
): OperatorResult {
  const dispatchTask = options.dispatchTask ?? dispatchOperatorTask;
  const writeTrace = options.writeTrace ?? writeOperatorTrace;
  const now = options.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const lifecycleTaskId = shortTaskId(sourceTask.id, 'lifecycle');
  const evaluationTaskId = shortTaskId(sourceTask.id, 'life-eval');
  const promotionTaskId = shortTaskId(sourceTask.id, 'life-prom');
  const tracePath = constrainMigratingStatePath(
    'operator-runs',
    options.tracePath ?? lifecycleResultPath(sourceTask.id),
  );
  const childResults: OperatorResult[] = [];

  const dispatchResult = dispatchTask(sourceTask, { persistState: false });
  childResults.push(dispatchResult);

  let evaluationResult: OperatorResult | undefined;
  let promotionResult: OperatorResult | undefined;
  let status: OperatorResult['status'] = 'blocked';
  let summary = `Lifecycle blocked: dispatch failed for ${sourceTask.id}.`;
  let errors = dispatchResult.status === 'success' ? [] : [blockedSummary(dispatchResult)];

  if (dispatchResult.status === 'success') {
    const evaluationTask = manualLifecycleTask(
      sourceTask,
      evaluationTaskId,
      `Evaluate lifecycle result for ${sourceTask.id}`,
      `Evaluate source task ${sourceTask.id} and retry once when quality gate allows it.`,
      { result_task_id: sourceTask.id, source_task: sourceTask },
      startedAt,
    );
    evaluationResult = dispatchTask(evaluationTask, { persistState: false });
    childResults.push(evaluationResult);

    const promotionTask = manualLifecycleTask(
      sourceTask,
      promotionTaskId,
      `Promote lifecycle result for ${sourceTask.id}`,
      `Promote evaluated source task ${sourceTask.id} only when evaluator verdict and proof chain pass.`,
      { promotion_result_task_id: evaluationTaskId },
      startedAt,
    );
    promotionResult = dispatchTask(promotionTask, { persistState: false });
    childResults.push(promotionResult);

    const promoted = promotionResult.promotion?.promoted === true && promotionResult.status === 'success';
    status = promoted ? 'success' : 'blocked';
    summary = promoted
      ? `Lifecycle promoted: ${sourceTask.id}.`
      : `Lifecycle blocked: ${promotionResult.promotion?.reason ?? promotionResult.summary}`;
    errors = promoted ? [] : [promotionResult.promotion?.reason ?? blockedSummary(promotionResult)];
  }

  const childResultPaths = childResults.map(resultPath);
  const childProofTokens = unique(childResults.flatMap(proofTokensFromResult));
  const finalProofTokens = unique([
    `${lifecycleTaskId}.dispatch`,
    evaluationResult ? `${lifecycleTaskId}.evaluation` : undefined,
    promotionResult ? `${lifecycleTaskId}.promotion` : undefined,
    `${lifecycleTaskId}.trace`,
    ...childProofTokens,
  ]);

  const evidence: OperatorEvidence[] = [
    lifecycleEvidence(
      `${lifecycleTaskId}.dispatch`,
      lifecycleTaskId,
      'log_trace',
      resultPath(dispatchResult),
      `Dispatch result ${dispatchResult.status} for ${sourceTask.id}`,
      {
        source_task_id: sourceTask.id,
        dispatch_result_path: resultPath(dispatchResult),
        dispatch_status: dispatchResult.status,
      },
    ),
  ];

  if (evaluationResult) {
    evidence.push(lifecycleEvidence(
      `${lifecycleTaskId}.evaluation`,
      lifecycleTaskId,
      'manual_note',
      resultPath(evaluationResult),
      `Evaluation result ${evaluationResult.status} for ${sourceTask.id}`,
      {
        evaluation_task_id: evaluationTaskId,
        evaluation_result_path: resultPath(evaluationResult),
        evaluation: evaluationResult.evaluation,
      },
    ));
  }

  if (promotionResult) {
    evidence.push(lifecycleEvidence(
      `${lifecycleTaskId}.promotion`,
      lifecycleTaskId,
      'manual_note',
      resultPath(promotionResult),
      `Promotion result ${promotionResult.status} for ${sourceTask.id}`,
      {
        promotion_task_id: promotionTaskId,
        promotion_result_path: resultPath(promotionResult),
        promotion: promotionResult.promotion,
      },
    ));
  }

  evidence.push(lifecycleEvidence(
    `${lifecycleTaskId}.trace`,
    lifecycleTaskId,
    'log_trace',
    tracePath,
    JSON.stringify({
      source_task_id: sourceTask.id,
      child_result_paths: childResultPaths,
      final_status: status,
    }, null, 2),
    {
      source_task_id: sourceTask.id,
      child_result_paths: childResultPaths,
      proof_tokens: finalProofTokens,
      final_status: status,
    },
  ));

  const result: OperatorResult = {
    task_id: lifecycleTaskId,
    status,
    executor: 'atlas',
    started_at: startedAt,
    completed_at: now(),
    summary,
    evidence,
    errors,
    evaluation: promotionResult?.evaluation ?? evaluationResult?.evaluation,
    promotion: promotionResult?.promotion,
    lifecycle: {
      source_task_id: sourceTask.id,
      dispatch_result_path: resultPath(dispatchResult),
      evaluation_task_id: evaluationResult ? evaluationTaskId : undefined,
      evaluation_result_path: evaluationResult ? resultPath(evaluationResult) : undefined,
      promotion_task_id: promotionResult ? promotionTaskId : undefined,
      promotion_result_path: promotionResult ? resultPath(promotionResult) : undefined,
      child_result_paths: childResultPaths,
      proof_tokens: finalProofTokens,
      final_status: status,
      blocked_reason: status === 'success' ? undefined : errors[0],
    },
    trace_path: tracePath,
  };

  return writeTrace(result, { tracePath, persistState: options.persistState });
}
