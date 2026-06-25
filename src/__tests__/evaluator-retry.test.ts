import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluateOperatorResultWithRetry } from '../operator/evaluator.js';
import { parseOperatorResult, parseOperatorTask } from '../operator/contracts.js';

function tempTracePath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'anus-evaluator-'));
  return join(dir, `${name}.result.json`);
}

function writeTrace(path: string): void {
  writeFileSync(path, '{"ok":true}\n', 'utf-8');
}

function baseTask(route: 'local' | 'manual', overrides: Record<string, unknown> = {}) {
  return parseOperatorTask({
    id: `retry-${route}`,
    title: `Retry ${route}`,
    created_at: '2026-06-01T00:00:00.000Z',
    route,
    mode: 'read_only',
    cwd: '.',
    allowed_paths: ['.'],
    objective: 'Exercise retry-aware evaluator flow.',
    inputs: {},
    expected_evidence: ['command_exit'],
    safety: {
      sandbox_required: false,
      network_allowed: false,
      write_allowed: false,
    },
    ...overrides,
  });
}

function commandEvidence(taskId: string, proofToken?: string) {
  return [
    {
      id: `${taskId}.command`,
      task_id: taskId,
      type: 'command_exit' as const,
      source: 'shell',
      observed_at: '2026-06-01T00:00:00.000Z',
      summary: 'Command exited cleanly',
      data: {},
      ...(proofToken ? { proof_token: proofToken } : {}),
    },
  ];
}

