/**
 * action-router-runner-integration.test.ts — end-to-end shape compatibility
 * test: action-router enqueue → atlas-runner claim → execute → complete.
 *
 * Proves the producer (action-router) and consumer (atlas-runner) share a
 * compatible data contract WITHOUT any live Supabase/network calls.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  routeFreeformAction,
  deriveEffectsFromText,
  type ActionRouterDeps,
} from '../atlas/action-router.js';
import { runnerTick, type RunnerDeps } from '../atlas/atlas-runner.js';

describe('action-router → atlas-runner integration', () => {
  it('a queued action produces a command that atlas-runner can claim, execute, and complete', async () => {
    // ── Phase 1: action-router enqueues ──────────────────────────────────
    // Capture what the producer would write to the queue.
    let enqueuedChatId: number | undefined;
    let enqueuedCommand: string | undefined;

    const routerDeps: ActionRouterDeps = {
      intake: (text: string) => ({
        draftId: 'dft_integ',
        draft: { objective: text.trim() },
      }),
      commit: (_draftId: string) => ({
        taskId: 'tsk_integ',
        goalId: 'gol_integ',
      }),
      redLineCheck: (text: string) => {
        const effects = deriveEffectsFromText(text);
        const blocked = effects.some((e) => e.class === 'red-line');
        return blocked
          ? { blocked: true, reason: effects.map((e) => e.kind).join(', ') }
          : { blocked: false };
      },
      enqueueRemote: vi.fn().mockImplementation(async (chatId: number, command: string) => {
        enqueuedChatId = chatId;
        enqueuedCommand = command;
        return 'queue-row-id-fake';
      }),
    };

    const routerResult = await routeFreeformAction('run the linter', routerDeps, 42);
    expect(routerResult.kind).toBe('queued');
    expect(enqueuedChatId).toBe(42);
    expect(enqueuedCommand).toBe('run the linter');

    // ── Phase 2: atlas-runner claims the same command text ───────────────
    // Simulate what claimNextCommand would return for this queue row.
    const claimedRow = {
      id: 'queue-row-id-fake',
      command: enqueuedCommand!,
      payload: null,
      chat_id: enqueuedChatId!,
      priority: 0,
    };

    const completedCalls: Array<{ id: string; result: unknown }> = [];

    const runnerDeps: RunnerDeps = {
      claim: vi.fn().mockResolvedValue(claimedRow),
      complete: vi.fn().mockImplementation(async (id: string, result: unknown) => {
        completedCalls.push({ id, result });
      }),
      fail: vi.fn().mockResolvedValue(undefined),
      runLocal: vi.fn().mockResolvedValue({
        output: 'Lint passed: 0 errors, 3 warnings',
        exitCode: 0,
      }),
      isPaused: vi.fn().mockReturnValue(false),
      workerId: 'integration-test-worker',
    };

    const tickResult = await runnerTick(runnerDeps);

    // ── Phase 3: verify the shapes are compatible end-to-end ────────────
    expect(tickResult.status).toBe('completed');
    expect(tickResult).toHaveProperty('commandId', 'queue-row-id-fake');
    expect(tickResult).toHaveProperty('output', 'Lint passed: 0 errors, 3 warnings');

    // completeCommand was called with the queue row id and the output string
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0]!.id).toBe('queue-row-id-fake');
    expect(completedCalls[0]!.result).toBe('Lint passed: 0 errors, 3 warnings');

    // fail was NOT called
    expect(runnerDeps.fail).not.toHaveBeenCalled();
  });

  it('a red-line command is refused by BOTH action-router AND atlas-runner independently', async () => {
    // action-router gate
    const routerDeps: ActionRouterDeps = {
      intake: () => ({ draftId: 'x', draft: { objective: 'x' } }),
      commit: () => ({ taskId: 'x', goalId: 'x' }),
      redLineCheck: (text: string) => {
        const effects = deriveEffectsFromText(text);
        const blocked = effects.some((e) => e.class === 'red-line');
        return blocked ? { blocked: true, reason: 'red-line' } : { blocked: false };
      },
      enqueueRemote: vi.fn(),
    };

    const routerResult = await routeFreeformAction('delete all files', routerDeps, 42);
    expect(routerResult.kind).toBe('needs-approval');
    // enqueue was never called because the red-line blocked before step 3
    expect(routerDeps.enqueueRemote).not.toHaveBeenCalled();

    // atlas-runner gate (independent — defense in depth)
    const runnerDeps: RunnerDeps = {
      claim: vi.fn().mockResolvedValue({
        id: 'sneaky-row', command: 'delete all files',
        payload: null, chat_id: 42, priority: 0,
      }),
      complete: vi.fn(),
      fail: vi.fn().mockResolvedValue(undefined),
      runLocal: vi.fn(),
      isPaused: vi.fn().mockReturnValue(false),
      workerId: 'integration-test-worker',
    };

    const tickResult = await runnerTick(runnerDeps);
    expect(tickResult.status).toBe('refused');
    expect(runnerDeps.runLocal).not.toHaveBeenCalled();
    expect(runnerDeps.fail).toHaveBeenCalled();
  });
});
