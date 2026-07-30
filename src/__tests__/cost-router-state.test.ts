import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquirePremiumOwner,
  assertCostRouterReceipt,
  claimScheduledAsyncResume,
  consumeLocalSlice,
  createGoalRouterRecord,
  loadGoalRouterRecord,
  NOT_APPLICABLE,
  recordRetryEvent,
  registerAsyncResearchHandle,
  releasePremiumOwner,
  type CostRouterReceipt,
} from '../atlas/cost-router-state.js';

const NOW = '2026-07-30T00:00:00.000Z';
const LATER = '2026-07-30T00:05:00.000Z';
const DUE = '2026-07-30T00:30:00.000Z';
const AFTER_EXPIRY = '2026-07-30T00:46:00.000Z';
const CHILD_FIXTURE = fileURLToPath(
  new URL('./fixtures/cost-router-state-child.ts', import.meta.url)
);
const OWNER = {
  phaseId: 'phase-001',
  taskId: 'task-001',
  seat: 'codex-sol' as const,
  acquiredAt: NOW,
  expiresAt: '2026-07-30T00:30:00.000Z',
};
const HANDLE = {
  handleId: 'handle-001',
  goalId: 'goal-research-1',
  taskId: 'task-research-1',
  phaseId: 'phase-research-1',
  providerId: 'perplexity-browser',
  providerProfileHash: 'sha256:profile-001',
  remoteJobId: 'remote-001',
  submittedAt: NOW,
  expiresAt: '2026-07-30T00:45:00.000Z',
  nextResumeAt: '2026-07-30T00:30:00.000Z',
  inspectionCount: 0,
  maxInspections: 2,
  outputRef: 'receipts/handle-001.json',
  state: 'scheduled' as const,
};

