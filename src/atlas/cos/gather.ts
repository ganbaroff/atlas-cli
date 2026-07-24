/**
 * Chief-of-Staff impure gatherers (W4) — the ONLY place in src/atlas/cos/*
 * that touches the filesystem/git/child_process. facts.ts/drift.ts/brief.ts
 * stay pure; this module produces the real-environment DriftInputs they
 * consume. READ-ONLY: git rev-parse/rev-list only (no fetch, no mutation),
 * heartbeat.md is read not written, graph verify only rebuilds an in-memory
 * snapshot to compare — never writes to state/.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMemoryRoot } from '../path-util.js';
import { readSnapshotFile, rebuildSnapshot, snapshotsEqual } from '../../exec-graph/ledger.js';
import { listTasks as liveListTasks } from '../../exec-graph/api.js';
import { ageHoursSince } from './facts.js';
import type { DriftInputs } from './drift.js';

const TERMINAL_STATUSES = new Set(['verified', 'rejected', 'closed']);

function git(cwd: string, args: string[]): string {
  // stderr ignored: git prints "no upstream" / core.fsync warnings there; a
  // non-zero exit still throws, caught by each gatherer -> null (unknown).
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Read-only ahead/behind vs the branch's configured upstream (@{u}) — no
 * fetch, so this reflects the last time someone fetched, not live origin
 * state. null = could not observe (no upstream configured, not a repo, git
 * missing) -> drift.ts turns that into an 'unknown' finding, never a crash.
 */
export function gatherGitDrift(cwd: string = process.cwd()): DriftInputs['git'] {
  try {
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    try {
      const counts = git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const [behindRemote, aheadRemote] = counts.split(/\s+/).map((n) => parseInt(n, 10));
      if (!Number.isFinite(aheadRemote) || !Number.isFinite(behindRemote)) {
        return { branch, aheadRemote: 0, behindRemote: 0 };
      }
      return { branch, aheadRemote, behindRemote };
    } catch {
      // No upstream (worktrees / local-only branches) — branch still observable.
      return { branch, aheadRemote: 0, behindRemote: 0 };
    }
  } catch {
    return null;
  }
}

/**
 * Real heartbeat.md age in hours, always the true elapsed time — staleness
 * banding (what threshold counts as "stale") is drift.ts's job, not this
 * reader's. null = missing file or an unparseable/missing "Updated:" line.
 */
export function gatherHeartbeatAge(): DriftInputs['heartbeat'] {
  const fp = join(getMemoryRoot(), 'memory', 'atlas', 'heartbeat.md');
  if (!existsSync(fp)) return { ageHours: null };
  try {
    const raw = readFileSync(fp, 'utf-8');
    const match = raw.match(/Updated:\s*(\S+)/);
    if (!match) return { ageHours: null };
    const ms = Date.now() - new Date(match[1]).getTime();
    if (!Number.isFinite(ms)) return { ageHours: null };
    return { ageHours: Math.max(0, ms / 3_600_000) };
  } catch {
    return { ageHours: null };
  }
}

/**
 * `graph verify` outcome: on-disk snapshot vs a fresh in-memory rebuild from
 * the ledger — identical check to `atlas graph verify` (src/cli.ts), reused
 * here rather than re-derived. Read-only: rebuildSnapshot() folds the ledger
 * into a new object, it never writes. null = could not run (corrupt ledger,
 * read error).
 */
export function gatherGraphVerifyOk(): DriftInputs['graphVerifyOk'] {
  try {
    const onDisk = readSnapshotFile() ?? { goals: {}, tasks: {} };
    const rebuilt = rebuildSnapshot();
    return snapshotsEqual(onDisk, rebuilt);
  } catch {
    return null;
  }
}

/**
 * Non-terminal tasks (everything but verified/rejected/closed) with their
 * current age — drift.ts applies the stuck-task threshold, this just
 * observes. Reuses facts.ts's ageHoursSince so "how old is this task" is
 * computed exactly one way across the whole cos/ surface.
 */
export function gatherStuckTaskCandidates(now: Date = new Date()): DriftInputs['stuckTasks'] {
  const nowIso = now.toISOString();
  return liveListTasks()
    .filter((t) => !TERMINAL_STATUSES.has(t.status))
    .map((t) => ({ taskId: t.id, status: t.status, ageHours: ageHoursSince(t, nowIso) }));
}

/** Gather all DriftInputs from the real environment in one call — the impure counterpart to detectDrift()'s pure inputs. */
export function gatherLiveDriftInputs(cwd: string = process.cwd()): DriftInputs {
  return {
    git: gatherGitDrift(cwd),
    heartbeat: gatherHeartbeatAge(),
    graphVerifyOk: gatherGraphVerifyOk(),
    stuckTasks: gatherStuckTaskCandidates(),
  };
}
