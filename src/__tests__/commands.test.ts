import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMANDS, renderHelp } from '../atlas/commands.js';

describe('command registry', () => {
  it('renderHelp lists every registered command (RU)', () => {
    const help = renderHelp('ru');
    for (const c of COMMANDS) {
      expect(help).toContain(`/${c.cmd} —`);
      expect(help).toContain(c.ru);
    }
    expect(help).toContain('Команды Атласа');
  });

  it('renderHelp switches to English for en language_code', () => {
    const help = renderHelp('en-US');
    expect(help).toContain('Atlas commands');
    for (const c of COMMANDS) {
      expect(help).toContain(c.en);
    }
  });

  it('defaults to Russian when language_code is missing', () => {
    expect(renderHelp(undefined)).toContain('Команды Атласа');
  });

  it('registry covers every bot.command handler in telegram.ts (single source)', () => {
    const src = readFileSync(resolve(__dirname, '../telegram.ts'), 'utf-8');
    const registered = new Set(
      Array.from(src.matchAll(/bot\.command\('([^']+)'/g)).map((m) => m[1]),
    );
    // bot.start() registers /start separately — the registry must include it too.
    registered.add('start');
    const known = new Set(COMMANDS.map((c) => c.cmd));
    for (const cmd of registered) {
      expect(known.has(cmd), `/${cmd} handler exists but is missing from COMMANDS registry`).toBe(true);
    }
  });
});
