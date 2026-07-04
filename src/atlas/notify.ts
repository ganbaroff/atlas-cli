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
