/**
 * Sprint E — goal-runner terminal status → M8 evidence ledger write-back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGoal } from '../goal-runner/runner.js';
import { readLedgerEntries, verifyLedgerChain } from '../evidence/ledger.js';

describe('goal-runner evidence write-back', () => {
  let execDir: string;
  let budgetDir: string;
  let evidenceDir: string;

  beforeEach(() => {
    execDir = mkdtempSync(join(tmpdir(), 'goal-evidence-exec-'));
    budgetDir = mkdtempSync(join(tmpdir(), 'goal-evidence-budget-'));
    evidenceDir = mkdtempSync(join(tmpdir(), 'goal-evidence-ledger-'));
    process.env.ATLAS_EXEC_GRAPH_DIR = execDir;
    process.env.ATLAS_GOAL_BUDGET_DIR = budgetDir;
    process.env.ATLAS_EVIDENCE_DIR = evidenceDir;
  });

  afterEach(() => {
    delete process.env.ATLAS_EXEC_GRAPH_DIR;
    delete process.env.ATLAS_GOAL_BUDGET_DIR;
    delete process.env.ATLAS_EVIDENCE_DIR;
    rmSync(execDir, { recursive: true, force: true });
    rmSync(budgetDir, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  it('runGoal appends goal-terminal claim to evidence ledger on terminal status', async () => {
    const report = await runGoal({
      objective: 'Evidence write-back probe',
      handId: 'sonnet-foreground',
      config: {
        maxAttemptsPerTask: 1,
        maxTotalAttempts: 3,
        maxTotalTasks: 1,
        maxDecompositionRounds: 1,
        maxGraphDepth: 1,
        maxWallTimeMs: 30_000,
      },
      notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
    });

    expect(report.goalId).toMatch(/^gol_/);
    const entries = readLedgerEntries(evidenceDir);
    expect(entries.length).toBe(1);
    expect(verifyLedgerChain(entries).ok).toBe(true);

    const claim = entries[0]!.claim;
    expect(claim.source).toBe('goal-runner');
    expect(claim.sourceRef).toBe(report.goalId);
    expect(claim.type).toBe('narrative');
    expect(claim.confidence).toBe(0);

    const payload = JSON.parse(claim.claim) as {
      kind: string; goalId: string; status: string; handId: string;
    };
    expect(payload.kind).toBe('goal-terminal');
    expect(payload.goalId).toBe(report.goalId);
    expect(payload.handId).toBe('sonnet-foreground');
    expect(['completed', 'partial', 'failed', 'escalated']).toContain(payload.status);
  });

  it('evidence write-back is fail-open when ledger chain is broken', async () => {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(evidenceDir, 'ledger.jsonl'), '{"prevHash":null,"entryHash":"bad","claim":{}}\n');

    const report = await runGoal({
      objective: 'Fail-open probe',
      handId: 'sonnet-foreground',
      config: {
        maxAttemptsPerTask: 1,
        maxTotalAttempts: 3,
        maxTotalTasks: 1,
        maxDecompositionRounds: 1,
        maxGraphDepth: 1,
        maxWallTimeMs: 30_000,
      },
      notifyCeo: async () => ({ result: 'NOT_CONFIGURED' }),
    });

    expect(report.goalId).toMatch(/^gol_/);
    // Broken chain — append refused; goal still completes.
    expect(readLedgerEntries(evidenceDir).length).toBe(1);
  });
});
