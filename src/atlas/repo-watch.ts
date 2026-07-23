/**
 * repo_watch — Phase 3 skill #2. NOTIFY-ONLY.
 *
 * Reads git status of the configured repo roots and, on change + rate-limit,
 * sends the CEO a compact Telegram digest through the gated notify path.
 *
 * HARD BOUNDARIES:
 *   - READ-ONLY git: rev-parse / status / log / rev-list. No commit, push, merge,
 *     fetch (fetch is opt-in only), or any tree mutation.
 *   - Notify is rate-limited (policy.skills.repo_watch.interval_min) AND
 *     change-gated (a digest is only sent when something actually changed).
 *   - Sends only to the CEO chat (TELEGRAM_CEO_CHAT_ID) via the notify gate;
 *     the bot token is read from env and never logged.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { notifyCeoResult } from './notify.js';
import { repoWatchRoots, repoWatchIntervalMin } from './policy.js';

export interface RepoStatus {
  root: string;
  name: string;
  ok: boolean;
  branch?: string;
  dirty?: number;
  ahead?: number;
  lastCommit?: string;
  error?: string;
}

function git(root: string, args: string[]): string {
  // stderr ignored: git prints "no upstream configured" / core.fsync warnings there;
  // a non-zero exit still throws (caught by checkRepo), we just don't want the noise.
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** Read-only status of one repo. Never throws — returns {ok:false} on any error. */
export function checkRepo(root: string): RepoStatus {
  const name = basename(root);
  try {
    git(root, ['rev-parse', '--is-inside-work-tree']);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const porcelain = git(root, ['status', '--porcelain']);
    const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
    const lastCommit = git(root, ['log', '-1', '--format=%h %s']);
    let ahead: number | undefined;
    try {
      ahead = parseInt(git(root, ['rev-list', '--count', '@{u}..HEAD']), 10); // local-only, no fetch
      if (!Number.isFinite(ahead)) ahead = undefined;
    } catch {
      ahead = undefined; // no upstream configured
    }
    return { root, name, ok: true, branch, dirty, ahead, lastCommit };
  } catch (e) {
    return { root, name, ok: false, error: (e as Error)?.message?.slice(0, 120) };
  }
}

export function scanRepos(roots: string[]): RepoStatus[] {
  return roots.map(checkRepo);
}

export function formatDigest(statuses: RepoStatus[]): string {
  const lines = statuses.map((s) => {
    if (!s.ok) return `- ${s.name}: git error (${s.error})`;
    const bits = [`branch ${s.branch}`, s.dirty ? `${s.dirty} dirty` : 'clean'];
    if (s.ahead) bits.push(`${s.ahead} ahead of upstream`);
    return `- ${s.name}: ${bits.join(', ')} — ${s.lastCommit}`;
  });
  return ['Repo watch:', ...lines].join('\n');
}

/** Signature used for change detection. */
export function signature(statuses: RepoStatus[]): string {
  return statuses.map((s) => `${s.name}:${s.branch ?? '-'}:${s.dirty ?? '-'}:${s.ahead ?? '-'}:${s.lastCommit ?? s.error ?? '-'}`).join('|');
}

interface WatchState {
  sig: string;
  lastNotifyMs: number;
}
function stateFile(): string {
  return process.env.ATLAS_REPO_WATCH_STATE || join(tmpdir(), 'atlas-repo-watch.json');
}
function readState(): WatchState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8'));
    return { sig: String(s.sig ?? ''), lastNotifyMs: Number(s.lastNotifyMs ?? 0) };
  } catch {
    return { sig: '', lastNotifyMs: 0 };
  }
}
function writeState(s: WatchState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

/**
 * Decide whether to notify: only when the status changed since the last sent
 * digest AND at least interval_min has elapsed (anti-spam). Pure w.r.t. `nowMs`.
 */
export function decideNotify(
  statuses: RepoStatus[],
  intervalMin: number,
  nowMs: number,
): { notify: boolean; reason: string; sig: string } {
  const sig = signature(statuses);
  const st = readState();
  if (sig === st.sig) return { notify: false, reason: 'no change since last notify', sig };
  const elapsedMin = (nowMs - st.lastNotifyMs) / 60_000;
  if (elapsedMin < intervalMin) {
    return { notify: false, reason: `rate-limited (${elapsedMin.toFixed(1)}min < ${intervalMin}min)`, sig };
  }
  return { notify: true, reason: 'changed and interval elapsed', sig };
}

export async function runRepoWatch(
  opts: { notify?: boolean; now?: number } = {},
): Promise<{ statuses: RepoStatus[]; digest: string; decision: ReturnType<typeof decideNotify>; sent: boolean }> {
  const roots = repoWatchRoots();
  const statuses = scanRepos(roots);
  const digest = formatDigest(statuses);
  const now = opts.now ?? Date.now();
  const decision = decideNotify(statuses, repoWatchIntervalMin(), now);
  let sent = false;
  if (opts.notify && decision.notify) {
    // M7: route through the canonical notify chokepoint (no private telegramSend).
    const outcome = await notifyCeoResult('important', digest);
    sent = outcome.result === 'SENT';
    if (sent) writeState({ sig: decision.sig, lastNotifyMs: now });
  }
  return { statuses, digest, decision, sent };
}
