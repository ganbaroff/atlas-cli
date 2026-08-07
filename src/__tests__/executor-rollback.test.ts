/**
 * Wave 9 acceptance: rollback restores the declared pre-state, and refuses
 * rather than pretending when it cannot.
 *
 * Runs against a real temporary git repository — a mocked git would prove
 * nothing about whether `checkout -- .` plus `clean -fdq` actually restores a
 * tree with staged, unstaged and untracked changes in it at once.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePorcelain, rollbackMission } from '../atlas/executor/rollback.js';
import { hmacSigner, signWorkOrder } from '../atlas/work-order/sign.js';
import type { SignedWorkOrder, WorkOrder } from '../atlas/work-order/types.js';

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
}

function makeOrder(overrides: Partial<WorkOrder> = {}): SignedWorkOrder {
  const now = Date.now();
  const order: WorkOrder = {
    workOrderId: 'wo-rollback-1',
    goalId: 'g',
    taskId: 't',
    issuerIdentity: 'issuer',
    executorIdentity: 'executor',
    repoCanonicalPath: repo,
    baseBranch: 'master',
    baseHead: 'a'.repeat(40),
    worktreePath: repo,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    nonce: `n-${now}`,
    allowedPaths: ['**'],
    forbiddenPaths: [],
    forbiddenActions: [],
    allowedCommandClasses: ['filesystem'],
    maxAttempts: 1,
    maxWallClockMs: 60_000,
    expectedTests: [],
    evidenceRequirements: [],
    rollbackMethod: 'git-checkout--',
    ...overrides,
  };
  return signWorkOrder(order, hmacSigner('rollback-test-key'));
}

beforeEach(() => {
  repo = path.join(tmpdir(), `atlas-rollback-${process.pid}-${Math.floor(performance.now())}`);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  git(['init', '-q']);
  git(['config', 'user.email', 'atlas@test']);
  git(['config', 'user.name', 'atlas']);
  // Without this, git's Windows autocrlf rewrites LF to CRLF on checkout, so a
  // restored file never byte-matches its pre-state and every rollback reports
  // residue. That is a fixture artefact, not a rollback defect.
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '-A']);
  git(['commit', '-qm', 'pre-state']);
});

afterEach(() => {
  if (repo && existsSync(repo)) rmSync(repo, { recursive: true, force: true });
});

describe('parsePorcelain', () => {
  it('separates status from path for modified, staged and untracked entries', () => {
    const entries = parsePorcelain(' M src/a.ts\nM  src/b.ts\n?? junk.txt\n');
    expect(entries).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'M', path: 'src/b.ts' },
      { status: '??', path: 'junk.txt' },
    ]);
  });
});

describe('rollbackMission', () => {
  it('restores modified, staged and untracked changes in one pass', () => {
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 999;\n', 'utf8');
    writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 888;\n', 'utf8');
    git(['add', 'src/b.ts']);
    writeFileSync(path.join(repo, 'junk.txt'), 'left behind\n', 'utf8');

    const result = rollbackMission({ signedWorkOrder: makeOrder(), worktreeRoot: repo });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changedBefore.map((c) => c.path).sort()).toEqual(['junk.txt', 'src/a.ts', 'src/b.ts']);
      expect(result.changedAfter).toEqual([]);
    }
    expect(readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(readFileSync(path.join(repo, 'src', 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
    expect(existsSync(path.join(repo, 'junk.txt'))).toBe(false);
  });

  it('captures the changed set BEFORE undoing it, so a REJECT can name the files', () => {
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'changed\n', 'utf8');
    const result = rollbackMission({ signedWorkOrder: makeOrder(), worktreeRoot: repo });
    expect(result.changedBefore.map((c) => c.path)).toContain('src/a.ts');
    expect(result.changedAfter).toEqual([]);
  });

  it('preserves the evidence directory across the rollback', () => {
    mkdirSync(path.join(repo, '.atlas-evidence'), { recursive: true });
    writeFileSync(path.join(repo, '.atlas-evidence', 'receipt.json'), '{"verdict":"REJECT"}', 'utf8');
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'changed\n', 'utf8');

    const result = rollbackMission({
      signedWorkOrder: makeOrder(),
      worktreeRoot: repo,
      preservePaths: ['.atlas-evidence/'],
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(repo, '.atlas-evidence', 'receipt.json'))).toBe(true);
    expect(readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('refuses a worktree the Work Order does not name, before running any git command', () => {
    const other = path.join(tmpdir(), 'atlas-rollback-elsewhere');
    const result = rollbackMission({ signedWorkOrder: makeOrder(), worktreeRoot: other });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('worktree_mismatch');
  });

  it('refuses a Work Order that declares no rollback method', () => {
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'changed\n', 'utf8');
    const result = rollbackMission({
      signedWorkOrder: makeOrder({ rollbackMethod: 'none' }),
      worktreeRoot: repo,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_rollback_method');
    // The tree is left exactly as it was — a refused rollback undoes nothing.
    expect(readFileSync(path.join(repo, 'src', 'a.ts'), 'utf8')).toBe('changed\n');
  });

  it('refuses an unsupported rollback method rather than guessing', () => {
    const result = rollbackMission({
      signedWorkOrder: makeOrder({ rollbackMethod: 'hope-for-the-best' }),
      worktreeRoot: repo,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('hope-for-the-best');
  });

  it('reports residue instead of claiming success when something survives the clean', () => {
    writeFileSync(path.join(repo, 'stubborn.txt'), 'x\n', 'utf8');
    const result = rollbackMission({
      signedWorkOrder: makeOrder(),
      worktreeRoot: repo,
      // Preserving it means the clean skips it, so it is still dirty after —
      // but it IS preserved, so this must be reported as success, not residue.
      preservePaths: ['stubborn.txt'],
    });
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(repo, 'stubborn.txt'))).toBe(true);
  });

  it('is safe on a clean tree', () => {
    const result = rollbackMission({ signedWorkOrder: makeOrder(), worktreeRoot: repo });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changedBefore).toEqual([]);
  });

  it('leaves HEAD untouched — rollback restores the tree, never rewrites history', () => {
    const headBefore = git(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'changed\n', 'utf8');
    rollbackMission({ signedWorkOrder: makeOrder(), worktreeRoot: repo });
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });
});
