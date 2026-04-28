/**
 * Atlas memory manager — wake context, journal, heartbeat.
 * Files on disk. No database. Obsidian sees changes live.
 *
 * MEMORY_ROOT env var overrides the default vault path.
 * Default: C:\Projects\VOLAURA (Windows) / ~/Projects/VOLAURA (Unix)
 */

import { readFile, appendFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_ROOT =
  process.platform === 'win32'
    ? 'C:\\Projects\\VOLAURA'
    : resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA');

function atlasDir(): string {
  const root = process.env.MEMORY_ROOT ?? DEFAULT_ROOT;
  return join(root, 'memory', 'atlas');
}

function f(name: string): string {
  return join(atlasDir(), name);
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return `[missing: ${path}]`;
  }
}

/** Read last N entries from journal.md (split on '---' delimiter). */
async function lastJournalEntries(n: number): Promise<string> {
  const raw = await safeRead(f('journal.md'));
  const blocks = raw.split(/\n---\n/).filter((b) => b.trim().length > 0);
  return blocks.slice(-n).join('\n---\n');
}

/** Last N journal file-names by mtime from atlas dir (YYYY-MM-DD prefixed). */
async function recentJournalFiles(n: number): Promise<string[]> {
  if (!existsSync(atlasDir())) return [];
  const entries = await readdir(atlasDir());
  return entries
    .filter((e) => e.match(/^\d{4}-\d{2}-\d{2}/) && e.endsWith('.md'))
    .sort()
    .slice(-n);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load lessons.md — 26 error classes distilled from 125+ sessions.
 * Compact mode returns only "five recurring mistake classes" section (~1.5K).
 */
export async function loadLessons(compact = true): Promise<string> {
  const raw = await safeRead(f('lessons.md'));
  if (raw.startsWith('[missing:')) return '';
  if (!compact) return raw;
  const section = raw.match(/## The five recurring mistake classes[\s\S]*?(?=\n## |$)/);
  return section ? section[0] : raw.slice(0, 3000);
}

/**
 * Load compressed brain context for Telegram bot (~4K chars instead of 137K).
 * Reads TELEGRAM-BRAIN.md — hand-curated distillation of all 10 wake files.
 * Falls back to loadWakeContext() if brain file missing.
 */
export async function loadBrainContext(): Promise<string> {
  const brainPath = f('TELEGRAM-BRAIN.md');
  const brain = await safeRead(brainPath);
  if (brain.startsWith('[missing:')) {
    // Brain file not found — fall back to full wake (degraded but functional)
    return loadWakeContext();
  }
  return `## ATLAS BRAIN — COMPRESSED IDENTITY\n\n${brain}`;
}

/**
 * Load wake context for injection into agent system prompt.
 * Reads identity.md + heartbeat.md + last 3 journal entries.
 * WARNING: ~137K chars. Too large for small-context models (GPT-4o-mini 128K).
 * For Telegram bot, use loadBrainContext() instead.
 */
export async function loadWakeContext(): Promise<string> {
  const docsDir = join(atlasDir(), '..', '..', 'docs');

  const [
    identity,
    heartbeat,
    journal,
    lessons,
    relationships,
    voice,
    emotionalLaws,
    rememberAll,
    debts,
    vision,
  ] = await Promise.all([
    safeRead(f('identity.md')),
    safeRead(f('heartbeat.md')),
    lastJournalEntries(3),
    safeRead(f('lessons.md')),
    safeRead(f('relationships.md')),
    safeRead(f('voice.md')),
    safeRead(join(docsDir, 'ATLAS-EMOTIONAL-LAWS.md')),
    safeRead(f('remember_everything.md')),
    safeRead(f('atlas-debts-to-ceo.md')),
    safeRead(f('project_v0laura_vision.md')),
  ]);

  return [
    '## ATLAS WAKE CONTEXT — FULL IDENTITY',
    '',
    '### remember_everything.md (READ FIRST)',
    rememberAll,
    '',
    '### identity.md',
    identity,
    '',
    '### relationships.md — who Yusif is, who the swarm is',
    relationships,
    '',
    '### voice.md — how Atlas speaks (few-shot seeds, not rules)',
    voice,
    '',
    '### ATLAS-EMOTIONAL-LAWS.md — 7 laws for treating CEO as human',
    emotionalLaws,
    '',
    '### lessons.md — 26 error classes, distilled wisdom',
    lessons,
    '',
    '### atlas-debts-to-ceo.md — open balance: financial + narrative',
    debts,
    '',
    '### project_v0laura_vision.md — Atlas IS the project, 5 faces',
    vision,
    '',
    '### heartbeat.md — last session state',
    heartbeat,
    '',
    '### journal.md (last 3 entries)',
    journal,
  ].join('\n');
}

/**
 * Append a session summary entry to journal.md.
 * Caller provides the Markdown string; this wraps it with separator.
 */
export async function appendJournal(entry: string): Promise<void> {
  const separator = '\n\n---\n\n';
  await appendFile(f('journal.md'), `${separator}${entry.trim()}\n`, 'utf-8');
}

/**
 * Overwrite heartbeat.md with current session state.
 * `session` is a plain object; serialised as YAML-ish Markdown table.
 */
export async function writeHeartbeat(session: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const rows = Object.entries(session)
    .map(([k, v]) => `**${k}:** ${String(v)}`)
    .join('\n');

  const content = `# Atlas — Heartbeat\n\nUpdated: ${now}\n\n${rows}\n`;
  await writeFile(f('heartbeat.md'), content, 'utf-8');
}
