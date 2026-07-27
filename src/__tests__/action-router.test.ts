/**
 * action-router.test.ts — tests for src/atlas/action-router.ts.
 *
 * Verifies:
 *   - classifyIntent: greetings → chat, action verbs → action
 *   - routeFreeformAction: chat passthrough, queued for benign actions,
 *     needs-approval for red-line requests
 *   - All deps are faked — no real exec-graph, no filesystem, no network
 */

import { describe, it, expect, vi } from 'vitest';
import {
  classifyIntent,
  routeFreeformAction,
  deriveEffectsFromText,
  type ActionRouterDeps,
} from '../atlas/action-router.js';

// ── Fake deps ───────────────────────────────────────────────────────────

function fakeDeps(overrides?: Partial<ActionRouterDeps>): ActionRouterDeps {
  return {
    intake: (text: string) => ({
      draftId: 'dft_fake123',
      draft: { objective: text.trim() },
    }),
    commit: (_draftId: string) => ({
      taskId: 'tsk_fake456',
      goalId: 'gol_fake789',
    }),
    redLineCheck: (text: string) => {
      const effects = deriveEffectsFromText(text);
      const blocked = effects.some((e) => e.class === 'red-line');
      if (blocked) {
        return {
          blocked: true,
          reason: `Red-line effects detected: ${effects.filter((e) => e.class === 'red-line').map((e) => e.kind).join(', ')}`,
        };
      }
      return { blocked: false };
    },
    ...overrides,
  };
}

// ── classifyIntent ──────────────────────────────────────────────────────

describe('classifyIntent', () => {
  it('classifies a greeting as chat', () => {
    expect(classifyIntent('привет')).toBe('chat');
    expect(classifyIntent('hello')).toBe('chat');
    expect(classifyIntent('как дела?')).toBe('chat');
    expect(classifyIntent('hey')).toBe('chat');
  });

  it('classifies Russian action verbs as action', () => {
    expect(classifyIntent('сделай отчёт')).toBe('action');
    expect(classifyIntent('открой браузер')).toBe('action');
    expect(classifyIntent('напиши код для парсера')).toBe('action');
    expect(classifyIntent('создай файл')).toBe('action');
    expect(classifyIntent('запусти тесты')).toBe('action');
  });

  it('classifies English action verbs as action', () => {
    expect(classifyIntent('run the tests')).toBe('action');
    expect(classifyIntent('build the project')).toBe('action');
    expect(classifyIntent('fix the bug in parser')).toBe('action');
    expect(classifyIntent('deploy this')).toBe('action');
    expect(classifyIntent('create a new component')).toBe('action');
  });

  it('defaults to chat for ambiguous input', () => {
    expect(classifyIntent('что думаешь?')).toBe('chat');
    expect(classifyIntent('interesting idea')).toBe('chat');
    expect(classifyIntent('')).toBe('chat');
  });

  it('action verb wins over greeting in mixed message', () => {
    expect(classifyIntent('привет, сделай отчёт')).toBe('action');
    expect(classifyIntent('hello, run the tests')).toBe('action');
  });
});

// ── deriveEffectsFromText ───────────────────────────────────────────────

describe('deriveEffectsFromText', () => {
  it('returns empty for benign text', () => {
    expect(deriveEffectsFromText('напиши код для парсера')).toEqual([]);
  });

  it('detects money-related effects', () => {
    const effects = deriveEffectsFromText('переведи деньги на счёт');
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0]!.kind).toBe('money');
    expect(effects[0]!.class).toBe('red-line');
  });

  it('detects deletion effects', () => {
    const effects = deriveEffectsFromText('удали все файлы');
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0]!.kind).toBe('deletion');
    expect(effects[0]!.class).toBe('red-line');
  });

  it('detects deploy effects', () => {
    const effects = deriveEffectsFromText('задеплой в прод');
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0]!.kind).toBe('deploy');
    expect(effects[0]!.class).toBe('red-line');
  });

  it('deduplicates same effect kind', () => {
    const effects = deriveEffectsFromText('delete all and rm -rf');
    const deletionCount = effects.filter((e) => e.kind === 'deletion').length;
    expect(deletionCount).toBe(1);
  });
});

// ── routeFreeformAction ─────────────────────────────────────────────────

