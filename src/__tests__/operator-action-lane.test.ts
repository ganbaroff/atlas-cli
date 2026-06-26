import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { compileOperatorActionTask, runOperatorActionLane } from '../operator/action-lane.js';
import {
  appendRunLedgerEntry,
  buildRunLedgerEntry,
  buildRunId,
  selectCanonicalRunLedgerEntryForTask,
} from '../operator/run-ledger.js';
import {
  parseOperatorResult,
  parseOperatorTask,
  type OperatorResult,
  type OperatorRunLedgerEntry,
  type OperatorTask,
} from '../operator/contracts.js';

const now = () => '2026-06-13T10:00:00.000Z';

function evidence(taskId: string, id: string) {
  return {
    id,
    task_id: taskId,
    type: 'log_trace' as const,
    source: `C:/tmp/${taskId}.result.json`,
    observed_at: '2026-06-13T10:00:30.000Z',
    summary: `${id} proof`,
    data: {},
    proof_token: id,
  };
}

function promotedLifecycleResult(task: OperatorTask): OperatorResult {
  return parseOperatorResult({
    task_id: `${task.id}-lifecycle`,
    status: 'success',
    executor: 'atlas',
    started_at: '2026-06-13T10:00:00.000Z',
    completed_at: '2026-06-13T10:01:00.000Z',
    summary: `Lifecycle promoted: ${task.id}.`,
    evidence: [evidence(`${task.id}-lifecycle`, `${task.id}-lifecycle.trace`)],
    errors: [],
    trace_path: `C:/tmp/${task.id}.lifecycle.result.json`,
    promotion: {
      promoted: true,
      status: 'promoted',
      reason: 'promotion passed: evaluator verdict and durable proof present',
      safe_reply: 'Verified.',
      proof_tokens: [`${task.id}.command`, `${task.id}.trace`],
      current_turn_proof_tokens: [`${task.id}.command`],
      final_verdict: 'passed',
      winning_result_path: `C:/tmp/${task.id}.result.json`,
      source_result_path: `C:/tmp/${task.id}.result.json`,
    },
    lifecycle: {
      source_task_id: task.id,
      dispatch_result_path: `C:/tmp/${task.id}.result.json`,
      evaluation_task_id: `${task.id}-life-eval`,
      evaluation_result_path: `C:/tmp/${task.id}-life-eval.result.json`,
      promotion_task_id: `${task.id}-life-prom`,
      promotion_result_path: `C:/tmp/${task.id}-life-prom.result.json`,
      child_result_paths: [
        `C:/tmp/${task.id}.result.json`,
        `C:/tmp/${task.id}-life-eval.result.json`,
        `C:/tmp/${task.id}-life-prom.result.json`,
      ],
      proof_tokens: [`${task.id}.command`, `${task.id}.trace`, `${task.id}-lifecycle.trace`],
      final_status: 'success',
    },
  });
}

