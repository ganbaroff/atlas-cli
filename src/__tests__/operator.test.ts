import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseOperatorResult,
  parseOperatorRunLedgerEntry,
  parseOperatorTask,
  selectCanonicalRunLedgerEntry,
  validateResultEvidence,
} from '../operator/contracts.js';

describe('operator contracts', () => {
  it('accepts sandboxed OpenManus read-only task', () => {
    const task = parseOperatorTask({
      id: 'openmanus-smoke-readonly',
      title: 'OpenManus read-only smoke',
      created_at: '2026-05-29T15:16:00.000Z',
      route: 'openmanus',
      mode: 'read_only',
      cwd: 'C:/Projects/OpenManus',
      allowed_paths: ['C:/Projects/OpenManus'],
      objective: 'Verify OpenManus can run as hands/body without fake success.',
      inputs: {},
      expected_evidence: ['browser_observation', 'browser_session_trace', 'log_trace'],
      safety: {
        sandbox_required: true,
        network_allowed: true,
        write_allowed: false,
      },
    });

    expect(task.route).toBe('openmanus');
  });

  it('rejects OpenManus without sandbox', () => {
    expect(() => parseOperatorTask({
      id: 'openmanus-nosandbox',
      title: 'OpenManus unsafe smoke',
      created_at: '2026-05-29T15:16:00.000Z',
      route: 'openmanus',
      mode: 'read_only',
      cwd: 'C:/Projects/OpenManus',
      allowed_paths: ['C:/Projects/OpenManus'],
      objective: 'Verify OpenManus sandbox guard blocks unsafe tasks.',
      inputs: {},
      expected_evidence: ['log_trace'],
      safety: {
        sandbox_required: false,
        network_allowed: true,
        write_allowed: false,
      },
    })).toThrow(/sandbox/i);
  });

  it('accepts Vellum read-only gate task', () => {
    const task = parseOperatorTask({
      id: 'vellum-gate-smoke',
      title: 'Vellum gate smoke',
      created_at: '2026-05-30T00:00:00.000Z',
      route: 'vellum',
      mode: 'read_only',
      cwd: 'C:/Projects/vellum-assistant',
      allowed_paths: ['C:/Projects/vellum-assistant'],
      objective: 'Verify Vellum repo shape, assistant package, and docs for memory/security boundaries.',
      inputs: {},
      expected_evidence: ['file_read', 'log_trace'],
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: false,
      },
    });

    expect(task.route).toBe('vellum');
  });

  it('accepts Octogent live child-ack smoke task', () => {
    const task = parseOperatorTask({
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
        start_port: 8795,
        timeout_ms: 240000,
        parent_terminal_id: 'octogent-live-parent',
        child_terminal_id: 'octogent-live-child',
        parent_prompt: 'Live parent ready.',
        child_prompt: 'Live child ready.',
        parent_message: 'Need ACK from child.',
        child_message: 'ACK: live worker online.',
      },
      expected_evidence: ['command_exit', 'log_trace'],
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: false,
      },
    });

    expect(task.inputs.runtime_mode).toBe('live_child_ack');
  });

  it('blocks success when expected evidence is missing', () => {
    const task = parseOperatorTask({
      id: 'local-smoke',
      title: 'Local smoke',
      created_at: '2026-05-29T15:16:00.000Z',
      route: 'local',
      mode: 'read_only',
      cwd: '.',
      allowed_paths: ['.'],
      objective: 'Verify evidence gate catches fake success.',
      inputs: {},
      expected_evidence: ['command_exit'],
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: false,
      },
    });

    const gate = validateResultEvidence(task, {
      task_id: task.id,
      status: 'success',
      executor: 'atlas',
      started_at: '2026-05-29T15:16:00.000Z',
      completed_at: '2026-05-29T15:17:00.000Z',
      summary: 'Fake success',
      evidence: [],
      errors: [],
    });

    expect(gate).toEqual({ passed: false, missing: ['command_exit'] });
  });

  it('accepts proof_token on operator evidence', () => {
    const result = parseOperatorResult({
      task_id: 'octogent-live-child-ack-smoke',
      status: 'success',
      executor: 'octogent',
      started_at: '2026-05-30T08:55:00.000Z',
      completed_at: '2026-05-30T08:56:00.000Z',
      summary: 'Proof token smoke',
      evidence: [
        {
          id: 'octogent-live-child-ack-smoke.command',
          task_id: 'octogent-live-child-ack-smoke',
          type: 'command_exit',
          source: 'node scripts/octogent-live-child-ack-smoke.mjs',
          observed_at: '2026-05-30T08:56:00.000Z',
          summary: 'Process exited cleanly',
          data: {},
          proof_token: 'proof:octogent-live-child-ack-smoke.command',
        },
      ],
      errors: [],
    });

    expect(result.evidence[0]?.proof_token).toBe('proof:octogent-live-child-ack-smoke.command');
  });

  it('accepts browser session trace evidence', () => {
    const result = parseOperatorResult({
      task_id: 'openmanus-smoke-readonly',
      status: 'success',
      executor: 'openmanus',
      started_at: '2026-05-30T08:55:00.000Z',
      completed_at: '2026-05-30T08:56:00.000Z',
      summary: 'Browser trace smoke',
      evidence: [
        {
          id: 'openmanus-smoke-readonly.browser.trace',
          task_id: 'openmanus-smoke-readonly',
          type: 'browser_session_trace',
          source: 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/operator/runs/openmanus-smoke-readonly.result.json',
          observed_at: '2026-05-30T08:56:00.000Z',
          summary: 'Browser observation persisted in trace',
          data: {
            trace_path: 'C:/Users/user/OneDrive/Documents/GitHub/ANUS/operator/runs/openmanus-smoke-readonly.result.json',
          },
          proof_token: 'openmanus-smoke-readonly.browser.trace',
        },
      ],
      errors: [],
    });

    expect(result.evidence[0]?.type).toBe('browser_session_trace');
    expect(result.evidence[0]?.proof_token).toBe('openmanus-smoke-readonly.browser.trace');
  });

  it('records self-reported success blocked by verifier in run ledger', () => {
    const entry = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000001',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:00:00.000Z',
      completed_at: '2026-06-13T10:01:00.000Z',
      status: 'success',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: 'operator/runs/local-smoke.result.json',
    });

    expect(entry.status).toBe('success');
    expect(entry.verdict).toBe('blocked');
  });

  it('records verifier-passed run with durable proof token', () => {
    const entry = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000002',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:02:00.000Z',
      completed_at: '2026-06-13T10:03:00.000Z',
      status: 'success',
      verdict: 'passed',
      expected_evidence_met: true,
      proof_tokens: ['proof:local-smoke.command'],
      result_path: 'operator/runs/local-smoke.retry-1.result.json',
    });

    expect(entry.proof_tokens).toEqual(['proof:local-smoke.command']);
  });

  it('rejects verifier-passed ledger entry when expected evidence is missing', () => {
    expect(() => parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000003',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:04:00.000Z',
      completed_at: '2026-06-13T10:05:00.000Z',
      status: 'success',
      verdict: 'passed',
      expected_evidence_met: false,
      proof_tokens: ['proof:local-smoke.command'],
      result_path: 'operator/runs/local-smoke.result.json',
    })).toThrow(/expected evidence/i);
  });

  it('selects latest passed ledger entry as canonical without mutating ledger rows', () => {
    const firstBlocked = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000001',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:00:00.000Z',
      completed_at: '2026-06-13T10:01:00.000Z',
      status: 'success',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: 'operator/runs/local-smoke.result.json',
    });

    const firstPassed = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000002',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:02:00.000Z',
      completed_at: '2026-06-13T10:03:00.000Z',
      status: 'success',
      verdict: 'passed',
      expected_evidence_met: true,
      proof_tokens: ['proof:local-smoke.command'],
      result_path: 'operator/runs/local-smoke.retry-1.result.json',
    });

    const newerBlocked = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000003',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:04:00.000Z',
      completed_at: '2026-06-13T10:05:00.000Z',
      status: 'success',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: 'operator/runs/local-smoke.retry-2.result.json',
    });

    expect(selectCanonicalRunLedgerEntry([newerBlocked, firstBlocked, firstPassed])?.run_id)
      .toBe('local-smoke.20260613-000002');
  });

  it('falls back to latest blocked ledger entry when no run passed', () => {
    const firstBlocked = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000001',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:00:00.000Z',
      completed_at: '2026-06-13T10:01:00.000Z',
      status: 'success',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: 'operator/runs/local-smoke.result.json',
    });

    const newerBlocked = parseOperatorRunLedgerEntry({
      run_id: 'local-smoke.20260613-000004',
      task_id: 'local-smoke',
      executor: 'atlas',
      started_at: '2026-06-13T10:06:00.000Z',
      completed_at: '2026-06-13T10:07:00.000Z',
      status: 'blocked',
      verdict: 'blocked',
      expected_evidence_met: false,
      proof_tokens: [],
      result_path: 'operator/runs/local-smoke.result.json',
    });

    expect(selectCanonicalRunLedgerEntry([newerBlocked, firstBlocked])?.run_id)
      .toBe('local-smoke.20260613-000004');
  });

  it('keeps JSON run-ledger schema aligned with contract essentials', () => {
    const schema = JSON.parse(
      readFileSync(resolve(process.cwd(), 'operator/schemas/run-ledger.schema.json'), 'utf-8'),
    );

    expect(schema.required).toEqual([
      'run_id',
      'task_id',
      'executor',
      'started_at',
      'completed_at',
      'status',
      'verdict',
      'expected_evidence_met',
      'proof_tokens',
      'result_path',
    ]);
    expect(schema.properties.status.enum).toEqual(['success', 'failure', 'blocked', 'skipped']);
    expect(schema.properties.verdict.enum).toEqual(['passed', 'blocked']);
    expect(schema.properties.executor.enum).toEqual(['atlas', 'openmanus', 'octogent', 'vellum', 'manual']);
  });
});
