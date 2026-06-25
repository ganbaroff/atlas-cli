import { describe, expect, it } from 'vitest';
import { parseOperatorResult, parseOperatorTask, type OperatorResult, type OperatorTask } from '../operator/contracts.js';
import { lifecycleResultPath, loadOperatorTaskRef, runOperatorLifecycle } from '../operator/lifecycle.js';

const sourceTask = parseOperatorTask({
  id: 'octogent-live-child-ack-smoke',
  title: 'Octogent live child-ack smoke',
  created_at: '2026-05-30T08:55:00.000Z',
  route: 'octogent',
  mode: 'read_only',
  cwd: 'C:/Projects/octogent',
  allowed_paths: ['C:/Projects/octogent'],
  objective: 'Verify real child spawn, channel send, ack, and delivery trace in Octogent runtime.',
  inputs: {
    runtime_mode: 'live_child_ack',
  },
  expected_evidence: ['command_exit', 'log_trace'],
  safety: {
    sandbox_required: false,
    network_allowed: false,
    write_allowed: false,
  },
});

function evidence(taskId: string, id: string, type: 'command_exit' | 'manual_note' | 'log_trace' = 'manual_note') {
  return {
    id,
    task_id: taskId,
    type,
    source: `C:/tmp/${taskId}.result.json`,
    observed_at: '2026-06-01T00:00:30.000Z',
    summary: `${id} proof`,
    data: {},
    proof_token: id,
  };
}

function evaluation(path = 'C:/tmp/octogent-live-child-ack-smoke.result.json') {
  return {
    passed: true,
    score: 100,
    summary: 'Result quality passed.',
    issues: [],
    evaluated_at: '2026-06-01T00:00:40.000Z',
    evaluator: 'atlas-operator-evaluator',
    final_verdict: 'passed' as const,
    retryable_route: true,
    retry_used: false,
    source_result_path: path,
    winning_result_path: path,
    result_chain_paths: [path],
    evidence_chain_paths: [path],
    attempts: [],
  };
}

function result(taskId: string, overrides: Partial<OperatorResult> = {}): OperatorResult {
  return parseOperatorResult({
    task_id: taskId,
    status: 'success',
    executor: 'manual',
    started_at: '2026-06-01T00:00:00.000Z',
    completed_at: '2026-06-01T00:01:00.000Z',
    summary: `${taskId} result`,
    evidence: [evidence(taskId, `${taskId}.proof`)],
    errors: [],
    trace_path: `C:/tmp/${taskId}.result.json`,
    ...overrides,
  });
}

function runWith(results: OperatorResult[]) {
  const calls: OperatorTask[] = [];
  const written: OperatorResult[] = [];
  const output = runOperatorLifecycle(sourceTask, {
    now: () => '2026-06-01T00:00:00.000Z',
    dispatchTask: (task) => {
      calls.push(task);
      const next = results[calls.length - 1];
      if (!next) throw new Error(`missing mocked result for ${task.id}`);
      return next;
    },
    writeTrace: (operatorResult, options) => {
      const withPath = { ...operatorResult, trace_path: options?.tracePath ?? operatorResult.trace_path };
      written.push(withPath);
      return withPath;
    },
  });

  return { calls, output, written };
}

