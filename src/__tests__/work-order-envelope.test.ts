/**
 * work-order-envelope.test.ts — P1-A wave 1 signed Work Order envelope.
 *
 * ALL via injected fakes — zero network, zero real credentials, temp dirs
 * for the durable replay store. TEST_KEY below is an obviously-fake string,
 * never a real secret.
 */

import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hmacSigner,
  hmacVerifier,
  signWorkOrder,
  validateWorkOrder,
  createWorkOrderReplayStore,
  CLOCK_SKEW_TOLERANCE_MS,
  type WorkOrder,
  type WorkOrderReplayStore,
  type WorkOrderValidationContext,
} from '../atlas/work-order/index.js';

// Obviously-fake test key — never a real secret.
const TEST_KEY = 'test-fake-work-order-key-not-real-do-not-use';
const signer = hmacSigner(TEST_KEY);
const verifier = hmacVerifier(TEST_KEY);

function baseOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  const now = Date.now();
  return {
    workOrderId: 'wo_test-default',
    goalId: 'goal-p1a-wave1',
    taskId: 'task-work-order-envelope',
    issuerIdentity: 'atlas-planner',
    executorIdentity: 'atlas-executor',
    repoCanonicalPath: 'C:/repo/ANUS',
    baseBranch: 'codex/atlas-cost-router-design',
    baseHead: '9df07c4',
    worktreePath: 'C:/repo/ANUS/.worktrees/p1a-work-orders',
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    nonce: 'nonce-test-default',
    allowedPaths: ['src/atlas/work-order/**'],
    forbiddenPaths: ['**/*.env'],
    forbiddenActions: ['force-push'],
    allowedCommandClasses: ['git', 'vitest'],
    maxAttempts: 2,
    maxWallClockMs: 20 * 60 * 1000,
    expectedTests: ['src/__tests__/work-order-envelope.test.ts'],
    evidenceRequirements: ['exit-code'],
    rollbackMethod: 'git worktree remove',
    ...overrides,
  };
}

