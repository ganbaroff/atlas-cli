import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_CLASS_TABLE,
  DEFAULT_ROUTE_AVAILABILITY,
  isWeakerClass,
  resolveRoute,
  runTrustedRoutedAttempt,
  signClearanceException,
  type ClearanceException,
  type ProviderAttemptResult,
  type ProviderCandidate,
  type ProviderClass,
  type TrustedRoutedAttemptParams,
} from '../atlas/cost-router-classify.js';
import { withTrustedTables } from '../atlas/cost-router-test-seam.js';
import {
  assertCostRouterReceipt,
  createGoalRouterRecord,
  loadGoalRouterRecord,
} from '../atlas/cost-router-state.js';

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
    vi.unstubAllEnvs();
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
        withTrustedTables(
          {
            availability: DEFAULT_ROUTE_AVAILABILITY,
            providerClasses: { 'keyed-1': KEYED_SERVICE, 'weak-1': IDENTITY_SESSION },
          },
          () =>
            runTrustedRoutedAttempt({
              route,
              goalId,
              taskId: 'task-clearance-failover-1',
              now: NOW,
              currentProvider: { providerId: 'keyed-1', tier: 'free' },
              failoverCandidates: [{ providerId: 'weak-1', tier: 'cheap' }],
              attempt,
              options: { rootDir },
              briefClearance: KEYED_SERVICE,
            }),
        ),
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

      const result = await withTrustedTables(
        {
          availability: DEFAULT_ROUTE_AVAILABILITY,
          providerClasses: {
            'sess-1': IDENTITY_SESSION,
            'keyed-1': KEYED_SERVICE, // strictly stronger than required, not "the original"
          },
        },
        () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-final-class-1',
            now: NOW,
            currentProvider: { providerId: 'sess-1', tier: 'free' },
            failoverCandidates: [{ providerId: 'keyed-1', tier: 'cheap' }],
            attempt,
            options: { rootDir },
            briefClearance: IDENTITY_SESSION,
          }),
      );

      expect(result.status).toBe('succeeded');
      expect(result.finalProviderId).toBe('keyed-1');
      expect(result.finalProviderClass).toEqual(KEYED_SERVICE);
      expect(result.finalProviderClass).not.toEqual(IDENTITY_SESSION);
    });
  });

  describe('operator exception', () => {
    it('lets a cross-class send proceed and records the exception plus permitted class on the durable record, when correctly signed and a key is configured', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-exception';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-exception-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });

      const exception = signClearanceException(
        {
          reason: 'CEO-approved one-off export for task-exception-1',
          approvedBy: 'yusif',
          permittedClass: IDENTITY_UNBOUNDED_AGENTIC,
        },
        'test-fake-signing-key-not-real',
      );

      const result = await withTrustedTables(
        {
          availability: DEFAULT_ROUTE_AVAILABILITY,
          providerClasses: { 'agentic-1': IDENTITY_UNBOUNDED_AGENTIC },
        },
        () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-exception-1',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: exception,
          }),
      );

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

  describe('M2C repair: a clearance exception is not self-grantable — it must verify', () => {
    const baseFields = {
      reason: 'attempted self-grant',
      approvedBy: 'the-calling-code-itself',
      permittedClass: IDENTITY_UNBOUNDED_AGENTIC,
    };
    const agenticTables = {
      availability: DEFAULT_ROUTE_AVAILABILITY,
      providerClasses: { 'agentic-1': IDENTITY_UNBOUNDED_AGENTIC },
    };

    it('refuses an unsigned exception, even with a key configured, with its own named reason', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-unsigned';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-unsigned-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const unsigned: ClearanceException = { ...baseFields };

      await expect(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-unsigned-1',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: unsigned,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'exception_unsigned' });
      expect(attempt).not.toHaveBeenCalled();
    });

    it('refuses a mis-signed exception (tampered field) with its own named reason', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-missigned';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-missigned-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const signed = signClearanceException(baseFields, 'test-fake-signing-key-not-real');
      const tampered: ClearanceException = { ...signed, approvedBy: 'a-different-approver' };

      await expect(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-missigned-1',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: tampered,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'exception_signature_mismatch' });
      expect(attempt).not.toHaveBeenCalled();
    });

    it('refuses a replayed exception (same signature reused for a second send) with its own named reason', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-replay';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const signed = signClearanceException(baseFields, 'test-fake-signing-key-not-real');

      const routeFirst = resolveRoute({ taskId: 'task-replay-1', needsLocalWorker: true });
      const first = await withTrustedTables(agenticTables, () =>
        runTrustedRoutedAttempt({
          route: routeFirst,
          goalId,
          taskId: 'task-replay-1',
          now: NOW,
          currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
          attempt,
          options: { rootDir },
          briefClearance: KEYED_SERVICE,
          clearanceException: signed,
        }),
      );
      expect(first.status).toBe('succeeded');

      const routeSecond = resolveRoute({ taskId: 'task-replay-2', needsLocalWorker: true });
      await expect(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route: routeSecond,
            goalId,
            taskId: 'task-replay-2',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: signed,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'exception_signature_replayed' });
      expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('refuses a cross-class send when no signing key is configured — fails closed, never permits', async () => {
      const goalId = 'goal-clearance-nokey';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-nokey-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const unverifiable: ClearanceException = {
        ...baseFields,
        sig: 'deadbeef',
        ts: NOW,
        nonce: 'nonce-nokey-1',
      };

      await expect(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-nokey-1',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: unverifiable,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'exception_signing_key_not_configured' });
      expect(attempt).not.toHaveBeenCalled();
    });
  });

  describe('M2D repair: refusal receipts for every clearance-refusal reason (independent review found none did)', () => {
    const baseFields = {
      reason: 'attempted self-grant',
      approvedBy: 'the-calling-code-itself',
      permittedClass: IDENTITY_UNBOUNDED_AGENTIC,
    };
    const agenticTables = {
      availability: DEFAULT_ROUTE_AVAILABILITY,
      providerClasses: { 'agentic-1': IDENTITY_UNBOUNDED_AGENTIC },
    };

    /** Shared assertion: the rejected promise's error carries a receipt built by the same assertCostRouterReceipt as the success path, with blocker/nextAction non-empty and blocker naming the reason. */
    async function assertClearanceRefusalReceipt(
      promise: Promise<unknown>,
      reason: string,
    ): Promise<void> {
      try {
        await promise;
        throw new Error(`expected refusal ${reason}`);
      } catch (error) {
        expect(error).toMatchObject({ reason });
        const receipt = (error as { receipt?: unknown }).receipt;
        expect(receipt).toBeDefined();
        expect(() =>
          assertCostRouterReceipt(receipt as Parameters<typeof assertCostRouterReceipt>[0]),
        ).not.toThrow();
        const r = receipt as { blocker: string; nextAction: string };
        expect(r.blocker).toBeTruthy();
        expect(r.nextAction).toBeTruthy();
        expect(r.blocker).toContain(reason);
      }
    }

    it('destination_class_too_weak carries a fully populated receipt', async () => {
      const goalId = 'goal-clearance-receipt-too-weak';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-receipt-too-weak', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });

      await assertClearanceRefusalReceipt(
        withTrustedTables(
          { availability: DEFAULT_ROUTE_AVAILABILITY, providerClasses: { 'weak-1': IDENTITY_SESSION } },
          () =>
            runTrustedRoutedAttempt({
              route,
              goalId,
              taskId: 'task-receipt-too-weak',
              now: NOW,
              currentProvider: { providerId: 'weak-1', tier: 'cheap' },
              attempt,
              options: { rootDir },
              briefClearance: KEYED_SERVICE,
            }),
        ),
        'destination_class_too_weak',
      );
      expect(attempt).not.toHaveBeenCalled();
    });

    it('exception_unsigned carries a fully populated receipt', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-receipt-unsigned';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-receipt-unsigned', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const unsigned: ClearanceException = { ...baseFields };

      await assertClearanceRefusalReceipt(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-receipt-unsigned',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: unsigned,
          }),
        ),
        'exception_unsigned',
      );
      expect(attempt).not.toHaveBeenCalled();
    });

    it('exception_signature_mismatch carries a fully populated receipt', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-receipt-mismatch';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-receipt-mismatch', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const signed = signClearanceException(baseFields, 'test-fake-signing-key-not-real');
      const tampered: ClearanceException = { ...signed, approvedBy: 'a-different-approver' };

      await assertClearanceRefusalReceipt(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-receipt-mismatch',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: tampered,
          }),
        ),
        'exception_signature_mismatch',
      );
      expect(attempt).not.toHaveBeenCalled();
    });

    it('exception_signature_replayed carries a fully populated receipt', async () => {
      vi.stubEnv('ATLAS_CLEARANCE_SIGNING_KEY', 'test-fake-signing-key-not-real');
      const goalId = 'goal-clearance-receipt-replay';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const signed = signClearanceException(baseFields, 'test-fake-signing-key-not-real');

      const routeFirst = resolveRoute({ taskId: 'task-receipt-replay-1', needsLocalWorker: true });
      const first = await withTrustedTables(agenticTables, () =>
        runTrustedRoutedAttempt({
          route: routeFirst,
          goalId,
          taskId: 'task-receipt-replay-1',
          now: NOW,
          currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
          attempt,
          options: { rootDir },
          briefClearance: KEYED_SERVICE,
          clearanceException: signed,
        }),
      );
      expect(first.status).toBe('succeeded');

      const routeSecond = resolveRoute({ taskId: 'task-receipt-replay-2', needsLocalWorker: true });
      await assertClearanceRefusalReceipt(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route: routeSecond,
            goalId,
            taskId: 'task-receipt-replay-2',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: signed,
          }),
        ),
        'exception_signature_replayed',
      );
    });

    it('exception_signing_key_not_configured carries a fully populated receipt', async () => {
      const goalId = 'goal-clearance-receipt-nokey';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-receipt-nokey', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: true });
      const unverifiable: ClearanceException = {
        ...baseFields,
        sig: 'deadbeef',
        ts: NOW,
        nonce: 'nonce-receipt-nokey-1',
      };

      await assertClearanceRefusalReceipt(
        withTrustedTables(agenticTables, () =>
          runTrustedRoutedAttempt({
            route,
            goalId,
            taskId: 'task-receipt-nokey',
            now: NOW,
            currentProvider: { providerId: 'agentic-1', tier: 'cheap' },
            attempt,
            options: { rootDir },
            briefClearance: KEYED_SERVICE,
            clearanceException: unverifiable,
          }),
        ),
        'exception_signing_key_not_configured',
      );
      expect(attempt).not.toHaveBeenCalled();
    });
  });

  describe('M2C repair, third refutation: the injectable-table entry point no longer exists on the public module', () => {
    it('exports no runRoutedAttempt from cost-router-classify.ts', async () => {
      const moduleExports: Record<string, unknown> = await import('../atlas/cost-router-classify.js');
      expect(Object.keys(moduleExports)).not.toContain('runRoutedAttempt');
    });

    it('refuses the previously-successful forged-availability attack (which entered disabled route T1) even with VITEST=true and a cast that smuggles an availability field onto the trusted params', async () => {
      const goalId = 'goal-testonly-seam';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const forgedAvailability = { T0: true, T1: true, T2: true, T3: true };
      // Minting against the forged table only proves resolveRoute is pure
      // and does what it's told; the question is whether that forgery can
      // reach the tables runTrustedRoutedAttempt actually enforces with.
      const route = resolveRoute({ taskId: 'task-testonly-seam-1', needsWebResearch: true }, forgedAvailability);
      const attempt = vi.fn().mockReturnValue({ ok: true });

      const priorVitestFlag = process.env['VITEST'];
      // Set the exact flag the earlier (now-removed) repair trusted, to
      // prove the fix does not depend on this variable one way or another.
      process.env['VITEST'] = 'true';
      try {
        const smuggled = {
          route,
          goalId,
          taskId: 'task-testonly-seam-1',
          now: NOW,
          currentProvider: { providerId: 'sneaky-1', tier: 'free' as const },
          attempt,
          options: { rootDir },
          briefClearance: KEYED_SERVICE,
          // TrustedRoutedAttemptParams declares no `availability` field;
          // only a cast can attach one, and runTrustedRoutedAttempt never
          // reads an unknown property off its params object.
          availability: forgedAvailability,
        } as unknown as TrustedRoutedAttemptParams;

        await expect(runTrustedRoutedAttempt(smuggled)).rejects.toMatchObject({ reason: 'route_disabled' });
      } finally {
        if (priorVitestFlag === undefined) {
          delete process.env['VITEST'];
        } else {
          process.env['VITEST'] = priorVitestFlag;
        }
      }
      expect(attempt).not.toHaveBeenCalled();
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
        // TrustedRoutedAttemptParams declares no such fields; this proves
        // the parameter is simply not reachable through the supported
        // entry point.
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
});
