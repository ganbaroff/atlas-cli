/**
 * Notification discipline — silent by default (anti alert-fatigue, Phase 3.6).
 *
 * The problem: the brain-loop and proactive engines could ping the CEO whenever
 * mood said "probe". That is exactly the noise voice.md warns against. This is
 * the ONE gate every proactive send passes through. If a kind is not important,
 * it is dropped (logged, not sent).
 *
 * Allowed kinds — the only reasons Atlas breaks silence unprompted:
 *   - 'briefing'       the 08:45 morning briefing.
 *   - 'error'          an explicit error state Atlas must own.
 *   - 'important'      a CEO-addressed signal that genuinely needs attention.
 *   - 'remote-result'  the result of a command the CEO themself queued (a reply).
 * Everything else (default: 'chatter') is silenced.
 *
 * Error messages must be explicit — "не смог X, причина Y, делаю Z". The
 * formatError helper enforces that shape.
 */

export type NotifyKind = 'briefing' | 'error' | 'important' | 'remote-result' | 'chatter';

const ALLOWED: ReadonlySet<NotifyKind> = new Set<NotifyKind>([
  'briefing',
  'error',
  'important',
  'remote-result',
]);

/** Does this kind earn a proactive send? Silent by default. */
export function shouldNotify(kind: NotifyKind): boolean {
  return ALLOWED.has(kind);
}

/** Format an error in the required "не смог X, причина Y, делаю Z" shape. */
export function formatError(what: string, why: string, doing: string): string {
  return `Не смог ${what}, причина: ${why}. Делаю: ${doing}.`;
}

export interface NotifyDeps {
  /** The raw send. Injected so the gate is testable without Telegram. */
  send: (chatId: number, text: string) => Promise<unknown>;
  ceoChatId?: string;
}

/**
 * The single gated proactive-send path. Returns true if the message was sent,
 * false if it was gated (dropped) or no CEO chat is configured. Never throws —
 * a proactive send failure must not crash the caller.
 *
 * LEGACY BOOLEAN CONTRACT — kept unchanged for existing callers (repo-watch.ts
 * and this file's own pre-existing tests). Its `deps.ceoChatId` field is a
 * historical testability seam, not a real target-selection vector: the only
 * production caller (repo-watch.ts) always passes
 * `process.env.TELEGRAM_CEO_CHAT_ID` verbatim. New callers that need to
 * distinguish failure modes, or that must be structurally unable to pick an
 * arbitrary chat ID, use notifyCeoResult() below instead.
 */
export async function notifyCeo(
  kind: NotifyKind,
  msg: string,
  deps: NotifyDeps,
): Promise<boolean> {
  if (!shouldNotify(kind)) {
    console.log(`[notify] gated kind=${kind} — silent by default`);
    return false;
  }
  const raw = deps.ceoChatId;
  if (!raw) return false;
  const chatId = parseInt(raw, 10);
  if (!Number.isFinite(chatId)) return false;
  try {
    await deps.send(chatId, msg.slice(0, 4096));
    console.log(`[notify] sent kind=${kind} chat=${chatId}`);
    return true;
  } catch (e: any) {
    console.error(`[notify] send failed kind=${kind}:`, e?.message?.slice(0, 200));
    return false;
  }
}

// ── Canonical structured-result API (V0.1 hardening) ──────────────────────────

export type NotifyResult = 'NOT_CONFIGURED' | 'SUPPRESSED' | 'SENT' | 'FAILED';

export interface NotifyOutcome {
  result: NotifyResult;
  error?: string;
}

/**
 * Canonical Telegram sender. This is the ONLY place TELEGRAM_BOT_TOKEN is read
 * for outbound CEO notifications — callers (repo-watch.ts has its own historical
 * copy; autonomy-loop.ts does not and must not) should prefer importing this
 * rather than re-reading the token themselves.
 */
export async function telegramSend(chatId: number, text: string): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`); // status only, no token
  return res.json();
}

/**
 * The ONLY configured outbound target for notifyCeoResult(). Deliberately NOT
 * exported and NOT a parameter of notifyCeoResult() — there is no code path by
 * which a caller (including the autonomy loop) can direct a send at any chat
 * ID other than whatever TELEGRAM_CEO_CHAT_ID resolves to right now.
 */
function resolveCeoChatId(): number | null {
  const raw = process.env.TELEGRAM_CEO_CHAT_ID;
  if (!raw) return null;
  const chatId = parseInt(raw, 10);
  return Number.isFinite(chatId) ? chatId : null;
}

/**
 * Canonical structured-result send. Preserves notifyCeo()'s gate semantics
 * (same shouldNotify() check, same silent-by-default philosophy) but returns a
 * typed outcome so a real send failure is never indistinguishable from "kind
 * gated" or "no CEO chat configured" — the false-completion failure mode that
 * ended the original autonomousBrainLoop.
 *
 * `send` is injectable ONLY for testing the send mechanism (defaults to the
 * real telegramSend) — the chat ID itself is never injectable, see
 * resolveCeoChatId() above.
 */
export async function notifyCeoResult(
  kind: NotifyKind,
  msg: string,
  send: (chatId: number, text: string) => Promise<unknown> = telegramSend,
): Promise<NotifyOutcome> {
  if (!shouldNotify(kind)) {
    console.log(`[notify] gated kind=${kind} — silent by default`);
    return { result: 'SUPPRESSED' };
  }
  const chatId = resolveCeoChatId();
  if (chatId === null) {
    return { result: 'NOT_CONFIGURED' };
  }
  try {
    await send(chatId, msg.slice(0, 4096));
    console.log(`[notify] sent kind=${kind} chat=${chatId}`);
    return { result: 'SENT' };
  } catch (e: any) {
    const error = e?.message?.slice(0, 200);
    console.error(`[notify] send failed kind=${kind}:`, error);
    return { result: 'FAILED', error };
  }
}
