/**
 * Atlas memory manager — wake context, journal, heartbeat.
 * Files on disk. No database. Obsidian sees changes live.
 *
 * MEMORY_ROOT env var overrides the default vault path.
 * Default: C:\Projects\VOLAURA (Windows) / ~/Projects/VOLAURA (Unix)
 */

import { readFile, appendFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getMemoryRoot } from './path-util.js';
import { isSupabaseConfigured, loadLatestHeartbeatDB, loadRecentJournalDB } from './supabase-memory.js';

function atlasDir(): string {
  const root = getMemoryRoot();
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
 * Build the "## RECENT STATE (last session)" section: local heartbeat.md + last 3
 * journal entries first, falling back to Supabase (loadLatestHeartbeatDB /
 * loadRecentJournalDB) when the local vault is missing/empty (Railway redeploy wipes
 * the anonymous volume). Returns '' when there is nothing to show — the compressed
 * brain context injects no recent state today, so an empty result is a no-op append.
 */
async function loadRecentStateSection(): Promise<string> {
  let heartbeat = await safeRead(f('heartbeat.md'));
  let journal = await lastJournalEntries(3);

  if (heartbeat.startsWith('[missing:') && isSupabaseConfigured()) {
    const hb = await loadLatestHeartbeatDB();
    if (hb) heartbeat = hb;
  }
  if ((!journal.trim() || journal.startsWith('[missing:')) && isSupabaseConfigured()) {
    const j = await loadRecentJournalDB(3);
    if (j) journal = j;
  }

  const hasHeartbeat = !heartbeat.startsWith('[missing:') && heartbeat.trim().length > 0;
  const hasJournal = journal.trim().length > 0 && !journal.startsWith('[missing:');
  if (!hasHeartbeat && !hasJournal) return '';

  return `\n\n## RECENT STATE (last session)\n${hasHeartbeat ? heartbeat : ''}\n\n### recent journal\n${hasJournal ? journal : ''}`;
}

/**
 * Load compressed brain context for Telegram bot (~4K chars instead of 137K).
 * Reads TELEGRAM-BRAIN.md first, then compiled BRAIN.md if present.
 * Falls back to loadWakeContext() if brain file missing.
 */
export async function loadBrainContext(): Promise<string> {
  const telegramBrain = await safeRead(f('TELEGRAM-BRAIN.md'));
  if (!telegramBrain.startsWith('[missing:')) {
    const recentState = await loadRecentStateSection();
    return `## ATLAS BRAIN — COMPRESSED IDENTITY\n\n${telegramBrain}${recentState}`;
  }

  const compiledBrain = await safeRead(f('BRAIN.md'));
  if (!compiledBrain.startsWith('[missing:')) {
    const recentState = await loadRecentStateSection();
    return `## ATLAS BRAIN — COMPILED IDENTITY\n\n${compiledBrain}${recentState}`;
  }

  // Brain file not found — fall back to full wake (degraded but functional)
  return loadWakeContext();
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
    heartbeatRaw,
    journalRaw,
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

  // Local vault is on Railway's anonymous (ephemeral) volume — wiped on every
  // redeploy. When the local files are missing/empty, fall back to what was
  // already durably written to Supabase (writeHeartbeatDB/writeJournalDB), so
  // the bot recalls last session state even after a redeploy wipes the disk.
  let heartbeat = heartbeatRaw;
  let journal = journalRaw;
  if (heartbeat.startsWith('[missing:') && isSupabaseConfigured()) {
    const hb = await loadLatestHeartbeatDB();
    if (hb) heartbeat = hb;
  }
  if ((!journal.trim() || journal.startsWith('[missing:')) && isSupabaseConfigured()) {
    const j = await loadRecentJournalDB(3);
    if (j) journal = j;
  }

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
  await mkdir(atlasDir(), { recursive: true });
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
  // Ensure atlas dir exists (Railway container may not have it after redeploy)
  await mkdir(atlasDir(), { recursive: true });
  await writeFile(f('heartbeat.md'), content, 'utf-8');
}
