/**
 * Atlas Telegram command registry — the SINGLE source of truth for what
 * commands exist. /help is generated from this array; there is no
 * hand-maintained duplicate list. When you add a bot.command(...) handler,
 * add its entry here so /help stays honest.
 *
 * Descriptions are bilingual (ru/en) and picked by the user's Telegram
 * language_code (anything starting with "ru" → Russian, else English).
 */

export interface AtlasCommand {
  cmd: string;
  ru: string;
  en: string;
}

export const COMMANDS: readonly AtlasCommand[] = [
  { cmd: 'start', ru: 'начать сессию заново (чистая память)', en: 'restart the session (fresh memory)' },
  { cmd: 'help', ru: 'этот список команд', en: 'this list of commands' },
  { cmd: 'status', ru: 'здоровье, спенд за день, очередь, пульс', en: 'health, daily spend, queue, heartbeat' },
  { cmd: 'models', ru: 'какие LLM-провайдеры доступны', en: 'which LLM providers are available' },
  { cmd: 'task', ru: 'запустить Claude Code на задаче', en: 'run Claude Code on a task' },
  { cmd: 'remote', ru: 'отключён (board P0), governed-путь вернётся', en: 'disabled (board P0), governed path will return' },
  { cmd: 'deploy', ru: 'смержить PR и задеплоить (с подтверждением)', en: 'merge a PR and deploy (with confirmation)' },
  { cmd: 'swarm', ru: 'разобрать задачу роем перспектив', en: 'analyze a task with a swarm of perspectives' },
  { cmd: 'test', ru: 'ссылка на бесплатный AI-тест навыков', en: 'link to the free AI skills test' },
  { cmd: 'pause', ru: 'паника: остановить автономию (ATLAS_PAUSE=1)', en: 'panic: halt autonomy (ATLAS_PAUSE=1)' },
  { cmd: 'resume', ru: 'снять паузу автономии', en: 'lift the autonomy pause' },
];

function isRussian(languageCode?: string): boolean {
  if (!languageCode) return true; // CEO default is Russian (voice.md)
  return languageCode.toLowerCase().startsWith('ru');
}

/**
 * Render /help text from the registry, in the user's language. Plain lines,
 * one command per line — this is a reference list, not conversation, so a tidy
 * `/cmd — desc` column is allowed here (voice.md bans bullet walls in prose,
 * not command references).
 */
export function renderHelp(languageCode?: string): string {
  const ru = isRussian(languageCode);
  const header = ru ? 'Команды Атласа:' : 'Atlas commands:';
  const lines = COMMANDS.map((c) => `/${c.cmd} — ${ru ? c.ru : c.en}`);
  const footer = ru
    ? 'Или просто пиши текстом — отвечу голосом Атласа.'
    : 'Or just write in plain text — I answer in Atlas voice.';
  return [header, '', ...lines, '', footer].join('\n');
}
