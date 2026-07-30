import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ROUTE_AVAILABILITY,
  resolveRoute,
  runTrustedRoutedAttempt,
  signClearanceException,
  type ProviderCandidate,
  type RouteAvailability,
} from '../atlas/cost-router-classify.js';
import { withTrustedTables } from '../atlas/cost-router-test-seam.js';
import {
  acquirePremiumOwner,
  claimScheduledAsyncResume,
  createGoalRouterRecord,
  loadGoalRouterRecord,
  NOT_APPLICABLE,
  registerAsyncResearchHandle,
  releasePremiumOwner,
} from '../atlas/cost-router-state.js';
import {
  FAKE_PROVIDER_CLASS_TABLE,
  FAKE_T0_DETERMINISTIC_TOOL,
  FAKE_T1_RESEARCH_PROVIDER,
  FAKE_T2_FAILOVER_WORKER,
  FAKE_T2_LOCAL_WORKER,
  FAKE_T3_PREMIUM_REASONING,
  fakeDenialAttempt,
  fakeDeterministicToolAttempt,
  fakeLocalWorkerAttempt,
  fakePremiumReasoningAttempt,
  fakeResearchAttempt,
  fakeTransportFailureAttempt,
  fakeUnknownFailureAttempt,
} from './fixtures/cost-router-fake-providers.js';

const NOW = '2026-07-30T00:00:00.000Z';
const T1_AVAILABLE: RouteAvailability = Object.freeze({ ...DEFAULT_ROUTE_AVAILABILITY, T1: true });

/**
 * Every fake-provider id in this file is declared only in
 * `FAKE_PROVIDER_CLASS_TABLE` (fixtures), never in the module's own
 * `DEFAULT_PROVIDER_CLASS_TABLE` — so every call through
 * `runTrustedRoutedAttempt` in this file goes through `withTrustedTables`,
 * exactly like every other cost-router test file that exercises fakes.
 */
function fakeTables(availability: RouteAvailability = DEFAULT_ROUTE_AVAILABILITY) {
  return { availability, providerClasses: FAKE_PROVIDER_CLASS_TABLE };
}

// NO NETWORK: any outbound fetch anywhere in this file is a bug, not a
// feature — the fakes exist precisely so nothing here ever needs one.
// Wrapped in a helper (rather than an inline generic on `vi.spyOn`) purely
// so the spy's type can be inferred instead of spelled out.
function installFetchGuard() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('M2D integration must never perform real network I/O');
  });
}

