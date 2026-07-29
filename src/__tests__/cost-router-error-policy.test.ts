import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyFailure,
  DEFAULT_ROUTE_AVAILABILITY,
  resolveRoute,
  runTrustedRoutedAttempt,
  selectFailoverProvider,
  type AvailableRoute,
  type ProviderAttemptResult,
  type ProviderCandidate,
  type ProviderClass,
  type RouteAvailability,
} from '../atlas/cost-router-classify.js';
import { withTrustedTables } from '../atlas/cost-router-test-seam.js';
import { createGoalRouterRecord } from '../atlas/cost-router-state.js';

const NOW = '2026-07-30T00:00:00.000Z';

/**
 * Every gate in this file is about availability/error-bucket/retry
 * behaviour, never clearance — so every provider used here gets the
 * identical, strongest-possible declared class. `isWeakerClass` is then
 * always false between any two of them, which keeps the M2C clearance gate
 * a no-op throughout and lets each test isolate the one gate it names.
 */
const STRONG_CLASS: ProviderClass = Object.freeze({
  identityBearing: false,
  retentionTerm: 'none',
  canActBeyondBrief: false,
});

function trustedTables(
  providerIds: readonly string[],
  availability: RouteAvailability = DEFAULT_ROUTE_AVAILABILITY,
): { availability: RouteAvailability; providerClasses: Record<string, ProviderClass> } {
  const providerClasses: Record<string, ProviderClass> = {};
  for (const id of providerIds) providerClasses[id] = STRONG_CLASS;
  return { availability, providerClasses };
}

