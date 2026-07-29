import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_CLASS_TABLE,
  isWeakerClass,
  resolveRoute,
  runRoutedAttempt,
  runTrustedRoutedAttempt,
  type ClearanceException,
  type ProviderAttemptResult,
  type ProviderCandidate,
  type ProviderClass,
  type TrustedRoutedAttemptParams,
} from '../atlas/cost-router-classify.js';
import { createGoalRouterRecord, loadGoalRouterRecord } from '../atlas/cost-router-state.js';

const NOW = '2026-07-30T00:00:00.000Z';

const KEYED_SERVICE: ProviderClass = {
  identityBearing: false,
  retentionTerm: 'none',
  canActBeyondBrief: false,
};
const IDENTITY_SESSION: ProviderClass = {
  identityBearing: true,
  retentionTerm: 'bounded',
  canActBeyondBrief: false,
};
const IDENTITY_UNBOUNDED_AGENTIC: ProviderClass = {
  identityBearing: true,
  retentionTerm: 'indefinite',
  canActBeyondBrief: true,
};

describe('atlas/cost-router-classify: M2C destination-bound clearance', () => {
  let sandboxDir: string;
  let rootDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-cost-router-clearance-'));
    rootDir = join(sandboxDir, 'cost-router');
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  describe('isWeakerClass: agency dominates, all else equal', () => {
    it('treats a provider able to act beyond its brief as strictly weaker than one that cannot', () => {
      const cannotActBeyond: ProviderClass = {
        identityBearing: true,
        retentionTerm: 'bounded',
        canActBeyondBrief: false,
      };
      const canActBeyond: ProviderClass = { ...cannotActBeyond, canActBeyondBrief: true };

      expect(isWeakerClass(canActBeyond, cannotActBeyond)).toBe(true);
      expect(isWeakerClass(cannotActBeyond, canActBeyond)).toBe(false);
    });
  });

  describe('failover path applies the clearance check too', () => {
    it('refuses a weaker-class failover target, naming the reason, and never calls it', async () => {
      const goalId = 'goal-clearance-failover';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-clearance-failover-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: false, failure: { isTransportFailure: true } });

      await expect(
        runRoutedAttempt({
          route,
          goalId,
          taskId: 'task-clearance-failover-1',
          now: NOW,
          currentProvider: { providerId: 'keyed-1', tier: 'free' },
          failoverCandidates: [{ providerId: 'weak-1', tier: 'cheap' }],
          attempt,
          options: { rootDir },
          briefClearance: KEYED_SERVICE,
          providerClasses: {
            'keyed-1': KEYED_SERVICE,
            'weak-1': IDENTITY_SESSION,
          },
        }),
      ).rejects.toMatchObject({ reason: 'destination_class_too_weak' });

      expect(attempt).toHaveBeenCalledTimes(2);
      const calledProviderIds = attempt.mock.calls.map((call) => (call[0] as ProviderCandidate).providerId);
      expect(calledProviderIds.every((providerId) => providerId === 'keyed-1')).toBe(true);
    });
  });

  describe('receipt records the destination class actually used', () => {
    it('records the failover target class, not the class assumed at compose time', async () => {
      const goalId = 'goal-clearance-final-class';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-final-class-1', needsLocalWorker: true });

      const attempt = vi.fn((provider: ProviderCandidate): ProviderAttemptResult => {
        if (provider.providerId === 'sess-1') {
          return { ok: false, failure: { isTransportFailure: true } };
        }
        return { ok: true };
      });

      const result = await runRoutedAttempt({
        route,
        goalId,
        taskId: 'task-final-class-1',
        now: NOW,
        currentProvider: { providerId: 'sess-1', tier: 'free' },
        failoverCandidates: [{ providerId: 'keyed-1', tier: 'cheap' }],
        attempt,
        options: { rootDir },
        briefClearance: IDENTITY_SESSION,
        providerClasses: {
          'sess-1': IDENTITY_SESSION,
          'keyed-1': KEYED_SERVICE, // strictly stronger than required, not "the original"
        },
      });

      expect(result.status).toBe('succeeded');
      expect(result.finalProviderId).toBe('keyed-1');
      expect(result.finalProviderClass).toEqual(KEYED_SERVICE);
      expect(result.finalProviderClass).not.toEqual(IDENTITY_SESSION);
    });
  });

  describe('operator exception', () => {
    it('lets a cross-class send proceed and records the exception plus permitted class on the durable record', async () => {
      const goalId = 'goal-clearance-exception';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-exception-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });

      const exception: ClearanceException = {
        reason: 'CEO-approved one-off export for task-exception-1',
        approvedBy: 'yusif',
        permittedClass: IDENTITY_UNBOUNDED_AGENTIC,
      };

      const result = await runRoutedAttempt({
        route,
        goalId,
        taskId: 'task-exception-1',
        now: NOW,
        currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
        attempt,
        options: { rootDir },
        briefClearance: KEYED_SERVICE,
        providerClasses: { 'agentic-1': IDENTITY_UNBOUNDED_AGENTIC },
        clearanceException: exception,
      });

      expect(result.status).toBe('succeeded');
      expect(attempt).toHaveBeenCalledTimes(1);

      const record = loadGoalRouterRecord(goalId, { rootDir });
      expect(record.clearanceLedger?.['task-exception-1']).toMatchObject({
        reason: exception.reason,
        approvedBy: exception.approvedBy,
        permittedClass: IDENTITY_UNBOUNDED_AGENTIC,
      });
    });
  });

  describe('the supported entry point cannot be given a substitute table', () => {
    it('ignores a smuggled availability/providerClasses table and still refuses an untrusted destination', async () => {
      const goalId = 'goal-clearance-trusted-refuse';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-trusted-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });

      const forgedAvailability = { T0: true, T1: true, T2: true, T3: true };
      const forgedProviderClasses = { 'sneaky-1': KEYED_SERVICE };

      const smuggled = {
        route,
        goalId,
        taskId: 'task-trusted-1',
        now: NOW,
        currentProvider: { providerId: 'sneaky-1', tier: 'free' as const },
        attempt,
        options: { rootDir },
        briefClearance: KEYED_SERVICE,
        // TrustedRoutedAttemptParams declares no such fields; this proves the
        // parameter is simply not reachable through the supported entry point.
        availability: forgedAvailability,
        providerClasses: forgedProviderClasses,
      } as unknown as TrustedRoutedAttemptParams;

      await expect(runTrustedRoutedAttempt(smuggled)).rejects.toMatchObject({
        reason: 'destination_class_unknown',
      });
      expect(attempt).not.toHaveBeenCalled();
    });

    it('still succeeds end to end for a providerId that is genuinely in the trusted table', async () => {
      const goalId = 'goal-clearance-trusted-happy';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-trusted-2', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const trustedProviderId = 'trusted-keyed-1';

      const result = await runTrustedRoutedAttempt({
        route,
        goalId,
        taskId: 'task-trusted-2',
        now: NOW,
        currentProvider: { providerId: trustedProviderId, tier: 'free' },
        attempt,
        options: { rootDir },
        briefClearance: KEYED_SERVICE,
      });

      expect(result.status).toBe('succeeded');
      expect(result.finalProviderClass).toEqual(DEFAULT_PROVIDER_CLASS_TABLE[trustedProviderId]);
    });
  });

  describe('backward compatibility: no clearance regime declared', () => {
    it('behaves exactly as before M2C when briefClearance is not set', async () => {
      const goalId = 'goal-clearance-optional';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-optional-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });

      const result = await runRoutedAttempt({
        route,
        goalId,
        taskId: 'task-optional-1',
        now: NOW,
        currentProvider: { providerId: 'whatever-1', tier: 'free' },
        attempt,
        options: { rootDir },
      });

      expect(result.status).toBe('succeeded');
      expect(result.finalProviderClass).toBeUndefined();
    });
  });
});
