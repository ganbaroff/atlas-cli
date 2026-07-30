import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireT3RouteOwner,
  checkRouteAvailability,
  classifyRoute,
  DEFAULT_ROUTE_AVAILABILITY,
  resolveRoute,
  RouteRefusalError,
  T3_TRIGGERS,
  type RouteAvailability,
  type RouteTaskInput,
} from '../atlas/cost-router-classify.js';
import { assertCostRouterReceipt, createGoalRouterRecord, loadGoalRouterRecord } from '../atlas/cost-router-state.js';

const NOW = '2026-07-30T00:00:00.000Z';
const EXPIRES = '2026-07-30T00:30:00.000Z';
const LATER_EXPIRES = '2026-07-30T01:00:00.000Z';

describe('atlas/cost-router-classify', () => {
  let sandboxDir: string;
  let rootDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-cost-router-classify-'));
    rootDir = join(sandboxDir, 'cost-router');
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  describe('determinism and model-free classification', () => {
    it('classifies the same input to the same route on repeat calls with zero provider calls', () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => {
          throw new Error('classifyRoute must never perform network/provider I/O');
        });

      const task: RouteTaskInput = { taskId: 'task-t0-1', deterministicTool: 'grep' };

      const first = classifyRoute(task);
      const second = classifyRoute(task);

      expect(first).toEqual({ route: 'T0', predicate: 't0-deterministic-tool-named' });
      expect(second).toEqual(first);
      expect(fetchSpy).not.toHaveBeenCalled();

      fetchSpy.mockRestore();
    });

    it('routes T1/T2 tasks to their predicate without any provider call', () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => {
          throw new Error('classifyRoute must never perform network/provider I/O');
        });

      expect(
        classifyRoute({ taskId: 'task-t1-1', needsWebResearch: true })
      ).toEqual({ route: 'T1', predicate: 't1-sanitized-web-research-only' });

      expect(
        classifyRoute({ taskId: 'task-t2-1', needsLocalWorker: true })
      ).toEqual({ route: 'T2', predicate: 't2-bounded-local-worker' });

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('refuses unclassifiable input rather than defaulting to any route', () => {
      const task: RouteTaskInput = { taskId: 'task-unclassifiable-1' };

      expect(() => classifyRoute(task)).toThrow(
        expect.objectContaining({ reason: 'unclassifiable' })
      );
      try {
        classifyRoute(task);
        throw new Error('expected classifyRoute to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(RouteRefusalError);
        expect((error as RouteRefusalError).route).toBeUndefined();
      }
    });
  });

  describe('mandatory objective T3 triggers', () => {
    it('refuses T3 with no trigger, naming the reason', () => {
      const task: RouteTaskInput = { taskId: 'task-t3-no-trigger', needsPremiumReasoning: true };

      expect(() => classifyRoute(task)).toThrow(
        expect.objectContaining({ reason: 't3_trigger_missing', route: 'T3' })
      );
    });

    it.each(T3_TRIGGERS)('allows T3 with the %s trigger and records it on the match', (trigger) => {
      const task: RouteTaskInput = {
        taskId: `task-t3-${trigger}`,
        needsPremiumReasoning: true,
        trigger,
      };

      expect(classifyRoute(task)).toEqual({
        route: 'T3',
        predicate: 't3-premium-reasoning-requested',
        trigger,
      });
    });
  });

  describe('escalation cap: one per task on the M1 durable record', () => {
    it('allows the first T3 escalation and refuses the second for the same task', async () => {
      const goalId = 'goal-classify-escalation';
      await createGoalRouterRecord(goalId, NOW, { rootDir });

      const task: RouteTaskInput = {
        taskId: 'task-escalate-1',
        needsPremiumReasoning: true,
        trigger: 'architecture',
      };
      const ownerMeta = {
        phaseId: 'phase-escalate-1',
        seat: 'codex-sol' as const,
        acquiredAt: NOW,
        expiresAt: EXPIRES,
      };

      const first = await acquireT3RouteOwner(goalId, task, ownerMeta, NOW, undefined, { rootDir });
      expect(first.match.trigger).toBe('architecture');
      expect(first.record.activePremiumOwner).toMatchObject({
        taskId: 'task-escalate-1',
        trigger: 'architecture',
      });

      const coldRead = loadGoalRouterRecord(goalId, { rootDir });
      expect(coldRead.activePremiumOwner?.trigger).toBe('architecture');

      // Release the only active owner slot so the SAME task can attempt a
      // second escalation and be refused by its own already-consumed ledger
      // entry (task_escalation_exhausted), not by the "active owner" guard.
      const { releasePremiumOwner } = await import('../atlas/cost-router-state.js');
      await releasePremiumOwner(goalId, 'phase-escalate-1', EXPIRES, { rootDir });

      await expect(
        acquireT3RouteOwner(
          goalId,
          task,
          { ...ownerMeta, phaseId: 'phase-escalate-2', acquiredAt: EXPIRES, expiresAt: LATER_EXPIRES },
          EXPIRES,
          undefined,
          { rootDir }
        )
      ).rejects.toMatchObject({ code: 'task_escalation_exhausted' });
    });
  });

  describe('unavailable route refuses rather than downgrades', () => {
    it('refuses a disabled route with a named blocker and never invokes a local model instead', () => {
      const localModelInvoke = vi.fn();
      const task: RouteTaskInput = { taskId: 'task-research-disabled', needsWebResearch: true };

      expect(() => resolveRoute(task, DEFAULT_ROUTE_AVAILABILITY)).toThrow(
        expect.objectContaining({ reason: 'route_disabled', route: 'T1' })
      );
      expect(localModelInvoke).not.toHaveBeenCalled();
    });

    it('checkRouteAvailability names the blocker independently of classification', () => {
      const availability: RouteAvailability = { ...DEFAULT_ROUTE_AVAILABILITY, T2: false };

      expect(() => checkRouteAvailability('T2', availability)).toThrow(
        expect.objectContaining({ reason: 'route_disabled', route: 'T2' })
      );
      expect(() => checkRouteAvailability('T0', availability)).not.toThrow();
    });
  });

  describe('M2D repair: every refusal carries a receipt (independent review found none did)', () => {
    it('RouteRefusalError rejects an invalid receipt at runtime, even when a caller bypasses TypeScript', () => {
      expect(
        () =>
          new RouteRefusalError(
            'unclassifiable',
            undefined,
            'runtime invariant probe',
            undefined as never,
          ),
      ).toThrow(expect.objectContaining({ code: 'cost_router_receipt_invalid' }));
    });

    /** Shared assertion for every refusal-class test below. */
    function assertRefusalReceipt(error: unknown, reason: string): void {
      expect(error).toBeInstanceOf(Error);
      const receipt = (error as { receipt?: unknown }).receipt;
      expect(receipt).toBeDefined();
      // Built and validated by the SAME assertCostRouterReceipt used on the
      // success path — no second, laxer builder.
      expect(() => assertCostRouterReceipt(receipt as Parameters<typeof assertCostRouterReceipt>[0])).not.toThrow();
      const r = receipt as { blocker: string; nextAction: string };
      expect(r.blocker).toBeTruthy();
      expect(r.nextAction).toBeTruthy();
      expect(r.blocker).toContain(reason);
    }

    it('route_disabled (checkRouteAvailability) carries a fully populated receipt', () => {
      const availability: RouteAvailability = { ...DEFAULT_ROUTE_AVAILABILITY, T2: false };
      try {
        checkRouteAvailability('T2', availability);
        throw new Error('expected checkRouteAvailability to throw');
      } catch (error) {
        assertRefusalReceipt(error, 'route_disabled');
      }
    });

    it('unclassifiable (classifyRoute) carries a fully populated receipt with NOT_APPLICABLE for fields that cannot apply before a route is resolved', () => {
      try {
        classifyRoute({ taskId: 'task-unclassifiable-receipt' });
        throw new Error('expected classifyRoute to throw');
      } catch (error) {
        assertRefusalReceipt(error, 'unclassifiable');
        const receipt = (error as { receipt: { provider: unknown; sources: unknown } }).receipt;
        expect(receipt.provider).toBe('not-applicable');
        expect(receipt.sources).toBe('not-applicable');
      }
    });

    it('t3_trigger_missing (classifyRoute) carries a fully populated receipt', () => {
      try {
        classifyRoute({ taskId: 'task-t3-trigger-missing-receipt', needsPremiumReasoning: true });
        throw new Error('expected classifyRoute to throw');
      } catch (error) {
        assertRefusalReceipt(error, 't3_trigger_missing');
        const receipt = (error as { receipt: { provider: unknown; sources: unknown } }).receipt;
        expect(receipt.provider).toBe('not-applicable');
        expect(receipt.sources).toBe('not-applicable');
      }
    });
  });
});