describe('atlas/cost-router-state', () => {
  let sandboxDir: string;
  let rootDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-cost-router-state-'));
    rootDir = join(sandboxDir, 'cost-router');
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  describe('goal record creation and cold-read', () => {
    it('persists explicit zeroed ceilings outside the checkout', async () => {
      const created = await createGoalRouterRecord('goal-001', NOW, { rootDir });
      const expectedPath = join(rootDir, 'goals', 'goal-001.json');

      expect(existsSync(expectedPath)).toBe(true);
      expect(created).toMatchObject({
        schemaVersion: 1,
        goalId: 'goal-001',
        revision: 0,
        escalationLedger: {},
        retryLedger: {},
        openAsyncHandles: [],
        budget: {
          maxLocalSlices: 4,
          usedLocalSlices: 0,
          maxResearchJobs: 2,
          usedResearchJobs: 0,
          maxPremiumEscalations: 1,
          usedPremiumEscalations: 0,
          meteredSpendLimitUsd: 0,
        },
        updatedAt: NOW,
      });
    });

    it('cold-reads a valid record from disk', async () => {
      await createGoalRouterRecord('goal-002', NOW, { rootDir });

      const loaded = loadGoalRouterRecord('goal-002', { rootDir });

      expect(loaded.goalId).toBe('goal-002');
      expect(loaded.revision).toBe(0);
      expect(loaded.budget.maxResearchJobs).toBe(2);
    });

    it('refuses duplicate creation', async () => {
      await createGoalRouterRecord('goal-003', NOW, { rootDir });

      await expect(
        createGoalRouterRecord('goal-003', NOW, { rootDir })
      ).rejects.toMatchObject({ code: 'goal_exists' });
    });

    it('fails closed when goal state is missing', () => {
      expect(() =>
        loadGoalRouterRecord('goal-missing', { rootDir })
      ).toThrow(expect.objectContaining({ code: 'goal_state_missing' }));
    });

    it.each([
      ['malformed JSON', '{'],
      ['schema-invalid JSON', JSON.stringify({ schemaVersion: 1 })],
    ])('fails closed on %s', (_label, body) => {
      const path = join(rootDir, 'goals', 'goal-corrupt.json');
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body, 'utf8');

      expect(() =>
        loadGoalRouterRecord('goal-corrupt', { rootDir })
      ).toThrow(expect.objectContaining({ code: 'goal_state_corrupt' }));
    });

    it.each(['../escape', 'slash/escape', '', '.hidden'])(
      'rejects unsafe goal id %j',
      async (goalId) => {
        await expect(
          createGoalRouterRecord(goalId, NOW, { rootDir })
        ).rejects.toMatchObject({ code: 'goal_id_invalid' });
      }
    );

    it('fails closed when a persisted handle belongs to another goal', async () => {
      const path = join(rootDir, 'goals', 'goal-integrity-1.json');
      await createGoalRouterRecord('goal-integrity-1', NOW, { rootDir });
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.openAsyncHandles = [{ ...HANDLE, goalId: 'goal-other' }];
      record.budget.usedResearchJobs = 1;
      writeFileSync(path, JSON.stringify(record), 'utf8');

      expect(() =>
        loadGoalRouterRecord('goal-integrity-1', { rootDir })
      ).toThrow(expect.objectContaining({ code: 'goal_state_corrupt' }));
    });

    it('fails closed when premium ownership lacks a consumed escalation', async () => {
      const path = join(rootDir, 'goals', 'goal-integrity-2.json');
      await createGoalRouterRecord('goal-integrity-2', NOW, { rootDir });
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.activePremiumOwner = OWNER;
      writeFileSync(path, JSON.stringify(record), 'utf8');

      expect(() =>
        loadGoalRouterRecord('goal-integrity-2', { rootDir })
      ).toThrow(expect.objectContaining({ code: 'goal_state_corrupt' }));
    });
  });

  describe('exclusive premium ownership', () => {
    it('survives cold-read with escalation and goal counters intact', async () => {
      await createGoalRouterRecord('goal-premium-1', NOW, { rootDir });

      const acquired = await acquirePremiumOwner(
        'goal-premium-1',
        OWNER,
        NOW,
        { rootDir }
      );
      const coldRead = loadGoalRouterRecord('goal-premium-1', { rootDir });

      expect(acquired.revision).toBe(1);
      expect(coldRead.activePremiumOwner).toEqual(OWNER);
      expect(coldRead.escalationLedger['task-001']).toBe(1);
      expect(coldRead.budget.usedPremiumEscalations).toBe(1);
      expect(coldRead.revision).toBe(1);
    });

    it('refuses a second active owner after cold-read', async () => {
      await createGoalRouterRecord('goal-premium-2', NOW, { rootDir });
      await acquirePremiumOwner('goal-premium-2', OWNER, NOW, { rootDir });
      loadGoalRouterRecord('goal-premium-2', { rootDir });

      await expect(
        acquirePremiumOwner(
          'goal-premium-2',
          {
            ...OWNER,
            phaseId: 'phase-002',
            taskId: 'task-002',
            seat: 'opus',
          },
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'premium_owner_active' });
    });

    it('refuses wrong-phase release and accepts exact-phase release', async () => {
      await createGoalRouterRecord('goal-premium-3', NOW, { rootDir });
      await acquirePremiumOwner('goal-premium-3', OWNER, NOW, { rootDir });

      await expect(
        releasePremiumOwner('goal-premium-3', 'phase-wrong', LATER, { rootDir })
      ).rejects.toMatchObject({ code: 'premium_owner_mismatch' });

      const released = await releasePremiumOwner(
        'goal-premium-3',
        'phase-001',
        LATER,
        { rootDir }
      );
      expect(released.activePremiumOwner).toBeUndefined();
      expect(released.revision).toBe(2);
    });

    it('keeps the per-task escalation consumed after release', async () => {
      await createGoalRouterRecord('goal-premium-4', NOW, { rootDir });
      await acquirePremiumOwner('goal-premium-4', OWNER, NOW, { rootDir });
      await releasePremiumOwner('goal-premium-4', 'phase-001', LATER, { rootDir });

      await expect(
        acquirePremiumOwner(
          'goal-premium-4',
          { ...OWNER, phaseId: 'phase-002', acquiredAt: LATER },
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'task_escalation_exhausted' });
    });

    it('enforces the goal-level premium ceiling after release', async () => {
      await createGoalRouterRecord('goal-premium-5', NOW, { rootDir });
      await acquirePremiumOwner('goal-premium-5', OWNER, NOW, { rootDir });
      await releasePremiumOwner('goal-premium-5', 'phase-001', LATER, { rootDir });

      await expect(
        acquirePremiumOwner(
          'goal-premium-5',
          {
            ...OWNER,
            phaseId: 'phase-002',
            taskId: 'task-002',
            acquiredAt: LATER,
          },
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'goal_premium_budget_exhausted' });
    });

    it('serializes concurrent acquisition so exactly one owner wins', async () => {
      await createGoalRouterRecord('goal-premium-race', NOW, { rootDir });

      const results = await Promise.allSettled([
        acquirePremiumOwner('goal-premium-race', OWNER, NOW, { rootDir }),
        acquirePremiumOwner(
          'goal-premium-race',
          {
            ...OWNER,
            phaseId: 'phase-002',
            taskId: 'task-002',
            seat: 'opus',
          },
          NOW,
          { rootDir }
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejection = results.find((result) => result.status === 'rejected');
      expect(rejection).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'premium_owner_active' }),
      });
    });
  });

  describe('fresh-process restart durability', () => {
    it('preserves owner and counters and rejects a conflicting child owner', async () => {
      await createGoalRouterRecord('goal-restart', NOW, { rootDir });
      await consumeLocalSlice('goal-restart', NOW, { rootDir });
      await recordRetryEvent(
        'goal-restart',
        'task-001',
        'transport_retry',
        NOW,
        { rootDir }
      );
      await acquirePremiumOwner('goal-restart', OWNER, NOW, { rootDir });

      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          CHILD_FIXTURE,
          'inspect-and-conflict',
          rootDir,
          'goal-restart',
          LATER,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10_000,
        }
      );

      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toEqual({
        goalId: 'goal-restart',
        revision: 3,
        activeTaskId: 'task-001',
        usedLocalSlices: 1,
        usedPremiumEscalations: 1,
        transportRetries: 1,
        conflictCode: 'premium_owner_active',
      });
    });
  });

  describe('bounded asynchronous research handles', () => {
    it('persists one handle and its research counter across cold-read', async () => {
      await createGoalRouterRecord('goal-research-1', NOW, { rootDir });

      const registered = await registerAsyncResearchHandle(
        'goal-research-1',
        HANDLE,
        NOW,
        { rootDir }
      );
      const coldRead = loadGoalRouterRecord('goal-research-1', { rootDir });

      expect(registered.revision).toBe(1);
      expect(coldRead.openAsyncHandles).toEqual([HANDLE]);
      expect(coldRead.budget.usedResearchJobs).toBe(1);
    });

    it('refuses a handle belonging to another goal', async () => {
      await createGoalRouterRecord('goal-research-2', NOW, { rootDir });

      await expect(
        registerAsyncResearchHandle('goal-research-2', HANDLE, NOW, { rootDir })
      ).rejects.toMatchObject({ code: 'async_handle_goal_mismatch' });
    });

    it('refuses a duplicate handle id', async () => {
      await createGoalRouterRecord('goal-research-1', NOW, { rootDir });
      await registerAsyncResearchHandle('goal-research-1', HANDLE, NOW, { rootDir });

      await expect(
        registerAsyncResearchHandle('goal-research-1', HANDLE, NOW, { rootDir })
      ).rejects.toMatchObject({ code: 'async_handle_exists' });
    });

    it('refuses a third research job at the goal ceiling', async () => {
      await createGoalRouterRecord('goal-research-1', NOW, { rootDir });
      await registerAsyncResearchHandle('goal-research-1', HANDLE, NOW, { rootDir });
      await registerAsyncResearchHandle(
        'goal-research-1',
        {
          ...HANDLE,
          handleId: 'handle-002',
          taskId: 'task-research-2',
          phaseId: 'phase-research-2',
          remoteJobId: 'remote-002',
          outputRef: 'receipts/handle-002.json',
        },
        NOW,
        { rootDir }
      );

      await expect(
        registerAsyncResearchHandle(
          'goal-research-1',
          {
            ...HANDLE,
            handleId: 'handle-003',
            taskId: 'task-research-3',
            phaseId: 'phase-research-3',
            remoteJobId: 'remote-003',
            outputRef: 'receipts/handle-003.json',
          },
          NOW,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'goal_research_budget_exhausted' });
    });

    it('refuses an already expired handle locally', async () => {
      await createGoalRouterRecord('goal-research-1', NOW, { rootDir });

      await expect(
        registerAsyncResearchHandle(
          'goal-research-1',
          {
            ...HANDLE,
            expiresAt: '2026-07-30T00:04:00.000Z',
            nextResumeAt: '2026-07-30T00:03:00.000Z',
          },
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'async_handle_expired' });
    });
  });

  describe('exact-once scheduled resume claims', () => {
    it('refuses an early claim without mutating the handle', async () => {
      await createGoalRouterRecord('goal-resume-early', NOW, { rootDir });
      await registerAsyncResearchHandle(
        'goal-resume-early',
        { ...HANDLE, goalId: 'goal-resume-early' },
        NOW,
        { rootDir }
      );

      await expect(
        claimScheduledAsyncResume(
          'goal-resume-early',
          'handle-001',
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'async_resume_not_due' });

      const coldRead = loadGoalRouterRecord('goal-resume-early', { rootDir });
      expect(coldRead.revision).toBe(1);
      expect(coldRead.openAsyncHandles[0]).toMatchObject({
        inspectionCount: 0,
      });
      expect(coldRead.openAsyncHandles[0]).not.toHaveProperty('resumeClaimedAt');
    });

    it('persists one due claim before returning authorization', async () => {
      await createGoalRouterRecord('goal-resume-due', NOW, { rootDir });
      await registerAsyncResearchHandle(
        'goal-resume-due',
        { ...HANDLE, goalId: 'goal-resume-due' },
        NOW,
        { rootDir }
      );

      const result = await claimScheduledAsyncResume(
        'goal-resume-due',
        'handle-001',
        DUE,
        { rootDir }
      );
      const coldRead = loadGoalRouterRecord('goal-resume-due', { rootDir });

      expect(result.status).toBe('claimed');
      if (result.status !== 'claimed') throw new Error('expected claimed');
      expect(result.handle).toMatchObject({
        resumeClaimedAt: DUE,
        inspectionCount: 1,
      });
      expect(result.record.revision).toBe(2);
      expect(coldRead.openAsyncHandles[0]).toEqual(result.handle);
    });

    it('refuses a second claim for the same scheduled event after cold-read', async () => {
      await createGoalRouterRecord('goal-resume-twice', NOW, { rootDir });
      await registerAsyncResearchHandle(
        'goal-resume-twice',
        { ...HANDLE, goalId: 'goal-resume-twice' },
        NOW,
        { rootDir }
      );
      await claimScheduledAsyncResume(
        'goal-resume-twice',
        'handle-001',
        DUE,
        { rootDir }
      );
      loadGoalRouterRecord('goal-resume-twice', { rootDir });

      await expect(
        claimScheduledAsyncResume(
          'goal-resume-twice',
          'handle-001',
          DUE,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'async_resume_already_claimed' });
      expect(
        loadGoalRouterRecord('goal-resume-twice', { rootDir }).revision
      ).toBe(2);
    });

    it('serializes concurrent claims so exactly one caller wins', async () => {
      await createGoalRouterRecord('goal-resume-race', NOW, { rootDir });
      await registerAsyncResearchHandle(
        'goal-resume-race',
        { ...HANDLE, goalId: 'goal-resume-race' },
        NOW,
        { rootDir }
      );

      const results = await Promise.allSettled([
        claimScheduledAsyncResume(
          'goal-resume-race',
          'handle-001',
          DUE,
          { rootDir }
        ),
        claimScheduledAsyncResume(
          'goal-resume-race',
          'handle-001',
          DUE,
          { rootDir }
        ),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]).toMatchObject({
        status: 'fulfilled',
        value: { status: 'claimed' },
      });
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'async_resume_already_claimed' }),
      });
    });
  });

  describe('local async terminal outcomes', () => {
    it('resolves an unknown handle locally without a provider call', async () => {
      await createGoalRouterRecord('goal-resume-unknown', NOW, { rootDir });
      const providerInspect = vi.fn();

      const result = await claimScheduledAsyncResume(
        'goal-resume-unknown',
        'handle-unknown',
        DUE,
        { rootDir }
      );
      if (result.status === 'claimed') await providerInspect(result.handle);

      expect(result).toMatchObject({
        status: 'async_expired',
        reason: 'unknown',
        handleId: 'handle-unknown',
        record: { revision: 0 },
      });
      expect(providerInspect).not.toHaveBeenCalled();
    });

    it('persists an expired handle locally without a provider call', async () => {
      await createGoalRouterRecord('goal-resume-expired', NOW, { rootDir });
      await registerAsyncResearchHandle(
        'goal-resume-expired',
        { ...HANDLE, goalId: 'goal-resume-expired' },
        NOW,
        { rootDir }
      );
      const providerInspect = vi.fn();

      const result = await claimScheduledAsyncResume(
        'goal-resume-expired',
        'handle-001',
        AFTER_EXPIRY,
        { rootDir }
      );
      if (result.status === 'claimed') await providerInspect(result.handle);

      expect(result).toMatchObject({
        status: 'async_expired',
        reason: 'expired',
        handleId: 'handle-001',
        record: { revision: 2 },
      });
      expect(
        loadGoalRouterRecord('goal-resume-expired', { rootDir })
          .openAsyncHandles[0].state
      ).toBe('expired');
      expect(providerInspect).not.toHaveBeenCalled();
    });

    it('closes an exhausted inspection budget without a provider call', async () => {
      const goalId = 'goal-resume-exhausted';
      const path = join(rootDir, 'goals', `${goalId}.json`);
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      await registerAsyncResearchHandle(
        goalId,
        { ...HANDLE, goalId },
        NOW,
        { rootDir }
      );
      const persisted = JSON.parse(readFileSync(path, 'utf8'));
      persisted.openAsyncHandles[0].inspectionCount = 2;
      writeFileSync(path, JSON.stringify(persisted), 'utf8');
      const providerInspect = vi.fn();

      const result = await claimScheduledAsyncResume(
        goalId,
        'handle-001',
        DUE,
        { rootDir }
      );
      if (result.status === 'claimed') await providerInspect(result.handle);

      expect(result).toMatchObject({
        status: 'async_expired',
        reason: 'inspection_budget_exhausted',
        handleId: 'handle-001',
        record: { revision: 2 },
      });
      expect(
        loadGoalRouterRecord(goalId, { rootDir }).openAsyncHandles[0].state
      ).toBe('failed');
      expect(providerInspect).not.toHaveBeenCalled();

      const repeated = await claimScheduledAsyncResume(
        goalId,
        'handle-001',
        DUE,
        { rootDir }
      );
      expect(repeated).toMatchObject({
        status: 'async_expired',
        reason: 'inspection_budget_exhausted',
        record: { revision: 2 },
      });
    });
  });

  describe('durable slice and retry ceilings', () => {
    it('persists four local slices and refuses the fifth', async () => {
      await createGoalRouterRecord('goal-slices', NOW, { rootDir });
      for (let index = 0; index < 4; index += 1) {
        await consumeLocalSlice('goal-slices', NOW, { rootDir });
      }

      const coldRead = loadGoalRouterRecord('goal-slices', { rootDir });
      expect(coldRead.budget.usedLocalSlices).toBe(4);
      expect(coldRead.revision).toBe(4);
      await expect(
        consumeLocalSlice('goal-slices', NOW, { rootDir })
      ).rejects.toMatchObject({ code: 'goal_local_slice_budget_exhausted' });
    });

    it('persists one transport retry and one provider failover', async () => {
      await createGoalRouterRecord('goal-retries-1', NOW, { rootDir });
      await recordRetryEvent(
        'goal-retries-1',
        'task-retry-1',
        'transport_retry',
        NOW,
        { rootDir }
      );
      await recordRetryEvent(
        'goal-retries-1',
        'task-retry-1',
        'provider_failover',
        LATER,
        { rootDir }
      );

      expect(
        loadGoalRouterRecord('goal-retries-1', { rootDir }).retryLedger[
          'task-retry-1'
        ]
      ).toEqual({
        denialAttempts: 0,
        transportRetries: 1,
        providerFailovers: 1,
      });
    });

    it('refuses a second retry and a second provider failover', async () => {
      await createGoalRouterRecord('goal-retries-2', NOW, { rootDir });
      await recordRetryEvent(
        'goal-retries-2',
        'task-retry-2',
        'transport_retry',
        NOW,
        { rootDir }
      );
      await expect(
        recordRetryEvent(
          'goal-retries-2',
          'task-retry-2',
          'transport_retry',
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'transport_retry_exhausted' });

      await recordRetryEvent(
        'goal-retries-2',
        'task-retry-2',
        'provider_failover',
        LATER,
        { rootDir }
      );
      await expect(
        recordRetryEvent(
          'goal-retries-2',
          'task-retry-2',
          'provider_failover',
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'provider_failover_exhausted' });
    });

    it('treats a recorded denial as terminal for later retry events', async () => {
      await createGoalRouterRecord('goal-retries-3', NOW, { rootDir });
      await recordRetryEvent(
        'goal-retries-3',
        'task-denied',
        'denial',
        NOW,
        { rootDir }
      );

      await expect(
        recordRetryEvent(
          'goal-retries-3',
          'task-denied',
          'transport_retry',
          LATER,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'retry_after_denial_refused' });
      expect(
        loadGoalRouterRecord('goal-retries-3', { rootDir }).retryLedger[
          'task-denied'
        ]
      ).toEqual({
        denialAttempts: 1,
        transportRetries: 0,
        providerFailovers: 0,
      });
    });
  });

  describe('M2D repair: assertCostRouterReceipt rejects an empty sources array', () => {
    function receiptWith(sources: CostRouterReceipt['sources']): CostRouterReceipt {
      return {
        provider: 'trusted-keyed-1',
        elapsedMs: 0,
        sources,
        retries: { transportRetries: 0, providerFailovers: 0 },
        privacyDecision: 'cleared',
        costClass: 'free',
        verifierStatus: NOT_APPLICABLE,
        blocker: NOT_APPLICABLE,
        nextAction: 'deliver result to caller',
      };
    }

    it('rejects an empty sources array — a route with no sources must use NOT_APPLICABLE, never []', () => {
      expect(() => assertCostRouterReceipt(receiptWith([]))).toThrow(
        expect.objectContaining({ code: 'cost_router_receipt_invalid' })
      );
    });

    it('accepts the NOT_APPLICABLE marker for sources', () => {
      expect(() => assertCostRouterReceipt(receiptWith(NOT_APPLICABLE))).not.toThrow();
    });

    it('accepts a genuinely populated sources array', () => {
      expect(() =>
        assertCostRouterReceipt(receiptWith(['https://example.test/source']))
      ).not.toThrow();
    });
  });
});
