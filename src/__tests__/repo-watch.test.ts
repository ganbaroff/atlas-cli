import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkRepo, formatDigest, decideNotify, signature, type RepoStatus } from '../atlas/repo-watch.js';

const ANUS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const A: RepoStatus[] = [
  { root: '/x', name: 'repoA', ok: true, branch: 'main', dirty: 0, ahead: 0, lastCommit: 'abc123 initial' },
];
const B: RepoStatus[] = [{ ...A[0], dirty: 2 }]; // changed (dirty)

describe('repo_watch checkRepo (read-only, real repo)', () => {
  it('reports status for the ANUS repo itself', () => {
    const s = checkRepo(ANUS_ROOT);
    expect(s.ok).toBe(true);
    expect(typeof s.branch).toBe('string');
    expect(s.lastCommit && s.lastCommit.length).toBeGreaterThan(0);
    expect(typeof s.dirty).toBe('number');
  });

  it('fails closed (ok:false) for a non-repo path', () => {
    const s = checkRepo(tmpdir());
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
  });
});

describe('repo_watch digest', () => {
  it('formats a compact digest', () => {
    const d = formatDigest(A);
    expect(d).toContain('Repo watch:');
    expect(d).toContain('repoA');
    expect(d).toContain('branch main');
  });
});

describe('repo_watch decideNotify (change + rate-limit gate)', () => {
  let stateFile: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-rw-'));
    stateFile = join(dir, 'state.json');
    process.env.ATLAS_REPO_WATCH_STATE = stateFile;
  });
  afterEach(() => {
    delete process.env.ATLAS_REPO_WATCH_STATE;
    try { rmSync(dirname(stateFile), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const now = 1_000_000_000_000;

  it('notifies on first run (no prior state)', () => {
    const d = decideNotify(A, 15, now);
    expect(d.notify).toBe(true);
  });

  it('does NOT notify when nothing changed', () => {
    writeFileSync(stateFile, JSON.stringify({ sig: signature(A), lastNotifyMs: now }));
    const d = decideNotify(A, 15, now + 60_000);
    expect(d.notify).toBe(false);
    expect(d.reason).toMatch(/no change/);
  });

  it('rate-limits a change that arrives before interval_min', () => {
    writeFileSync(stateFile, JSON.stringify({ sig: signature(A), lastNotifyMs: now }));
    const d = decideNotify(B, 15, now + 60_000); // 1 min < 15
    expect(d.notify).toBe(false);
    expect(d.reason).toMatch(/rate-limited/);
  });

  it('notifies a change once interval_min has elapsed', () => {
    writeFileSync(stateFile, JSON.stringify({ sig: signature(A), lastNotifyMs: now }));
    const d = decideNotify(B, 15, now + 16 * 60_000);
    expect(d.notify).toBe(true);
  });
});