describe('operator lifecycle', () => {
  it('loads task refs by id', () => {
    const task = loadOperatorTaskRef('octogent-live-child-ack-smoke');
    expect(task.id).toBe('octogent-live-child-ack-smoke');
  });

  it('stops when source dispatch blocks', () => {
    const { calls, output } = runWith([
      result(sourceTask.id, {
        status: 'blocked',
        summary: 'Dispatch blocked',
        errors: ['control stopped'],
        trace_path: 'C:/tmp/source.result.json',
      }),
    ]);

    expect(calls.map((task) => task.id)).toEqual([sourceTask.id]);
    expect(output.status).toBe('blocked');
    expect(output.lifecycle?.promotion_task_id).toBeUndefined();
    expect(output.lifecycle?.blocked_reason).toBe('control stopped');
  });

  it('blocks when evaluator fails and promotion blocks', () => {
    const evalTaskId = 'octogent-live-child-ack-smoke-life-eval';
    const promTaskId = 'octogent-live-child-ack-smoke-life-prom';
    const { calls, output } = runWith([
      result(sourceTask.id, { executor: 'octogent', trace_path: 'C:/tmp/source.result.json' }),
      result(evalTaskId, {
        status: 'blocked',
        trace_path: `C:/tmp/${evalTaskId}.result.json`,
        evaluation: {
          ...evaluation('C:/tmp/source.result.json'),
          passed: false,
          final_verdict: 'blocked',
          score: 40,
          issues: [{ code: 'quality_failed', message: 'quality failed twice' }],
          winning_result_path: undefined,
        },
      }),
      result(promTaskId, {
        status: 'blocked',
        trace_path: `C:/tmp/${promTaskId}.result.json`,
        evaluation: {
          ...evaluation('C:/tmp/source.result.json'),
          passed: false,
          final_verdict: 'blocked',
          score: 40,
          issues: [{ code: 'quality_failed', message: 'quality failed twice' }],
          winning_result_path: undefined,
        },
        promotion: {
          promoted: false,
          status: 'blocked',
          reason: 'promotion blocked: evaluator verdict did not pass',
          safe_reply: 'Not verified.',
          proof_tokens: [`${promTaskId}.proof`],
          current_turn_proof_tokens: [],
          final_verdict: 'blocked',
        },
      }),
    ]);

    expect(calls.map((task) => task.id)).toEqual([sourceTask.id, evalTaskId, promTaskId]);
    expect(calls[1]?.inputs.result_task_id).toBe(sourceTask.id);
    expect(calls[1]?.inputs.source_task).toEqual(sourceTask);
    expect(calls[2]?.inputs.promotion_result_task_id).toBe(evalTaskId);
    expect(output.status).toBe('blocked');
    expect(output.lifecycle?.blocked_reason).toContain('evaluator verdict');
  });

  it('succeeds only after promoted result', () => {
    const evalTaskId = 'octogent-live-child-ack-smoke-life-eval';
    const promTaskId = 'octogent-live-child-ack-smoke-life-prom';
    const sourcePath = 'C:/tmp/source.result.json';
    const { output, written } = runWith([
      result(sourceTask.id, {
        executor: 'octogent',
        trace_path: sourcePath,
        evidence: [
          evidence(sourceTask.id, `${sourceTask.id}.command`, 'command_exit'),
          evidence(sourceTask.id, `${sourceTask.id}.trace`, 'log_trace'),
        ],
      }),
      result(evalTaskId, {
        trace_path: `C:/tmp/${evalTaskId}.result.json`,
        evaluation: evaluation(sourcePath),
      }),
      result(promTaskId, {
        trace_path: `C:/tmp/${promTaskId}.result.json`,
        evaluation: evaluation(sourcePath),
        promotion: {
          promoted: true,
          status: 'promoted',
          reason: 'promotion passed: evaluator verdict and durable proof present',
          safe_reply: 'Not verified.',
          proof_tokens: [`${promTaskId}.proof`, `${sourceTask.id}.command`, `${sourceTask.id}.trace`],
          current_turn_proof_tokens: [],
          final_verdict: 'passed',
          winning_result_path: sourcePath,
          source_result_path: sourcePath,
        },
      }),
    ]);

    expect(output.status).toBe('success');
    expect(output.promotion?.promoted).toBe(true);
    expect(output.lifecycle?.child_result_paths).toHaveLength(3);
    expect(output.lifecycle?.proof_tokens).toContain(`${sourceTask.id}.command`);
    expect(output.lifecycle?.proof_tokens).toContain('octogent-live-child-ack-smoke-lifecycle.trace');
    expect(written[0]?.trace_path).toBe(lifecycleResultPath(sourceTask.id));
  });
});