describe('work-order envelope (P1-A wave 1)', () => {
  let tempDir: string;
  let store: WorkOrderReplayStore;
  let priorSigningKey: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'work-order-envelope-test-'));
    store = createWorkOrderReplayStore(tempDir);
    priorSigningKey = process.env['ATLAS_WORK_ORDER_SIGNING_KEY'];
    delete process.env['ATLAS_WORK_ORDER_SIGNING_KEY'];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (priorSigningKey === undefined) delete process.env['ATLAS_WORK_ORDER_SIGNING_KEY'];
    else process.env['ATLAS_WORK_ORDER_SIGNING_KEY'] = priorSigningKey;
  });

  function baseCtx(overrides: Partial<WorkOrderValidationContext> = {}): WorkOrderValidationContext {
    return {
      verifier,
      replayStore: store,
      executorIdentity: 'atlas-executor',
      repoCanonicalPath: 'C:/repo/ANUS',
      baseHead: '9df07c4',
      attemptNumber: 1,
      elapsedWallClockMs: 1000,
      ...overrides,
    };
  }

  it('1. a validly signed order passes validation', () => {
    const signed = signWorkOrder(baseOrder(), signer);
    const result = validateWorkOrder(signed, baseCtx());
    expect(result).toEqual({ ok: true });
  });

  it('2. an order with no integrity block is rejected as signature_missing', () => {
    const signed = signWorkOrder(baseOrder(), signer);
    const unsigned = JSON.parse(JSON.stringify(signed));
    delete unsigned.integrity;
    const result = validateWorkOrder(unsigned, baseCtx());
    expect(result).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('3. altering a field after signing is rejected as signature_invalid', () => {
    const signed = signWorkOrder(baseOrder(), signer);
    const tampered = JSON.parse(JSON.stringify(signed));
    tampered.taskId = 'task-attacker-controlled';
    const result = validateWorkOrder(tampered, baseCtx());
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('4. an expired order is rejected', () => {
    const now = Date.now();
    const order = baseOrder({
      issuedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    const signed = signWorkOrder(order, signer);
    const result = validateWorkOrder(signed, baseCtx());
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('5. an order issued far in the future beyond clock tolerance is rejected', () => {
    const now = Date.now();
    const order = baseOrder({
      issuedAt: new Date(now + CLOCK_SKEW_TOLERANCE_MS + 60 * 1000).toISOString(),
      expiresAt: new Date(now + CLOCK_SKEW_TOLERANCE_MS + 2 * 60 * 60 * 1000).toISOString(),
    });
    const signed = signWorkOrder(order, signer);
    const result = validateWorkOrder(signed, baseCtx());
    expect(result).toEqual({ ok: false, reason: 'future_dated' });
  });

  it('6. a replayed nonce is rejected on the second claim', () => {
    const first = signWorkOrder(
      baseOrder({ workOrderId: 'wo_replay-nonce-1', nonce: 'nonce-fixed-a' }),
      signer,
    );
    expect(validateWorkOrder(first, baseCtx())).toEqual({ ok: true });

    const second = signWorkOrder(
      baseOrder({ workOrderId: 'wo_replay-nonce-2', nonce: 'nonce-fixed-a' }),
      signer,
    );
    const result = validateWorkOrder(second, baseCtx());
    expect(result).toEqual({ ok: false, reason: 'nonce_replayed' });
  });

  it('7. a replayed workOrderId is rejected on the second claim', () => {
    const first = signWorkOrder(
      baseOrder({ workOrderId: 'wo_replay-id-1', nonce: 'nonce-fixed-b1' }),
      signer,
    );
    expect(validateWorkOrder(first, baseCtx())).toEqual({ ok: true });

    const second = signWorkOrder(
      baseOrder({ workOrderId: 'wo_replay-id-1', nonce: 'nonce-fixed-b2' }),
      signer,
    );
    const result = validateWorkOrder(second, baseCtx());
    expect(result).toEqual({ ok: false, reason: 'work_order_id_replayed' });
  });

  it('8. replay rejection survives a simulated process restart', () => {
    const restartDir = mkdtempSync(join(tmpdir(), 'work-order-replay-restart-'));
    try {
      // "Boot 1": fresh store instance, claim the order.
      const store1 = createWorkOrderReplayStore(restartDir);
      const first = signWorkOrder(
        baseOrder({ workOrderId: 'wo_restart-1', nonce: 'nonce-restart-1' }),
        signer,
      );
      expect(validateWorkOrder(first, baseCtx({ replayStore: store1 }))).toEqual({ ok: true });

      // "Boot 2": a brand-new store instance reading the SAME directory —
      // no shared in-memory state with store1.
      const store2 = createWorkOrderReplayStore(restartDir);
      const second = signWorkOrder(
        baseOrder({ workOrderId: 'wo_restart-2', nonce: 'nonce-restart-1' }),
        signer,
      );
      const result = validateWorkOrder(second, baseCtx({ replayStore: store2 }));
      expect(result).toEqual({ ok: false, reason: 'nonce_replayed' });
    } finally {
      rmSync(restartDir, { recursive: true, force: true });
    }
  });

  it('9. wrong executor identity is rejected', () => {
    const signed = signWorkOrder(baseOrder({ executorIdentity: 'atlas-executor' }), signer);
    const result = validateWorkOrder(signed, baseCtx({ executorIdentity: 'someone-else' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_executor_identity' });
  });

  it('10. wrong repository is rejected', () => {
    const signed = signWorkOrder(baseOrder({ repoCanonicalPath: 'C:/repo/ANUS' }), signer);
    const result = validateWorkOrder(signed, baseCtx({ repoCanonicalPath: 'C:/repo/other' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_repository' });
  });

  it('11. a base HEAD mismatch is rejected', () => {
    const signed = signWorkOrder(baseOrder({ baseHead: '9df07c4' }), signer);
    const result = validateWorkOrder(signed, baseCtx({ baseHead: 'deadbeef' }));
    expect(result).toEqual({ ok: false, reason: 'base_head_mismatch' });
  });

  it('12. a path outside allowedPaths is rejected', () => {
    const signed = signWorkOrder(
      baseOrder({ allowedPaths: ['src/atlas/work-order/**'] }),
      signer,
    );
    const result = validateWorkOrder(signed, baseCtx({ candidatePath: 'src/telegram.ts' }));
    expect(result).toEqual({ ok: false, reason: 'path_out_of_scope' });
  });

  it('13. a path inside forbiddenPaths is rejected even when otherwise in scope', () => {
    const signed = signWorkOrder(
      baseOrder({
        allowedPaths: ['src/atlas/work-order/**'],
        forbiddenPaths: ['src/atlas/work-order/secret.local.ts'],
      }),
      signer,
    );
    const result = validateWorkOrder(
      signed,
      baseCtx({ candidatePath: 'src/atlas/work-order/secret.local.ts' }),
    );
    expect(result).toEqual({ ok: false, reason: 'path_forbidden' });
  });

  it('14. a forbidden command class is rejected', () => {
    const signed = signWorkOrder(
      baseOrder({ allowedCommandClasses: ['git', 'vitest'] }),
      signer,
    );
    const result = validateWorkOrder(signed, baseCtx({ commandClass: 'npm-publish' }));
    expect(result).toEqual({ ok: false, reason: 'command_class_forbidden' });
  });

  it('15. attempts exhaustion and wall-clock exhaustion are each rejected', () => {
    const attemptsOrder = signWorkOrder(
      baseOrder({
        workOrderId: 'wo_exhaustion-attempts',
        nonce: 'nonce-exhaustion-attempts',
        maxAttempts: 2,
        maxWallClockMs: 5000,
      }),
      signer,
    );
    const attemptsResult = validateWorkOrder(
      attemptsOrder,
      baseCtx({ attemptNumber: 3, elapsedWallClockMs: 100 }),
    );
    expect(attemptsResult).toEqual({ ok: false, reason: 'attempts_exhausted' });

    const wallClockOrder = signWorkOrder(
      baseOrder({
        workOrderId: 'wo_exhaustion-wallclock',
        nonce: 'nonce-exhaustion-wallclock',
        maxAttempts: 2,
        maxWallClockMs: 5000,
      }),
      signer,
    );
    const wallClockResult = validateWorkOrder(
      wallClockOrder,
      baseCtx({ attemptNumber: 1, elapsedWallClockMs: 6000 }),
    );
    expect(wallClockResult).toEqual({ ok: false, reason: 'wall_clock_exhausted' });
  });

  it('16. verification fails closed when no signing material is available', () => {
    // Signed via the injected test signer (never touches env). Validated
    // with no explicit verifier AND no ATLAS_WORK_ORDER_SIGNING_KEY set —
    // resolveWorkOrderVerifier() must resolve to undefined, and the
    // signature check must therefore return a closed verdict, never "ok".
    const signed = signWorkOrder(baseOrder(), signer);
    const result = validateWorkOrder(signed, baseCtx({ verifier: undefined }));
    expect(result).toEqual({ ok: false, reason: 'signature_missing' });
  });

  it('17. no signing material appears in any produced receipt or error message', () => {
    let thrown: unknown;
    try {
      signWorkOrder(baseOrder(), undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).not.toContain(TEST_KEY);
    expect(String((thrown as Error).stack)).not.toContain(TEST_KEY);

    const signed = signWorkOrder(baseOrder(), signer);
    const serializedEnvelope = JSON.stringify(signed);
    expect(serializedEnvelope).not.toContain(TEST_KEY);

    const tampered = JSON.parse(serializedEnvelope);
    tampered.taskId = 'attacker-controlled';
    const verdict = validateWorkOrder(tampered, baseCtx());
    expect(JSON.stringify(verdict)).not.toContain(TEST_KEY);
  });

  it('18. the signed envelope is immutable — mutation attempt is type-prevented or detected', () => {
    const order = baseOrder();
    const signed = signWorkOrder(order, signer);
    expect(Object.isFrozen(signed)).toBe(true);

    let threw = false;
    try {
      (signed as { taskId: string }).taskId = 'mutated-after-signing';
    } catch {
      threw = true;
    }
    // ESM modules run in strict mode, so assigning to a frozen property
    // throws — but this also holds even if some future runtime silently
    // no-ops the assignment: the value must be provably unchanged either way.
    expect(threw || signed.taskId === order.taskId).toBe(true);
    expect(signed.taskId).toBe(order.taskId);
  });
});
