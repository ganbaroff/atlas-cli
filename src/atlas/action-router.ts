/**
 * atlas/action-router.ts — classifies freeform CEO messages into routing
 * decisions: chat (not an action), queued (safe action → exec-graph task),
 * or needs-approval (red-line / irreversible).
 *
 * This module is the GATE between a raw message and the execution stack.
 * It does NOT send telegram messages, does NOT auto-execute irreversible
 * actions, and does NOT import telegram or goal-runner. It only:
 *   1. Classifies intent (keyword heuristic, deterministic)
 *   2. Checks red lines (text-derived effects → red-line.ts vocabulary)
 *   3. Intakes safe actions into exec-graph via swarm-exec intake+commit
 *
 * All external dependencies are injected via ActionRouterDeps so tests
 * never touch real exec-graph or filesystem.
 *
 * Tests: ../__tests__/action-router.test.ts
 */

import type { TypedEffect, EffectKind } from '../goal-runner/types.js';
import { classifyEffect, hasRedLine, redLineReason } from '../goal-runner/red-line.js';
import { intakeCommand } from '../swarm-exec/commands.js';
import { commitCommand } from '../swarm-exec/commands.js';
import { queueRemoteCommand } from './supabase-memory.js';

// ── Result types ────────────────────────────────────────────────────────

export type ActionRouterResult =
  | { kind: 'chat' }
  | { kind: 'queued'; taskId: string; goalId?: string; summary: string }
  | { kind: 'needs-approval'; reason: string };

// ── Intent classification (deterministic keyword heuristic) ─────────────
//
// Action verbs in Russian and English. A message containing any of these
// (case-insensitive, word-boundary-ish via lowercased includes) is
// classified as an action. Everything else defaults to 'chat' (safe
// default — false negatives are harmless, false positives are not).

/** Russian imperative action verbs (2nd person singular). */
const RU_ACTION_VERBS = [
  'сделай', 'открой', 'запусти', 'создай', 'напиши',
  'построй', 'исправь', 'задеплой', 'найди файл',
  'покажи код', 'удали', 'обнови', 'перезапусти',
  'установи', 'переведи',
];

/** English imperative action verbs. */
const EN_ACTION_VERBS = [
  'run', 'build', 'fix', 'deploy', 'open', 'create',
  'delete', 'remove', 'install', 'update', 'restart',
  'find file', 'show code', 'write', 'execute',
];

/** Greeting / smalltalk patterns — if matched first, short-circuit to chat. */
const CHAT_PATTERNS = [
  'привет', 'здравствуй', 'добрый', 'как дела', 'как ты',
  'что нового', 'hello', 'hey', 'hi', 'how are you',
  'good morning', 'good evening', 'what\'s up',
];

/**
 * Classify a freeform message as 'chat' or 'action'. Deterministic — no
 * LLM, no network. Safe default is 'chat'.
 */
export function classifyIntent(text: string): 'chat' | 'action' {
  const lower = text.toLowerCase().trim();
  if (!lower) return 'chat';

  // Greetings / smalltalk → chat (checked first so "привет, сделай X"
  // still routes to action via the verb check below, but a bare greeting
  // short-circuits here).
  const isOnlyChat = CHAT_PATTERNS.some((p) => lower.includes(p));

  // Action verbs → action.
  const hasActionVerb =
    RU_ACTION_VERBS.some((v) => lower.includes(v)) ||
    EN_ACTION_VERBS.some((v) => lower.includes(v));

  if (hasActionVerb) return 'action';
  if (isOnlyChat) return 'chat';

  // No signal either way → safe default.
  return 'chat';
}

// ── Text-based red-line scanning ────────────────────────────────────────
//
// Maps freeform text keywords to the EffectKind vocabulary from
// goal-runner/types.ts, then uses red-line.ts's classifyEffect() to
// determine if any derived effect is red-lined. This is a TEXT-level
// approximation — the real Hand-level effect classification happens
// later in the pipeline; this gate catches obvious irreversible intent
// BEFORE a task is even created.

const TEXT_RED_LINE_KEYWORDS: ReadonlyArray<{ pattern: string; effect: EffectKind }> = [
  // Money / payment
  { pattern: 'переведи деньги', effect: 'money' },
  { pattern: 'перевод', effect: 'money' },
  { pattern: 'оплат', effect: 'payment' },
  { pattern: 'payment', effect: 'payment' },
  { pattern: 'transfer money', effect: 'money' },
  { pattern: 'send money', effect: 'money' },
  // Deletion / destructive
  { pattern: 'удали все', effect: 'deletion' },
  { pattern: 'delete all', effect: 'deletion' },
  { pattern: 'rm -rf', effect: 'deletion' },
  { pattern: 'drop table', effect: 'deletion' },
  { pattern: 'drop database', effect: 'deletion' },
  // Deploy / prod
  { pattern: 'задеплой в прод', effect: 'deploy' },
  { pattern: 'deploy to prod', effect: 'deploy' },
  { pattern: 'deploy to production', effect: 'deploy' },
  { pattern: 'push to prod', effect: 'deploy' },
  // Credentials / secrets
  { pattern: 'credential', effect: 'credentials' },
  { pattern: 'api key', effect: 'credentials' },
  { pattern: 'secret', effect: 'env-secret-mutation' },
  { pattern: 'password', effect: 'credentials' },
  // External sends
  { pattern: 'отправь письмо', effect: 'external-send' },
  { pattern: 'send email', effect: 'external-send' },
  { pattern: 'send message', effect: 'external-send' },
  { pattern: 'post to', effect: 'external-send' },
  // Prod DB
  { pattern: 'prod db', effect: 'prod-data-write' },
  { pattern: 'production database', effect: 'prod-data-write' },
  { pattern: 'migration', effect: 'live-db-apply' },
  // Merge
  { pattern: 'merge to main', effect: 'merge-to-main' },
  { pattern: 'force push', effect: 'remote-vcs-mutation' },
];

