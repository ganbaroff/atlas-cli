/**
 * notify-queue.ts — Durable quiet-hours queue for proactive CEO notifications.
 *
 * Baku quiet hours: 23:00 inclusive to 08:00 exclusive (Asia/Baku, UTC+4).
 * During quiet hours:
 *   - 'panic' kind bypasses quiet hours entirely (always sent immediately).
 *   - 'chatter' kind is SUPPRESSED (not queued, not sent).
 *   - Other allowed kinds ('briefing', 'error', 'important', 'remote-result')
 *     are QUEUED: persisted to a durable, redacted queue file and sent on drain.
 *
 * Queue drain happens outside quiet hours: one compact digest, atomic
 * retain-on-failure / clear-on-success, no duplicate replay.
 *
 * Clock and transport are injectable — tests use fake time/send only.
 * Queue path is overrideable for tests and defaults under ~/.atlas.
 * Secret redaction is applied before any durable write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type NotifyPriority = 'panic' | 'normal';

export interface QueueEntry {
  id: string;
  kind: string;
  message: string;
  queuedAt: string;
  priority: NotifyPriority;
}

export interface NotifyQueueState {
  entries: QueueEntry[];
}

// ── Quiet hours policy ──────────────────────────────────────────────

const BAKU_OFFSET_HOURS = 4; // Asia/Baku = UTC+4

/**
 * Check if a given time is within Baku quiet hours (23:00-08:00 Baku).
 * Injectable clock for testing.
 */
export function isQuietHours(now: Date = new Date()): boolean {
  // Convert to Baku time by adding UTC+4 offset
  const bakuHour = (now.getUTCHours() + BAKU_OFFSET_HOURS) % 24;
  // 23:00 inclusive to 08:00 exclusive
  return bakuHour >= 23 || bakuHour < 8;
}

// ── Secret redaction ────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,          // OpenAI-style keys
  /\b(ghp_[a-zA-Z0-9]{36,})\b/g,         // GitHub PATs
  /\b(ghu_[a-zA-Z0-9]{36,})\b/g,         // GitHub user tokens
  /\b(xoxb-[a-zA-Z0-9-]+)\b/g,           // Slack bot tokens
  /\b(nvapi-[a-zA-Z0-9_-]{20,})\b/g,     // NVIDIA API keys
  /\b(eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]+)\b/g, // JWTs
  /\b([a-f0-9]{64})\b/g,                 // 64-char hex (could be secret)
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// ── Queue file I/O ──────────────────────────────────────────────────

export function queueFilePath(): string {
  return process.env.ATLAS_NOTIFY_QUEUE_PATH || join(homedir(), '.atlas', 'notify-queue.json');
}

export function readQueue(): NotifyQueueState {
  try {
    const raw = readFileSync(queueFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) {
      return { entries: parsed.entries };
    }
    return { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeQueue(state: NotifyQueueState): void {
  const filePath = queueFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

function entryId(): string {
  return `nq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ── Queue operations ────────────────────────────────────────────────

export type QueueResult = 'QUEUED' | 'SUPPRESSED';

/**
 * Enqueue a notification for later delivery. Redacts secrets before write.
 * Returns 'QUEUED' on success. Chatter is SUPPRESSED (not queued).
 */
export function enqueue(kind: string, message: string, priority: NotifyPriority = 'normal'): QueueResult {
  if (kind === 'chatter') return 'SUPPRESSED';

  const state = readQueue();
  state.entries.push({
    id: entryId(),
    kind,
    message: redactSecrets(message),
    queuedAt: new Date().toISOString(),
    priority,
  });
  writeQueue(state);
  return 'QUEUED';
}

export interface DrainResult {
  sent: boolean;
  count: number;
  error?: string;
}

/**
 * Drain the queue: compose one compact digest from all entries,
 * send it, and clear the queue atomically (retain on failure).
 *
 * @param send Injectable transport (defaults must be provided by caller)
 * @param now Injectable clock for testing
 */
export async function drainQueue(
  send: (message: string) => Promise<void>,
  now: Date = new Date(),
): Promise<DrainResult> {
  if (isQuietHours(now)) {
    return { sent: false, count: 0, error: 'still in quiet hours' };
  }

  const state = readQueue();
  if (state.entries.length === 0) {
    return { sent: false, count: 0 };
  }

  // Compose digest
  const lines = state.entries.map((e, i) => {
    const ts = e.queuedAt.slice(11, 16); // HH:MM
    return `${i + 1}. [${ts}] ${e.kind}: ${e.message}`;
  });
  const digest = `Queued notifications (${state.entries.length}):\n${lines.join('\n')}`.slice(0, 4096);

  try {
    await send(digest);
    // Clear on success
    writeQueue({ entries: [] });
    return { sent: true, count: state.entries.length };
  } catch (e: any) {
    // Retain on failure — entries survive for next drain attempt
    return { sent: false, count: state.entries.length, error: e?.message?.slice(0, 200) };
  }
}

/**
 * Clear the queue (test utility).
 */
export function clearQueue(): void {
  writeQueue({ entries: [] });
}
