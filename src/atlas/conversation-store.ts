/**
 * Persistent conversation memory — JSONL append per message.
 * Lives in VOLAURA vault so wake protocol and other agents can read it.
 *
 * QA kill vectors addressed:
 * 1. Newline BEFORE json (partial write safety)
 * 2. Write queue per chatId (concurrent message safety)
 * 3. Compaction at MAX_LINES (unbounded growth)
 * 4. try/catch per line on parse (malformed line recovery)
 * 5. Atomic rename on compaction (no partial overwrite)
 */

import { appendFile, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function convDir(): string {
  const root = process.env['MEMORY_ROOT'] ??
    (process.platform === 'win32'
      ? 'C:\\Projects\\VOLAURA'
      : join(process.env['HOME'] ?? '~', 'Projects', 'VOLAURA'));
  return join(root, 'memory', 'atlas', 'telegram-conversations');
}

const MAX_LINES = 1000;
const COMPACT_KEEP = 500;

export interface StoredMessage {
  ts: string;
  role: 'user' | 'assistant';
  text: string;
  tokens?: number;
  model?: string;
}

async function ensureDir(): Promise<void> {
  const dir = convDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

function filePath(chatId: number): string {
  return join(convDir(), `${chatId}.jsonl`);
}

const writeQueues = new Map<number, Promise<void>>();

function enqueue(chatId: number, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(chatId, next);
  return next;
}

export function appendMessage(chatId: number, msg: StoredMessage): Promise<void> {
  return enqueue(chatId, async () => {
    await ensureDir();
    const line = JSON.stringify(msg);
    await appendFile(filePath(chatId), '\n' + line, 'utf-8');
  });
}

export function parseJSONL(raw: string): StoredMessage[] {
  const results: StoredMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as StoredMessage);
    } catch {
      // skip malformed line — QA test 2
    }
  }
  return results;
}

export function loadConversation(chatId: number, lastN = 20): StoredMessage[] {
  const fp = filePath(chatId);
  if (!existsSync(fp)) return [];
  const raw = readFileSync(fp, 'utf-8');
  const all = parseJSONL(raw);
  return all.slice(-lastN);
}

export async function compactIfNeeded(chatId: number): Promise<void> {
  const fp = filePath(chatId);
  if (!existsSync(fp)) return;
  const raw = await readFile(fp, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length <= MAX_LINES) return;

  const keep = lines.slice(-COMPACT_KEEP);
  const tmp = fp + '.tmp';
  await writeFile(tmp, '\n' + keep.join('\n'), 'utf-8');
  await rename(tmp, fp);
}