describe('operator action lane', () => {
  it('compiles explicit smoke command into OpenManus task contract', () => {
    const task = compileOperatorActionTask('/operator smoke https://example.com Example Domain', {
      now,
      source: 'telegram',
      openManusCwd: 'C:/Projects/OpenManus',
    });

    expect(task?.id).toBe('telegram-openmanus-smoke-example-com-20260613t100000000z');
    expect(task?.route).toBe('openmanus');
    expect(task?.mode).toBe('read_only');
    expect(task?.inputs.smoke_url).toBe('https://example.com');
    expect(task?.inputs.expected_text).toBe('Example Domain');
    expect(task?.expected_evidence).toContain('browser_session_trace');
    expect(task?.safety.write_allowed).toBe(false);
  });

  it('ignores normal chat so LLM path remains separate', () => {
    expect(compileOperatorActionTask('hello atlas', { now })).toBeNull();
  });

  it('compiles explicit local smoke command into local read-only task contract', () => {
    const task = compileOperatorActionTask('/operator local-smoke https://example.com Example Domain', {
      now,
      source: 'cli',
    });

    expect(task?.id).toBe('cli-local-smoke-example-com-20260613t100000000z');
    expect(task?.route).toBe('local');
    expect(task?.mode).toBe('read_only');
    expect(task?.inputs.runtime_mode).toBe('http_smoke');
    expect(task?.inputs.smoke_url).toBe('https://example.com');
    expect(task?.safety.sandbox_required).toBe(false);
    expect(task?.safety.write_allowed).toBe(false);
  });

  it('compiles explicit file smoke command into local read-only task contract', () => {
    const task = compileOperatorActionTask('/operator file-smoke README.md Atlas', {
      now,
      source: 'cli',
    });

    expect(task?.id).toBe('cli-file-smoke-readme-md-20260613t100000000z');
    expect(task?.route).toBe('local');
    expect(task?.mode).toBe('read_only');
    expect(task?.inputs.runtime_mode).toBe('file_smoke');
    expect(task?.inputs.file_path).toBe('README.md');
    expect(task?.expected_evidence).toEqual(['file_exists', 'file_read', 'log_trace']);
    expect(task?.safety.network_allowed).toBe(false);
    expect(task?.safety.write_allowed).toBe(false);
  });

  it('keeps action task ids distinct within the same second', () => {
    const first = compileOperatorActionTask('/operator file-smoke README.md Atlas', {
      now: () => '2026-06-13T10:00:00.000Z',
      source: 'cli',
    });
    const second = compileOperatorActionTask('/operator file-smoke README.md Atlas', {
      now: () => '2026-06-13T10:00:00.001Z',
      source: 'cli',
    });

    expect(first?.id).not.toBe(second?.id);
    expect(second?.id).toBe('cli-file-smoke-readme-md-20260613t100000001z');
  });

  it('runs lifecycle and appends passed ledger row', () => {
    const appended: OperatorRunLedgerEntry[] = [];
    const outcome = runOperatorActionLane('/operator smoke https://example.com Example Domain', {
      now,
      source: 'cli',
      openManusCwd: 'C:/Projects/OpenManus',
      runLifecycle: promotedLifecycleResult,
      appendLedger: (task, result) => {
        const entry = buildRunLedgerEntry(task, result, appended);
        appended.push(entry);
        return entry;
      },
    });

    expect(outcome.handled).toBe(true);
    expect(outcome.ledgerEntry?.verdict).toBe('passed');
    expect(outcome.ledgerEntry?.expected_evidence_met).toBe(true);
    expect(outcome.reply).toContain('Action lane passed');
    expect(appended).toHaveLength(1);
  });

  it('records fake lifecycle success as verifier-blocked ledger row', () => {
    const task = parseOperatorTask({
      id: 'cli-openmanus-smoke-example-com-20260613t100000',
      title: 'OpenManus smoke example-com',
      created_at: now(),
      route: 'openmanus',
      mode: 'read_only',
      cwd: 'C:/Projects/OpenManus',
      allowed_paths: ['C:/Projects/OpenManus'],
      objective: 'Verify fake success stays blocked without promotion proof.',
      inputs: {},
      expected_evidence: ['command_exit'],
      safety: {
        sandbox_required: true,
        network_allowed: true,
        write_allowed: false,
      },
    });
    const fakeSuccess = parseOperatorResult({
      task_id: `${task.id}-lifecycle`,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-06-13T10:00:00.000Z',
      completed_at: '2026-06-13T10:01:00.000Z',
      summary: 'Claimed success without proof.',
      evidence: [],
      errors: [],
      trace_path: `C:/tmp/${task.id}.lifecycle.result.json`,
      lifecycle: {
        source_task_id: task.id,
        child_result_paths: [],
        proof_tokens: [],
        final_status: 'success',
      },
    });

    const entry = buildRunLedgerEntry(task, fakeSuccess, []);

    expect(entry.status).toBe('success');
    expect(entry.verdict).toBe('blocked');
    expect(entry.expected_evidence_met).toBe(false);
  });

  it('builds collision-proof run ids with per-timestamp sequence', () => {
    const first = buildRunId('local-smoke', '2026-06-13T10:01:00.000Z', []);
    const second = buildRunId('local-smoke', '2026-06-13T10:01:00.000Z', [{
      run_id: first,
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:00:00.000Z',
      completed_at: '2026-06-13T10:01:00.000Z',
      status: 'success',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: 'operator/runs/local-smoke.result.json',
    }]);

    expect(first).toBe('local-smoke.20260613t100100000z.000001');
    expect(second).toBe('local-smoke.20260613t100100000z.000002');
  });

  it('selects canonical entry from append-only ledger file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-ledger-'));
    const ledgerPath = join(dir, 'run-ledger.jsonl');
    try {
      const first = {
        run_id: 'local-smoke.20260613t100100000z.000001',
        task_id: 'local-smoke',
        executor: 'atlas' as const,
        started_at: '2026-06-13T10:00:00.000Z',
        completed_at: '2026-06-13T10:01:00.000Z',
        status: 'success' as const,
        verdict: 'blocked' as const,
        expected_evidence_met: false,
        proof_tokens: [],
        result_path: 'operator/runs/local-smoke.result.json',
      };
      const second = {
        ...first,
        run_id: 'local-smoke.20260613t100200000z.000001',
        completed_at: '2026-06-13T10:02:00.000Z',
        verdict: 'passed' as const,
        expected_evidence_met: true,
        proof_tokens: ['local-smoke.command'],
        result_path: 'operator/runs/local-smoke.retry.result.json',
      };

      appendRunLedgerEntry(first, ledgerPath);
      appendRunLedgerEntry(second, ledgerPath);

      expect(selectCanonicalRunLedgerEntryForTask('local-smoke', ledgerPath)?.run_id)
        .toBe(second.run_id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