/**
 * Derive typed effects from freeform text by keyword scan. Returns only
 * the effects that matched — an empty array means no red-line keywords
 * were found.
 */
export function deriveEffectsFromText(text: string): TypedEffect[] {
  const lower = text.toLowerCase();
  const seen = new Set<EffectKind>();
  const effects: TypedEffect[] = [];

  for (const { pattern, effect } of TEXT_RED_LINE_KEYWORDS) {
    if (lower.includes(pattern) && !seen.has(effect)) {
      seen.add(effect);
      effects.push({ kind: effect, class: classifyEffect(effect) });
    }
  }

  return effects;
}

// ── Deps injection ──────────────────────────────────────────────────────

export interface ActionRouterDeps {
  /** Compile freeform text into a draft + persist it. */
  intake: (text: string) => { draftId: string; draft: { objective: string } };
  /** Commit a draft into an exec-graph task (creates goal if needed). */
  commit: (draftId: string) => { taskId: string; goalId: string };
  /** Optional red-line check override. Default: deriveEffectsFromText. */
  redLineCheck?: (text: string) => { blocked: boolean; reason?: string };
  /** Enqueue a command to the Supabase nerve for atlas-runner. Injected for testability. */
  enqueueRemote?: (chatId: number, command: string) => Promise<string>;
}

/**
 * Production factory — binds real swarm-exec intake/commit + text-based
 * red-line scanning. Use this in production wiring; tests pass fakes.
 */
export function defaultActionRouterDeps(): ActionRouterDeps {
  return {
    intake: (text: string) => {
      const result = intakeCommand(text);
      return { draftId: result.draftId, draft: { objective: result.draft.objective } };
    },
    commit: (draftId: string) => {
      const result = commitCommand(draftId);
      return { taskId: result.taskId, goalId: result.goalId };
    },
    redLineCheck: (text: string) => {
      const effects = deriveEffectsFromText(text);
      if (hasRedLine(effects)) {
        return { blocked: true, reason: redLineReason(effects) };
      }
      return { blocked: false };
    },
    enqueueRemote: queueRemoteCommand,
  };
}

// ── Reply helper (pure, no deps — testable without a live bot) ──────────

/**
 * Map an ActionRouterResult to a Russian CEO-facing reply string.
 * Returns null for 'chat' (caller should fall through to the normal brain
 * reply). Pure function — no side effects, no network.
 */
export function actionResultToReply(result: ActionRouterResult): string | null {
  switch (result.kind) {
    case 'chat':
      return null;
    case 'queued':
      return `Принял. Задача ${result.taskId} создана и поставлена в очередь локальному раннеру — вернусь с результатом, когда он её возьмёт.`;
    case 'needs-approval':
      return `Это требует твоего явного 'да' (${result.reason}). Без подтверждения не делаю.`;
  }
}

// ── Router ──────────────────────────────────────────────────────────────

/**
 * Route a freeform CEO message to the correct action path.
 *
 * - chat → caller falls back to brain reply
 * - queued → action accepted as a tracked exec-graph task
 * - needs-approval → red-line tripped, do NOT execute, ask CEO
 *
 * Never auto-executes irreversible actions. Never touches telegram.
 *
 * @param chatId — optional Telegram chat ID. When provided AND deps.enqueueRemote
 *   exists, also enqueues a work order to the Supabase nerve for atlas-runner.
 *   Best-effort: a queue failure logs but never throws or changes the returned kind.
 *   Omit (or pass undefined) to skip enqueue — existing callers/tests unaffected.
 */
export async function routeFreeformAction(
  text: string,
  deps: ActionRouterDeps,
  chatId?: number,
): Promise<ActionRouterResult> {
  // Step 1: classify intent.
  if (classifyIntent(text) === 'chat') {
    return { kind: 'chat' };
  }

  // Step 2: red-line gate.
  const redLine = deps.redLineCheck
    ? deps.redLineCheck(text)
    : (() => {
        const effects = deriveEffectsFromText(text);
        if (hasRedLine(effects)) {
          return { blocked: true, reason: redLineReason(effects) };
        }
        return { blocked: false };
      })();

  if (redLine.blocked) {
    return { kind: 'needs-approval', reason: redLine.reason ?? 'Red-line effect detected' };
  }

  // Step 3: intake + commit → tracked exec-graph task.
  const { draftId, draft } = deps.intake(text);
  const { taskId, goalId } = deps.commit(draftId);

  // Step 4: best-effort enqueue to Supabase nerve (§7) for atlas-runner.
  // The exec-graph task is already created — a queue failure must never
  // make this function throw or change its returned kind.
  if (chatId !== undefined && deps.enqueueRemote) {
    try {
      await deps.enqueueRemote(chatId, text);
    } catch (e) {
      console.warn(
        `[action-router] enqueue to nerve failed (best-effort, task ${taskId} still in exec-graph):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return {
    kind: 'queued',
    taskId,
    goalId,
    summary: draft.objective,
  };
}
