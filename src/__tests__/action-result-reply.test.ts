/**
 * action-result-reply.test.ts — tests for actionResultToReply() pure helper.
 *
 * Verifies the three ActionRouterResult kinds produce the expected Russian
 * CEO-facing reply (or null for chat fallthrough). No live bot, no network.
 *
 * Also tests the classifyIntent → actionResultToReply branching: action-classified
 * messages produce a reply string, chat-classified messages get null (fall through).
 */

import { describe, it, expect } from 'vitest';
import {
  actionResultToReply,
  classifyIntent,
  type ActionRouterResult,
} from '../atlas/action-router.js';

// ── actionResultToReply ────────────────────────────────────────────────

describe('actionResultToReply', () => {
  it('returns null for kind:chat (fall through to brain reply)', () => {
    const result: ActionRouterResult = { kind: 'chat' };
    expect(actionResultToReply(result)).toBeNull();
  });

  it('returns a Russian reply for kind:queued with summary and taskId', () => {
    const result: ActionRouterResult = {
      kind: 'queued',
      taskId: 'tsk_abc123',
      goalId: 'gol_xyz',
      summary: 'собрать отчёт по продажам',
    };
    const reply = actionResultToReply(result);
    expect(reply).not.toBeNull();
    expect(reply).toContain('Принял');
    expect(reply).toContain('собрать отчёт по продажам');
    expect(reply).toContain('tsk_abc123');
    expect(reply).toContain('конвейер');
  });

  it('returns a Russian reply for kind:needs-approval with reason', () => {
    const result: ActionRouterResult = {
      kind: 'needs-approval',
      reason: 'money transfer detected',
    };
    const reply = actionResultToReply(result);
    expect(reply).not.toBeNull();
    expect(reply).toContain('явного');
    expect(reply).toContain('money transfer detected');
    expect(reply).toContain('Без подтверждения не делаю');
  });

  it('queued reply without goalId still works', () => {
    const result: ActionRouterResult = {
      kind: 'queued',
      taskId: 'tsk_noid',
      summary: 'run linter',
    };
    const reply = actionResultToReply(result);
    expect(reply).not.toBeNull();
    expect(reply).toContain('tsk_noid');
    expect(reply).toContain('run linter');
  });
});

// ── classifyIntent → actionResultToReply branching ─────────────────────
//
// This verifies the routing logic WITHOUT a live bot: action-classified
// messages would produce a non-null reply (short-circuit), chat-classified
// messages produce null (fall through to brain). The actual ask() wiring
// is additive — it calls classifyIntent, then routeFreeformAction, then
// actionResultToReply. Since ask() is not cleanly unit-testable (it boots
// a live Telegraf), we test the pure pipeline here.

describe('classifyIntent → actionResultToReply branching', () => {
  it('action message + queued result → non-null reply (short-circuit)', () => {
    const intent = classifyIntent('сделай отчёт');
    expect(intent).toBe('action');
    // Simulate what ask() does: if action, call routeFreeformAction → get result → reply
    const result: ActionRouterResult = {
      kind: 'queued',
      taskId: 'tsk_sim',
      summary: 'сделай отчёт',
    };
    expect(actionResultToReply(result)).not.toBeNull();
  });

  it('action message + chat result → null reply (fall through)', () => {
    const intent = classifyIntent('run tests');
    expect(intent).toBe('action');
    // If router returns chat (e.g. internal re-classification), fall through
    const result: ActionRouterResult = { kind: 'chat' };
    expect(actionResultToReply(result)).toBeNull();
  });

  it('chat message → classifyIntent returns chat, router never called', () => {
    const intent = classifyIntent('привет, как дела?');
    expect(intent).toBe('chat');
    // In ask(), when intent is 'chat', routeFreeformAction is never called,
    // so actionResultToReply is never called → normal brain reply path.
  });

  it('action message + needs-approval → non-null reply (short-circuit)', () => {
    const intent = classifyIntent('удали все файлы');
    expect(intent).toBe('action');
    const result: ActionRouterResult = {
      kind: 'needs-approval',
      reason: 'deletion detected',
    };
    const reply = actionResultToReply(result);
    expect(reply).not.toBeNull();
    expect(reply).toContain('deletion detected');
  });
});
