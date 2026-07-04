/**
 * Cold-start onboarding for new / unlinked Telegram users.
 *
 * The old /start ran an LLM wake for everyone — expensive, and for a stranger
 * it produced a dry command dump. For an unknown user we want at most two short
 * messages, no model call: (1) who Atlas is + what it can do in one breath,
 * (2) the single next action. voice.md style — short, plain, no bullet walls.
 *
 * "Known" = the CEO's chat (TELEGRAM_CEO_CHAT_ID). Known users keep the existing
 * linked-user wake path. The `/start quiz` deep-link payload is preserved and
 * routed to the assessment funnel.
 */

export type StartKind = 'known' | 'quiz' | 'cold';

/** Classify a /start based on chat identity and deep-link payload. */
export function classifyStart(opts: {
  chatId: number;
  ceoChatId?: string;
  payload?: string;
}): StartKind {
  const payload = (opts.payload ?? '').trim().toLowerCase();
  if (payload === 'quiz') return 'quiz';
  if (opts.ceoChatId && String(opts.chatId) === opts.ceoChatId.trim()) return 'known';
  return 'cold';
}

/**
 * The two cold-start messages. Max two — the array length is the contract.
 * [0] = who Atlas is + what it does, one sentence each.
 * [1] = the single next action.
 */
export function coldStartMessages(): [string, string] {
  return [
    'Привет. Я Атлас — цифровой chief-of-staff команды VOLAURA: держу руку на пульсе продукта, ' +
      'слежу за здоровьем систем и расходами, запускаю проверки и задачи прямо отсюда, из чата.',
    'Дальше просто: напиши /help — покажу, что умею. Или сразу пиши своими словами, отвечу.',
  ];
}