describe('atlas/cost-router: M2D fake-provider end-to-end integration', () => {
  let sandboxDir: string;
  let rootDir: string;
  let fetchSpy: ReturnType<typeof installFetchGuard>;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-cost-router-m2d-'));
    rootDir = join(sandboxDir, 'cost-router');
    fetchSpy = installFetchGuard();
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    rmSync(sandboxDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe('one task per route completes with a fully populated receipt', () => {
    it('T0: deterministic tool', async () => {
      const goalId = 'goal-m2d-t0';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-m2d-t0', deterministicTool: 'grep' });
      const attempt = vi.fn(fakeDeterministicToolAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T0_DETERMINISTIC_TOOL.providerId];

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-t0',
          now: NOW,
          currentProvider: FAKE_T0_DETERMINISTIC_TOOL,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(result.receipt).toEqual({
        provider: FAKE_T0_DETERMINISTIC_TOOL.providerId,
        elapsedMs: expect.any(Number),
        sources: NOT_APPLICABLE,
        retries: { transportRetries: 0, providerFailovers: 0 },
        privacyDecision: 'cleared',
        costClass: 'free',
        verifierStatus: NOT_APPLICABLE,
        blocker: NOT_APPLICABLE,
        nextAction: 'deliver result to caller',
      });
      expect(result.receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('T1: sanitized-brief research provider', async () => {
      const goalId = 'goal-m2d-t1';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-m2d-t1', needsWebResearch: true }, T1_AVAILABLE);
      const attempt = vi.fn(fakeResearchAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T1_RESEARCH_PROVIDER.providerId];

      const result = await withTrustedTables(fakeTables(T1_AVAILABLE), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-t1',
          now: NOW,
          currentProvider: FAKE_T1_RESEARCH_PROVIDER,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(result.receipt.provider).toBe(FAKE_T1_RESEARCH_PROVIDER.providerId);
      expect(result.receipt.sources).toEqual([
        'https://fake-source.example/one',
        'https://fake-source.example/two',
      ]);
      expect(result.receipt.costClass).toBe('cheap');
      expect(result.receipt.privacyDecision).toBe('cleared');
      expect(result.receipt.blocker).toBe(NOT_APPLICABLE);
      expect(result.receipt.nextAction).toBe('deliver result to caller');
    });

    it('T2: bounded local worker', async () => {
      const goalId = 'goal-m2d-t2';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-m2d-t2', needsLocalWorker: true });
      const attempt = vi.fn(fakeLocalWorkerAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T2_LOCAL_WORKER.providerId];

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-t2',
          now: NOW,
          currentProvider: FAKE_T2_LOCAL_WORKER,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(result.receipt.provider).toBe(FAKE_T2_LOCAL_WORKER.providerId);
      expect(result.receipt.sources).toBe(NOT_APPLICABLE);
      expect(result.receipt.costClass).toBe('free');
    });

    it('T3: premium reasoning provider', async () => {
      const goalId = 'goal-m2d-t3';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({
        taskId: 'task-m2d-t3',
        needsPremiumReasoning: true,
        trigger: 'architecture',
      });
      const attempt = vi.fn(fakePremiumReasoningAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T3_PREMIUM_REASONING.providerId];

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-t3',
          now: NOW,
          currentProvider: FAKE_T3_PREMIUM_REASONING,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(result.receipt.provider).toBe(FAKE_T3_PREMIUM_REASONING.providerId);
      expect(result.receipt.costClass).toBe('premium');
      expect(result.receipt.sources).toBe(NOT_APPLICABLE);
    });
  });

  describe('async long-research path', () => {
    it('starts the job, releases the premium owner, resumes exactly once, and the resume produces the result', async () => {
      const goalId = 'goal-m2d-async-research';
      const taskId = 'task-m2d-async-research';
      const phaseId = 'phase-m2d-async-research';
      const handleId = 'handle-m2d-async-research';
      const resumeAt = '2026-07-30T00:30:00.000Z';
      const handleExpires = '2026-07-30T00:45:00.000Z';
      const ownerExpires = '2026-07-30T00:10:00.000Z';

      await createGoalRouterRecord(goalId, NOW, { rootDir });

      // Momentarily hold the exclusive premium seat while kicking the job off.
      await acquirePremiumOwner(
        goalId,
        {
          phaseId,
          taskId,
          seat: 'codex-sol',
          acquiredAt: NOW,
          expiresAt: ownerExpires,
        },
        NOW,
        { rootDir },
      );

      // Start the job: register the async research handle.
      await registerAsyncResearchHandle(
        goalId,
        {
          handleId,
          goalId,
          taskId,
          phaseId,
          providerId: FAKE_T1_RESEARCH_PROVIDER.providerId,
          providerProfileHash: 'sha256:fake-m2d-profile',
          submittedAt: NOW,
          expiresAt: handleExpires,
          nextResumeAt: resumeAt,
          inspectionCount: 0,
          maxInspections: 2,
          outputRef: 'receipts/handle-m2d-async-research.json',
          state: 'scheduled',
        },
        NOW,
        { rootDir },
      );

      // Release the premium owner: the async job runs without holding the seat.
      await releasePremiumOwner(goalId, phaseId, NOW, { rootDir });

      const claimed = await claimScheduledAsyncResume(goalId, handleId, resumeAt, { rootDir });
      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') throw new Error('unreachable');
      expect(claimed.handle.inspectionCount).toBe(1);

      // Resume exactly once: a second claim at the same due time is refused.
      await expect(
        claimScheduledAsyncResume(goalId, handleId, resumeAt, { rootDir }),
      ).rejects.toMatchObject({ code: 'async_resume_already_claimed' });

      // The resume produces the result: run the actual routed attempt now
      // that the job has been claimed.
      const route = resolveRoute({ taskId, needsWebResearch: true }, T1_AVAILABLE);
      const attempt = vi.fn(fakeResearchAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T1_RESEARCH_PROVIDER.providerId];

      const result = await withTrustedTables(fakeTables(T1_AVAILABLE), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId,
          now: resumeAt,
          currentProvider: FAKE_T1_RESEARCH_PROVIDER,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(result.receipt.sources).toEqual([
        'https://fake-source.example/one',
        'https://fake-source.example/two',
      ]);
    });

    it('an expired handle resolves to failed with zero provider calls', async () => {
      const goalId = 'goal-m2d-async-expired';
      const taskId = 'task-m2d-async-expired';
      const handleId = 'handle-m2d-async-expired';
      const nextResumeAt = '2026-07-30T00:02:00.000Z';
      const handleExpires = '2026-07-30T00:05:00.000Z';
      const afterExpiry = '2026-07-30T00:06:00.000Z';

      await createGoalRouterRecord(goalId, NOW, { rootDir });
      await registerAsyncResearchHandle(
        goalId,
        {
          handleId,
          goalId,
          taskId,
          phaseId: 'phase-m2d-async-expired',
          providerId: FAKE_T1_RESEARCH_PROVIDER.providerId,
          providerProfileHash: 'sha256:fake-m2d-expired-profile',
          submittedAt: NOW,
          expiresAt: handleExpires,
          nextResumeAt,
          inspectionCount: 0,
          maxInspections: 2,
          outputRef: 'receipts/handle-m2d-async-expired.json',
          state: 'scheduled',
        },
        NOW,
        { rootDir },
      );

      const claimAfterExpiry = await claimScheduledAsyncResume(goalId, handleId, afterExpiry, {
        rootDir,
      });
      expect(claimAfterExpiry.status).toBe('async_expired');
      if (claimAfterExpiry.status !== 'async_expired') throw new Error('unreachable');
      expect(claimAfterExpiry.reason).toBe('expired');

      const route = resolveRoute({ taskId, needsWebResearch: true }, T1_AVAILABLE);
      const attempt = vi.fn(fakeResearchAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T1_RESEARCH_PROVIDER.providerId];

      const result = await withTrustedTables(fakeTables(T1_AVAILABLE), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId,
          now: afterExpiry,
          currentProvider: FAKE_T1_RESEARCH_PROVIDER,
          isAsyncExpired: true,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('failed');
      expect(result.bucket).toBe('async-expired');
      expect(result.providerCalls).toBe(0);
      expect(attempt).not.toHaveBeenCalled();
      expect(result.receipt).toEqual({
        provider: NOT_APPLICABLE,
        elapsedMs: expect.any(Number),
        sources: NOT_APPLICABLE,
        retries: { transportRetries: 0, providerFailovers: 0 },
        privacyDecision: NOT_APPLICABLE,
        costClass: NOT_APPLICABLE,
        verifierStatus: NOT_APPLICABLE,
        blocker: 'async research handle already expired',
        nextAction: 'resubmit the async research job as a new handle',
      });
    });
  });

  describe('denial from a fake provider', () => {
    it('makes exactly one attempt with zero retries', async () => {
      const goalId = 'goal-m2d-denial';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-m2d-denial', needsLocalWorker: true });
      const attempt = vi.fn(fakeDenialAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T2_LOCAL_WORKER.providerId];

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-denial',
          now: NOW,
          currentProvider: FAKE_T2_LOCAL_WORKER,
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('failed');
      expect(result.bucket).toBe('denial');
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(result.receipt.retries).toEqual({ transportRetries: 0, providerFailovers: 0 });
      expect(result.receipt.blocker).toBe('provider denial');
      expect(result.receipt.sources).toBe(NOT_APPLICABLE);
    });
  });

  describe('transport failure then failover', () => {
    it('retries the same provider once, then fails over to exactly one non-premium fake, and the receipt records both', async () => {
      const goalId = 'goal-m2d-transport';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-m2d-transport', needsLocalWorker: true });
      const attempt = vi.fn((provider: ProviderCandidate) =>
        provider.providerId === FAKE_T2_LOCAL_WORKER.providerId
          ? fakeTransportFailureAttempt()
          : fakeLocalWorkerAttempt(),
      );
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T2_LOCAL_WORKER.providerId];

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-transport',
          now: NOW,
          currentProvider: FAKE_T2_LOCAL_WORKER,
          failoverCandidates: [
            { providerId: FAKE_T3_PREMIUM_REASONING.providerId, tier: 'premium' },
            FAKE_T2_FAILOVER_WORKER,
          ],
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(result.callsByProvider).toEqual({
        [FAKE_T2_LOCAL_WORKER.providerId]: 2,
        [FAKE_T2_FAILOVER_WORKER.providerId]: 1,
      });
      expect(result.finalProviderId).toBe(FAKE_T2_FAILOVER_WORKER.providerId);
      expect(result.callsByProvider[FAKE_T3_PREMIUM_REASONING.providerId]).toBeUndefined();
      expect(result.receipt.provider).toBe(FAKE_T2_FAILOVER_WORKER.providerId);
      expect(result.receipt.retries).toEqual({ transportRetries: 1, providerFailovers: 1 });
      expect(result.receipt.costClass).toBe('cheap');
      expect(result.receipt.blocker).toBe(NOT_APPLICABLE);
    });
  });

  describe('unknown/unclassified failure', () => {
    it('is treated exactly like denial: one attempt, zero retries', async () => {
      const goalId = 'goal-m2d-unknown';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-m2d-unknown', needsLocalWorker: true });
      const attempt = vi.fn(fakeUnknownFailureAttempt);
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T2_LOCAL_WORKER.providerId];

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-m2d-unknown',
          now: NOW,
          currentProvider: FAKE_T2_LOCAL_WORKER,
          failoverCandidates: [FAKE_T2_FAILOVER_WORKER],
          attempt,
          options: { rootDir },
          briefClearance: requiredClass,
        }),
      );

      expect(result.status).toBe('failed');
      expect(result.bucket).toBe('unknown');
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(result.callsByProvider[FAKE_T2_FAILOVER_WORKER.providerId]).toBeUndefined();
      expect(result.receipt.blocker).toBe('unclassified failure treated as denial (fail-closed)');
      expect(result.receipt.retries).toEqual({ transportRetries: 0, providerFailovers: 0 });
    });
  });

  describe('weaker-class destination clearance', () => {
    it('refuses end to end without an exception, then proceeds and is recorded with a correctly signed operator exception', async () => {
      const goalId = 'goal-m2d-clearance';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const requiredClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T2_LOCAL_WORKER.providerId];
      const weakDestinationClass = FAKE_PROVIDER_CLASS_TABLE[FAKE_T3_PREMIUM_REASONING.providerId];

      const refusedRoute = resolveRoute({ taskId: 'task-m2d-clearance-refused', needsLocalWorker: true });
      const refusedAttempt = vi.fn(fakePremiumReasoningAttempt);

      await expect(
        withTrustedTables(fakeTables(), () =>
          runTrustedRoutedAttempt({
            route: refusedRoute,
            goalId,
            taskId: 'task-m2d-clearance-refused',
            now: NOW,
            currentProvider: FAKE_T3_PREMIUM_REASONING,
            attempt: refusedAttempt,
            options: { rootDir },
            briefClearance: requiredClass,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'destination_class_too_weak' });
      expect(refusedAttempt).not.toHaveBeenCalled();

      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'm2d-fake-signing-key-not-real');
      const exception = signClearanceException(
        {
          reason: 'CEO-approved one-off M2D exception',
          approvedBy: 'yusif',
          permittedClass: weakDestinationClass,
        },
        'm2d-fake-signing-key-not-real',
      );

      const exceptionRoute = resolveRoute({ taskId: 'task-m2d-clearance-exception', needsLocalWorker: true });
      const exceptionAttempt = vi.fn(fakePremiumReasoningAttempt);

      const result = await withTrustedTables(fakeTables(), () =>
        runTrustedRoutedAttempt({
          route: exceptionRoute,
          goalId,
          taskId: 'task-m2d-clearance-exception',
          now: NOW,
          currentProvider: FAKE_T3_PREMIUM_REASONING,
          attempt: exceptionAttempt,
          options: { rootDir },
          briefClearance: requiredClass,
          clearanceException: exception,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(exceptionAttempt).toHaveBeenCalledTimes(1);
      expect(result.receipt.privacyDecision).toBe('exception_applied:yusif');

      const record = loadGoalRouterRecord(goalId, { rootDir });
      expect(record.clearanceLedger?.['task-m2d-clearance-exception']).toMatchObject({
        reason: exception.reason,
        approvedBy: exception.approvedBy,
        permittedClass: weakDestinationClass,
      });
    });
  });
});
