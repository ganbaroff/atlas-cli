/**
 * M9 — ANUS-side contract + failure matrix tests (no OPSBOARD product imports).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  processGoalRequest,
  resetGoalRequestSeenForTests,
  type GoalRequest,
} from '../opsboard/goal-request-port.js';

describe('M9 goal-request port', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-opsboard-'));
    process.env.ATLAS_OPSBOARD_EXCHANGE_DIR = dir;
    delete process.env.ATLAS_READONLY;
    resetGoalRequestSeenForTests();
  });

  afterEach(() => {
    delete process.env.ATLAS_OPSBOARD_EXCHANGE_DIR;
    delete process.env.ATLAS_READONLY;
    rmSync(dir, { recursive: true, force: true });
  });

  function req(partial: Partial<GoalRequest> = {}): GoalRequest {
    return {
      correlationId: partial.correlationId ?? 'corr_test_1',
      action: partial.action ?? 'run',
      objective: partial.objective ?? 'fixture objective',
      issuedAt: new Date().toISOString(),
      issuedBy: 'opsboard',
      timeoutMs: partial.timeoutMs ?? 2000,
      ...partial,
    };
  }

  it('completed receipt on successful runner', async () => {
    const receipt = await processGoalRequest(req(), {
      exchangeDir: dir,
      run: async () => ({ status: 'completed', goalId: 'goal_1', report: { ok: true } }),
    });
    expect(receipt.status).toBe('completed');
    expect(existsSync(join(dir, 'receipts', 'corr_test_1.json'))).toBe(true);
  });

  it('duplicate correlationId → duplicate', async () => {
    await processGoalRequest(req(), {
      exchangeDir: dir,
      run: async () => ({ status: 'completed' }),
    });
    const second = await processGoalRequest(req(), {
      exchangeDir: dir,
      run: async () => ({ status: 'completed' }),
    });
    expect(second.status).toBe('duplicate');
  });

  it('cancel → cancelled', async () => {
    const receipt = await processGoalRequest(req({ action: 'cancel' }), { exchangeDir: dir });
    expect(receipt.status).toBe('cancelled');
  });

  it('ATLAS_READONLY → readonly', async () => {
    process.env.ATLAS_READONLY = '1';
    const receipt = await processGoalRequest(req(), { exchangeDir: dir });
    expect(receipt.status).toBe('readonly');
  });

  it('timeout → timeout', async () => {
    const receipt = await processGoalRequest(req({ timeoutMs: 50 }), {
      exchangeDir: dir,
      run: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { status: 'completed' };
      },
    });
    expect(receipt.status).toBe('timeout');
  });

  it('runner throw → failed', async () => {
    const receipt = await processGoalRequest(req(), {
      exchangeDir: dir,
      run: async () => {
        throw new Error('boom');
      },
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.error).toMatch(/boom/);
  });

  it('receipt JSON is the only cross-repo artifact written by ANUS', async () => {
    await processGoalRequest(req({ correlationId: 'corr_art' }), {
      exchangeDir: dir,
      run: async () => ({ status: 'completed', report: { tasksVerified: 1 } }),
    });
    const body = JSON.parse(readFileSync(join(dir, 'receipts', 'corr_art.json'), 'utf8'));
    expect(body.correlationId).toBe('corr_art');
    expect(body.report.tasksVerified).toBe(1);
    // No exec-graph dump in exchange
    expect(existsSync(join(dir, 'graph.json'))).toBe(false);
  });
});