describe('retry-aware evaluator', () => {
  it('passes without retry for already good result', () => {
    const task = baseTask('local');
    const sourceResultPath = tempTracePath('source-pass');
    writeTrace(sourceResultPath);
    const sourceResult = parseOperatorResult({
      task_id: task.id,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: '2026-06-01T00:01:00.000Z',
      summary: 'Good result',
      evidence: commandEvidence(task.id, `${task.id}.command`),
      errors: [],
      trace_path: sourceResultPath,
    });
    const retryDispatcher = vi.fn();

    const bundle = evaluateOperatorResultWithRetry({
      task,
      sourceResult,
      sourceResultPath,
      retryDispatcher,
    });

    expect(bundle.evaluation.passed).toBe(true);
    expect(bundle.evaluation.retry_used).toBe(false);
    expect(bundle.evaluation.final_verdict).toBe('passed');
    expect(bundle.evaluation.attempts).toHaveLength(1);
    expect(bundle.evaluation.result_chain_paths).toEqual([sourceResultPath]);
    expect(bundle.evaluation.winning_result_path).toBe(sourceResultPath);
    expect(bundle.retryAttempt).toBeUndefined();
    expect(retryDispatcher).not.toHaveBeenCalled();
  });

  it('retries once and promotes pass', () => {
    const task = baseTask('local');
    const sourceResultPath = tempTracePath('source-fail');
    const retryResultPath = sourceResultPath.replace(/\.result\.json$/i, '.retry-1.result.json');
    writeTrace(sourceResultPath);
    const sourceResult = parseOperatorResult({
      task_id: task.id,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: '2026-06-01T00:01:00.000Z',
      summary: 'Missing proof token',
      evidence: commandEvidence(task.id),
      errors: [],
      trace_path: sourceResultPath,
    });
    const retryDispatcher = vi.fn(({ tracePath }: { tracePath: string }) => {
      writeTrace(tracePath);
      return parseOperatorResult({
        task_id: task.id,
        status: 'success',
        executor: 'atlas',
        started_at: '2026-06-01T00:02:00.000Z',
        completed_at: '2026-06-01T00:03:00.000Z',
        summary: 'Retry fixed proof',
        evidence: commandEvidence(task.id, `${task.id}.retry.command`),
        errors: [],
        trace_path: tracePath,
      });
    });

    const bundle = evaluateOperatorResultWithRetry({
      task,
      sourceResult,
      sourceResultPath,
      retryDispatcher,
    });

    expect(retryDispatcher).toHaveBeenCalledTimes(1);
    expect(bundle.retryResultPath).toBe(retryResultPath);
    expect(bundle.retryAttempt?.attempt).toBe('retry');
    expect(bundle.evaluation.passed).toBe(true);
    expect(bundle.evaluation.retry_used).toBe(true);
    expect(bundle.evaluation.final_verdict).toBe('passed');
    expect(bundle.evaluation.attempts).toHaveLength(2);
    expect(bundle.evaluation.result_chain_paths).toEqual([sourceResultPath, retryResultPath]);
    expect(bundle.evaluation.winning_result_path).toBe(retryResultPath);
  });

  it('retries once and still blocks on second failure', () => {
    const task = baseTask('local');
    const sourceResultPath = tempTracePath('source-blocked');
    const retryResultPath = sourceResultPath.replace(/\.result\.json$/i, '.retry-1.result.json');
    writeTrace(sourceResultPath);
    const sourceResult = parseOperatorResult({
      task_id: task.id,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: '2026-06-01T00:01:00.000Z',
      summary: 'Missing proof token',
      evidence: commandEvidence(task.id),
      errors: [],
      trace_path: sourceResultPath,
    });
    const retryDispatcher = vi.fn(({ tracePath }: { tracePath: string }) => {
      writeTrace(tracePath);
      return parseOperatorResult({
        task_id: task.id,
        status: 'success',
        executor: 'atlas',
        started_at: '2026-06-01T00:02:00.000Z',
        completed_at: '2026-06-01T00:03:00.000Z',
        summary: 'Retry still missing proof',
        evidence: commandEvidence(task.id),
        errors: [],
        trace_path: tracePath,
      });
    });

    const bundle = evaluateOperatorResultWithRetry({
      task,
      sourceResult,
      sourceResultPath,
      retryDispatcher,
    });

    expect(retryDispatcher).toHaveBeenCalledTimes(1);
    expect(bundle.evaluation.passed).toBe(false);
    expect(bundle.evaluation.retry_used).toBe(true);
    expect(bundle.evaluation.final_verdict).toBe('blocked');
    expect(bundle.evaluation.attempts).toHaveLength(2);
    expect(bundle.evaluation.result_chain_paths).toEqual([sourceResultPath, retryResultPath]);
    expect(bundle.evaluation.winning_result_path).toBeUndefined();
    expect(bundle.retryAttempt?.result_path).toBe(retryResultPath);
  });

  it('does not retry manual route', () => {
    const task = baseTask('manual');
    const sourceResultPath = tempTracePath('manual-fail');
    writeTrace(sourceResultPath);
    const sourceResult = parseOperatorResult({
      task_id: task.id,
      status: 'success',
      executor: 'manual',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: '2026-06-01T00:01:00.000Z',
      summary: 'Missing proof token',
      evidence: commandEvidence(task.id),
      errors: [],
      trace_path: sourceResultPath,
    });
    const retryDispatcher = vi.fn();

    const bundle = evaluateOperatorResultWithRetry({
      task,
      sourceResult,
      sourceResultPath,
      retryDispatcher,
    });

    expect(bundle.evaluation.passed).toBe(false);
    expect(bundle.evaluation.retry_used).toBe(false);
    expect(bundle.evaluation.final_verdict).toBe('blocked');
    expect(bundle.evaluation.attempts).toHaveLength(1);
    expect(bundle.retryAttempt).toBeUndefined();
    expect(retryDispatcher).not.toHaveBeenCalled();
  });

  it('does not retry write tasks without idempotency contract', () => {
    const task = baseTask('local', {
      mode: 'write',
      objective: 'Exercise retry guard for write task without idempotency contract.',
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: true,
      },
    });
    const sourceResultPath = tempTracePath('write-fail');
    writeTrace(sourceResultPath);
    const sourceResult = parseOperatorResult({
      task_id: task.id,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-06-01T00:00:00.000Z',
      completed_at: '2026-06-01T00:01:00.000Z',
      summary: 'Missing proof token',
      evidence: commandEvidence(task.id),
      errors: [],
      trace_path: sourceResultPath,
    });
    const retryDispatcher = vi.fn();

    const bundle = evaluateOperatorResultWithRetry({
      task,
      sourceResult,
      sourceResultPath,
      retryDispatcher,
    });

    expect(bundle.evaluation.passed).toBe(false);
    expect(bundle.evaluation.retryable_route).toBe(false);
    expect(bundle.evaluation.retry_used).toBe(false);
    expect(bundle.retryAttempt).toBeUndefined();
    expect(retryDispatcher).not.toHaveBeenCalled();
  });
});