describe('atlas/cost-router-classify: M2B error buckets and availability enforcement', () => {
  let sandboxDir: string;
  let rootDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-cost-router-error-policy-'));
    rootDir = join(sandboxDir, 'cost-router');
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  describe('classifyFailure: pure bucketing', () => {
    it('buckets a policy/permission/seat/capability refusal as denial', () => {
      expect(classifyFailure({ isDenial: true })).toBe('denial');
    });

    it('buckets an unmatched failure as unknown, not transport', () => {
      expect(classifyFailure({})).toBe('unknown');
    });
  });

  describe('injected denial', () => {
    it('makes exactly one attempt with zero retries and buckets as denial', async () => {
      const goalId = 'goal-denial';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-denial-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: false, failure: { isDenial: true } });

      const result = await withTrustedTables(trustedTables(['p1']), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-denial-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      );

      expect(result.status).toBe('failed');
      expect(result.bucket).toBe('denial');
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(result.providerCalls).toBe(1);
    });
  });

  describe('injected transport failure', () => {
    it('retries the same provider once, then fails over to exactly one non-premium provider', async () => {
      const goalId = 'goal-transport';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-transport-1', needsLocalWorker: true });

      const attempt = vi.fn((provider: ProviderCandidate): ProviderAttemptResult => {
        if (provider.providerId === 'p1') {
          return { ok: false, failure: { isTransportFailure: true } };
        }
        return { ok: true };
      });

      const result = await withTrustedTables(trustedTables(['p1', 'cheap-1']), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-transport-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          failoverCandidates: [
            { providerId: 'premium-1', tier: 'premium' },
            { providerId: 'cheap-1', tier: 'cheap' },
          ],
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(result.callsByProvider).toEqual({ p1: 2, 'cheap-1': 1 });
      expect(result.finalProviderId).toBe('cheap-1');
      expect(result.callsByProvider['premium-1']).toBeUndefined();
    });
  });

  describe('injected unknown/unclassified error', () => {
    it('treats unknown exactly as denial: one attempt, zero retries, never transport', async () => {
      const goalId = 'goal-unknown';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-unknown-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: false, failure: {} });

      const result = await withTrustedTables(trustedTables(['p1', 'cheap-1']), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-unknown-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          failoverCandidates: [{ providerId: 'cheap-1', tier: 'cheap' }],
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      );

      expect(result.bucket).toBe('unknown');
      expect(result.status).toBe('failed');
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(result.callsByProvider['cheap-1']).toBeUndefined();
    });
  });

  describe('expired async handle', () => {
    it('resolves failed with zero provider calls', async () => {
      const route = resolveRoute({ taskId: 'task-async-1', needsLocalWorker: true });
      const attempt = vi.fn();

      const result = await runTrustedRoutedAttempt({
        route,
        goalId: 'goal-async-unused',
        taskId: 'task-async-1',
        now: NOW,
        currentProvider: { providerId: 'p1', tier: 'free' },
        isAsyncExpired: true,
        attempt,
        briefClearance: STRONG_CLASS,
      });

      expect(result.status).toBe('failed');
      expect(result.bucket).toBe('async-expired');
      expect(result.providerCalls).toBe(0);
      expect(attempt).not.toHaveBeenCalled();
    });
  });

  describe('no automatic premium fallback', () => {
    it('refuses failover rather than taking a premium-only candidate', async () => {
      const goalId = 'goal-premium-only';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-premium-only-1', needsLocalWorker: true });
      const attempt = vi.fn().mockReturnValue({ ok: false, failure: { isTransportFailure: true } });

      const result = await withTrustedTables(trustedTables(['p1']), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-premium-only-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          failoverCandidates: [{ providerId: 'premium-1', tier: 'premium' }],
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      );

      expect(result.status).toBe('failed');
      expect(result.bucket).toBe('transport');
      expect(attempt).toHaveBeenCalledTimes(2);
      expect(result.callsByProvider['premium-1']).toBeUndefined();
      expect(selectFailoverProvider([{ providerId: 'premium-1', tier: 'premium' }])).toBeUndefined();
    });
  });

  describe('unreachable unsafe path', () => {
    it('refuses to spend a provider attempt on a route that skipped the availability check', async () => {
      const forged = { route: 'T2', predicate: 'forged' } as unknown as AvailableRoute;
      const attempt = vi.fn();

      await expect(
        runTrustedRoutedAttempt({
          route: forged,
          goalId: 'goal-forged',
          taskId: 'task-forged-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          attempt,
          briefClearance: STRONG_CLASS,
        }),
      ).rejects.toMatchObject({ reason: 'availability_not_checked' });

      expect(attempt).not.toHaveBeenCalled();
    });
  });

  describe('M2B repair: identity-based brand cannot be forged (independent-review finding)', () => {
    it('refuses a disabled-route (T1) match forged by spreading a real branded T0 route over it', async () => {
      const goalId = 'goal-forge-spread';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      // Mint one genuine AvailableRoute against an available route (T0).
      const realAvailable = resolveRoute({ taskId: 'task-real-t0', deterministicTool: 'echo' });
      expect(realAvailable.route).toBe('T0');

      // Reviewer's exact attack: spread the real branded object as the
      // base (carrying whatever the module attaches), then override the
      // route/predicate fields to claim T1 — disabled by default. Under
      // the old symbol-property brand this produced a passing forgery.
      const forged = {
        ...realAvailable,
        route: 'T1',
        predicate: 't1-sanitized-web-research-only',
      } as unknown as AvailableRoute;
      expect(forged.route).toBe('T1');

      const attempt = vi.fn();
      await expect(
        runTrustedRoutedAttempt({
          route: forged,
          goalId,
          taskId: 'task-forge-spread-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      ).rejects.toMatchObject({ reason: 'availability_not_checked' });

      expect(attempt).not.toHaveBeenCalled();
    });

    it('refuses the same forgery built with Object.assign instead of spread', async () => {
      const goalId = 'goal-forge-assign';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const realAvailable = resolveRoute({ taskId: 'task-real-t0-b', deterministicTool: 'echo' });

      const forged = Object.assign({}, realAvailable, {
        route: 'T1',
        predicate: 't1-sanitized-web-research-only',
      }) as unknown as AvailableRoute;
      expect(forged.route).toBe('T1');

      const attempt = vi.fn();
      await expect(
        runTrustedRoutedAttempt({
          route: forged,
          goalId,
          taskId: 'task-forge-assign-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      ).rejects.toMatchObject({ reason: 'availability_not_checked' });

      expect(attempt).not.toHaveBeenCalled();
    });

    it('refuses a structural clone (JSON round-trip) of a real branded route, even for a still-available route', async () => {
      const goalId = 'goal-clone';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const real = resolveRoute({ taskId: 'task-clone-1', deterministicTool: 'echo' });
      const cloned = JSON.parse(JSON.stringify(real)) as AvailableRoute;
      expect(cloned.route).toBe('T0');

      const attempt = vi.fn();
      await expect(
        runTrustedRoutedAttempt({
          route: cloned,
          goalId,
          taskId: 'task-clone-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      ).rejects.toMatchObject({ reason: 'availability_not_checked' });

      expect(attempt).not.toHaveBeenCalled();
    });

    it('refuses a genuinely branded route whose availability is flipped to disabled after minting (defence-in-depth #2)', async () => {
      const goalId = 'goal-flip';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const liveAvailability: RouteAvailability = { ...DEFAULT_ROUTE_AVAILABILITY };
      const real = resolveRoute({ taskId: 'task-flip-1', needsLocalWorker: true }, liveAvailability);
      expect(real.route).toBe('T2');

      // Availability changes after the token was minted (e.g. a live gate
      // trips between resolveRoute and the provider call).
      const flipped: RouteAvailability = { ...liveAvailability, T2: false };

      const attempt = vi.fn();
      await expect(
        withTrustedTables(trustedTables(['p1'], flipped), () =>
          runTrustedRoutedAttempt({
            route: real,
            goalId,
            taskId: 'task-flip-1',
            now: NOW,
            currentProvider: { providerId: 'p1', tier: 'free' },
            attempt,
            options: { rootDir },
            briefClearance: STRONG_CLASS,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'route_disabled' });

      expect(attempt).not.toHaveBeenCalled();
    });

    it('still succeeds end to end for a genuinely branded, still-available route', async () => {
      const goalId = 'goal-happy-repair';
      await createGoalRouterRecord(goalId, NOW, { rootDir });
      const route = resolveRoute({ taskId: 'task-happy-repair-1', deterministicTool: 'echo' });
      const attempt = vi.fn().mockReturnValue({ ok: true });

      const result = await withTrustedTables(trustedTables(['p1']), () =>
        runTrustedRoutedAttempt({
          route,
          goalId,
          taskId: 'task-happy-repair-1',
          now: NOW,
          currentProvider: { providerId: 'p1', tier: 'free' },
          attempt,
          options: { rootDir },
          briefClearance: STRONG_CLASS,
        }),
      );

      expect(result.status).toBe('succeeded');
      expect(attempt).toHaveBeenCalledTimes(1);
    });
  });

  describe('M2C repair, third refutation: the public module exports no injectable-table entry point', () => {
    it('does not export runRoutedAttempt, RunRoutedAttemptParams, or any equivalent injectable-table entry from cost-router-classify.ts', async () => {
      const moduleExports: Record<string, unknown> = await import('../atlas/cost-router-classify.js');
      const exportedNames = Object.keys(moduleExports);

      expect(exportedNames).not.toContain('runRoutedAttempt');
      // RunRoutedAttemptParams is a type-only export, so it can never
      // appear as a runtime key regardless of this check — the assertion
      // above is the real mechanical control. This also rules out a
      // renamed sibling reintroducing the same hole under another name.
      const suspiciousNames = exportedNames.filter((name) =>
        /injectable|withavailability|withproviderclasses|unsaferouted|routedattempt$/i.test(name) &&
        name !== 'runTrustedRoutedAttempt',
      );
      expect(suspiciousNames).toEqual([]);
    });
  });
});
