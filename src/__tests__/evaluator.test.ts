import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateOperatorResult } from '../operator/evaluator.js';
import { parseOperatorResult, parseOperatorTask } from '../operator/contracts.js';

describe('operator evaluator', () => {
  it('passes live child-ack result with durable proof chain', () => {
    const repoRoot = process.cwd();
    const task = parseOperatorTask(JSON.parse(readFileSync(resolve(repoRoot, 'operator/tasks/octogent-live-child-ack-smoke.json'), 'utf-8')));
    const result = parseOperatorResult(JSON.parse(readFileSync(resolve(repoRoot, 'operator/runs/octogent-live-child-ack-smoke.result.json'), 'utf-8')));

    const evaluation = evaluateOperatorResult(task, result);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.score).toBe(100);
    expect(evaluation.summary).toContain(task.id);
  });

  it('blocks success result without proof tokens', () => {
    const task = parseOperatorTask({
      id: 'local-smoke',
      title: 'Local smoke',
      created_at: '2026-05-31T00:00:00.000Z',
      route: 'local',
      mode: 'read_only',
      cwd: '.',
      allowed_paths: ['.'],
      objective: 'Verify judge catches fake success without proof tokens.',
      inputs: {},
      expected_evidence: ['command_exit'],
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: false,
      },
    });

    const result = parseOperatorResult({
      task_id: task.id,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-05-31T00:00:00.000Z',
      completed_at: '2026-05-31T00:01:00.000Z',
      summary: 'Fake success',
      evidence: [
        {
          id: 'local-smoke.command',
          task_id: task.id,
          type: 'command_exit',
          source: 'shell',
          observed_at: '2026-05-31T00:00:30.000Z',
          summary: 'Command exited cleanly',
          data: {},
        },
      ],
      errors: [],
    });

    const evaluation = evaluateOperatorResult(task, result);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.issues.map((issue) => issue.code)).toContain('missing_proof_tokens');
  });
});
