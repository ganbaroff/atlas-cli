/**
 * atlas/executor/rollback.ts — returning a failed mission's worktree to its
 * declared pre-state.
 *
 * Rollback is Atlas's, not the executor's: the method comes from the signed
 * Work Order's `rollbackMethod`, the changed set is captured from git before
 * anything is undone, and the result is re-verified against disk afterwards. An
 * executor is never asked to clean up after itself.
 *
 * Two invariants the implementation enforces rather than assumes. Evidence
 * survives — the evidence directory is excluded from the clean, so a REJECT
 * keeps its proof. And rollback touches only the mission worktree: the method
 * runs with `git -C <worktree>`, and a worktree that is not the one named in
 * the Work Order is refused before any git call.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { canonicalizeRepoPath } from '../work-order/repo-writer-lock.js';
import type { SignedWorkOrder } from '../work-order/types.js';

export type RollbackMethod = 'git-checkout--' | 'none';

export interface ChangedEntry {
  readonly status: string;
  readonly path: string;
}

export type RollbackResult =
  | {
      readonly ok: true;
      readonly method: RollbackMethod;
      /** What was dirty BEFORE the rollback ran — captured, not inferred after. */
      readonly changedBefore: readonly ChangedEntry[];
      readonly changedAfter: readonly ChangedEntry[];
      readonly preservedPaths: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'worktree_mismatch'
        | 'unknown_rollback_method'
        | 'git_failed'
        | 'residue_after_rollback';
      readonly detail: string;
      readonly changedBefore: readonly ChangedEntry[];
      readonly changedAfter: readonly ChangedEntry[];
    };

/** Parses `git status --porcelain` into entries. Untracked shows as `??`. */
export function parsePorcelain(porcelain: string): ChangedEntry[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
}

function gitStatus(worktree: string, git: GitRunner): ChangedEntry[] {
  return parsePorcelain(git(worktree, ['status', '--porcelain']));
}

export type GitRunner = (worktree: string, args: readonly string[]) => string;

const realGit: GitRunner = (worktree, args) =>
  execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true });

export interface RollbackRequest {
  readonly signedWorkOrder: SignedWorkOrder;
  /** The worktree the mission actually ran in — compared against the order. */
  readonly worktreeRoot: string;
  /** Paths under the worktree that must survive, e.g. the evidence pack. */
  readonly preservePaths?: readonly string[];
  readonly git?: GitRunner;
}

/**
 * Undoes a failed mission. Safe to call when nothing changed — the changed set
 * is then empty and the result still reports what it saw.
 */
export function rollbackMission(request: RollbackRequest): RollbackResult {
  const git = request.git ?? realGit;
  const declared = request.signedWorkOrder.rollbackMethod as RollbackMethod;

  // The worktree is proven, not trusted: a mission cannot roll back a tree
  // other than the one its Work Order names.
  if (canonicalizeRepoPath(request.worktreeRoot) !== canonicalizeRepoPath(request.signedWorkOrder.worktreePath)) {
    return {
      ok: false,
      reason: 'worktree_mismatch',
      detail: `mission ran in ${request.worktreeRoot} but the Work Order names ${request.signedWorkOrder.worktreePath}`,
      changedBefore: [],
      changedAfter: [],
    };
  }

  let changedBefore: ChangedEntry[];
  try {
    changedBefore = gitStatus(request.worktreeRoot, git);
  } catch (err) {
    return {
      ok: false,
      reason: 'git_failed',
      detail: `status failed: ${(err as Error)?.message ?? 'unknown'}`,
      changedBefore: [],
      changedAfter: [],
    };
  }

  if (declared === 'none') {
    return {
      ok: false,
      reason: 'unknown_rollback_method',
      detail: 'Work Order declares no rollback method; a mission that can mutate must declare one',
      changedBefore,
      changedAfter: changedBefore,
    };
  }
  if (declared !== 'git-checkout--') {
    return {
      ok: false,
      reason: 'unknown_rollback_method',
      detail: `unsupported rollbackMethod '${String(declared)}'`,
      changedBefore,
      changedAfter: changedBefore,
    };
  }

  const preserved = [...(request.preservePaths ?? [])];
  try {
    // Tracked files back to HEAD — index AND worktree. `checkout -- .` restores
    // the worktree from the INDEX, so anything the executor staged would
    // survive the rollback; a test with a staged file caught exactly that.
    // `--source=HEAD --staged --worktree` is the only form that undoes both.
    git(request.worktreeRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
    // Untracked files removed, except what must survive.
    const cleanArgs = ['clean', '-fdq'];
    for (const keep of preserved) cleanArgs.push('-e', keep);
    git(request.worktreeRoot, cleanArgs);
  } catch (err) {
    return {
      ok: false,
      reason: 'git_failed',
      detail: `rollback command failed: ${(err as Error)?.message ?? 'unknown'}`,
      changedBefore,
      changedAfter: gitStatus(request.worktreeRoot, git),
    };
  }

  const changedAfter = gitStatus(request.worktreeRoot, git);
  // Anything still dirty that is NOT a preserved path is residue: the rollback
  // did not actually restore the declared pre-state.
  const residue = changedAfter.filter(
    (entry) => !preserved.some((keep) => entry.path === keep || entry.path.startsWith(keep.replace(/\/*$/, '/'))),
  );
  if (residue.length > 0) {
    return {
      ok: false,
      reason: 'residue_after_rollback',
      detail: `still dirty after rollback: ${residue.map((r) => r.path).join(', ')}`,
      changedBefore,
      changedAfter,
    };
  }

  return {
    ok: true,
    method: declared,
    changedBefore,
    changedAfter,
    preservedPaths: preserved.map((p) => path.normalize(p)),
  };
}