describe('routeFreeformAction', () => {
  it('returns chat for a greeting', async () => {
    const result = await routeFreeformAction('привет, как дела?', fakeDeps());
    expect(result).toEqual({ kind: 'chat' });
  });

  it('returns chat for empty input', async () => {
    const result = await routeFreeformAction('', fakeDeps());
    expect(result).toEqual({ kind: 'chat' });
  });

  it('returns queued with taskId for a benign action', async () => {
    const result = await routeFreeformAction('сделай отчёт по продажам', fakeDeps());
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.taskId).toBe('tsk_fake456');
      expect(result.goalId).toBe('gol_fake789');
      expect(result.summary).toBe('сделай отчёт по продажам');
    }
  });

  it('returns queued for an English benign action', async () => {
    const result = await routeFreeformAction('run the linter', fakeDeps());
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.taskId).toBe('tsk_fake456');
    }
  });

  it('returns needs-approval for a money request', async () => {
    const result = await routeFreeformAction('переведи деньги на счёт', fakeDeps());
    expect(result.kind).toBe('needs-approval');
    if (result.kind === 'needs-approval') {
      expect(result.reason).toContain('money');
    }
  });

  it('returns needs-approval for a delete-all request', async () => {
    const result = await routeFreeformAction('удали все файлы на сервере', fakeDeps());
    expect(result.kind).toBe('needs-approval');
    if (result.kind === 'needs-approval') {
      expect(result.reason).toContain('deletion');
    }
  });

  it('returns needs-approval for a deploy-to-prod request', async () => {
    const result = await routeFreeformAction('задеплой в прод новую версию', fakeDeps());
    expect(result.kind).toBe('needs-approval');
    if (result.kind === 'needs-approval') {
      expect(result.reason).toContain('deploy');
    }
  });

  it('does NOT call intake/commit when red-line blocks', async () => {
    let intakeCalled = false;
    let commitCalled = false;
    const deps = fakeDeps({
      intake: (text: string) => {
        intakeCalled = true;
        return { draftId: 'dft_x', draft: { objective: text } };
      },
      commit: (_draftId: string) => {
        commitCalled = true;
        return { taskId: 'tsk_x', goalId: 'gol_x' };
      },
    });

    await routeFreeformAction('удали все файлы', deps);
    expect(intakeCalled).toBe(false);
    expect(commitCalled).toBe(false);
  });

  it('calls intake then commit for a benign action', async () => {
    let intakeCalled = false;
    let commitCalled = false;
    let commitReceivedDraftId = '';
    const deps = fakeDeps({
      intake: (text: string) => {
        intakeCalled = true;
        return { draftId: 'dft_abc', draft: { objective: text.trim() } };
      },
      commit: (draftId: string) => {
        commitCalled = true;
        commitReceivedDraftId = draftId;
        return { taskId: 'tsk_def', goalId: 'gol_ghi' };
      },
    });

    const result = await routeFreeformAction('создай компонент', deps);
    expect(intakeCalled).toBe(true);
    expect(commitCalled).toBe(true);
    expect(commitReceivedDraftId).toBe('dft_abc');
    expect(result.kind).toBe('queued');
  });

  // ── chatId + enqueueRemote wiring ──────────────────────────────────────

  it('calls enqueueRemote when chatId is provided and action is queued', async () => {
    const enqueueRemote = vi.fn().mockResolvedValue('queue-id-1');
    const deps = fakeDeps({ enqueueRemote });

    const result = await routeFreeformAction('создай компонент', deps, 12345);
    expect(result.kind).toBe('queued');
    expect(enqueueRemote).toHaveBeenCalledWith(12345, 'создай компонент');
  });

  it('does NOT call enqueueRemote when chatId is omitted', async () => {
    const enqueueRemote = vi.fn().mockResolvedValue('queue-id-1');
    const deps = fakeDeps({ enqueueRemote });

    const result = await routeFreeformAction('создай компонент', deps);
    expect(result.kind).toBe('queued');
    expect(enqueueRemote).not.toHaveBeenCalled();
  });

  it('enqueue failure does not break queued-kind return', async () => {
    const enqueueRemote = vi.fn().mockRejectedValue(new Error('Supabase unreachable'));
    const deps = fakeDeps({ enqueueRemote });

    const result = await routeFreeformAction('запусти тесты', deps, 99999);
    expect(result.kind).toBe('queued');
    if (result.kind === 'queued') {
      expect(result.taskId).toBe('tsk_fake456');
    }
    expect(enqueueRemote).toHaveBeenCalled();
  });

  it('does NOT call enqueueRemote for red-line actions even with chatId', async () => {
    const enqueueRemote = vi.fn().mockResolvedValue('queue-id-1');
    const deps = fakeDeps({ enqueueRemote });

    const result = await routeFreeformAction('удали все файлы', deps, 12345);
    expect(result.kind).toBe('needs-approval');
    expect(enqueueRemote).not.toHaveBeenCalled();
  });
});
