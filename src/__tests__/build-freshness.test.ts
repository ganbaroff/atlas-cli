/**
 * build-freshness.test.ts — the stale-dist startup gate.
 *
 * Regression cover for the defect found during P0 live activation
 * (2026-07-28): the autostarted runner executed `dist\cli.js` from a
 * build that predated src/atlas/queue-auth.ts, so the signing gate was
 * inert and NOTHING said so. These tests pin the detection rule, the
 * deliberate exclusions, and the refusal to guess.
 *
 * Pure fs + synthetic repo layouts — no build, no network, no spawn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareBuildFreshness,
  runnerStartAllowed,
  newestSourceFile,
  isDistEntry,
  inspectBuildFreshness,
  formatStaleDistError,
  type BuildStamp,
} from '../atlas/build-freshness.js';

// ── Helpers ────────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-freshness-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file with an exact mtime (seconds since epoch as a Date). */
function writeAt(path: string, mtimeMs: number, content = '// x\n'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
  const t = new Date(mtimeMs);
  utimesSync(path, t, t);
  return path;
}

const T0 = Date.parse('2026-07-20T10:00:00.000Z');
const HOUR = 3_600_000;

/** Synthetic repo: <root>/dist/cli.js + <root>/src/... */
function makeRepo(opts: { distMtimeMs: number; srcFiles: Array<[string, number]> }): string {
  writeAt(join(root, 'dist', 'cli.js'), opts.distMtimeMs, '// built\n');
  for (const [rel, mtime] of opts.srcFiles) {
    writeAt(join(root, 'src', ...rel.split('/')), mtime);
  }
  return join(root, 'dist', 'cli.js');
}

function stamp(over: Partial<BuildStamp> = {}): BuildStamp {
  return {
    entryPath: '/repo/dist/cli.js',
    distMtimeMs: T0,
    newestSrcFile: '/repo/src/atlas/queue-auth.ts',
    newestSrcMtimeMs: T0 - HOUR,
    ...over,
  };
}

// ── compareBuildFreshness (pure rule) ──────────────────────────────────

describe('compareBuildFreshness', () => {
  it('is fresh when the build is newer than every source', () => {
    const r = compareBuildFreshness(stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 - HOUR }));
    expect(r.status).toBe('fresh');
  });

  it('is stale when any source is newer than the build, and reports the lag', () => {
    const r = compareBuildFreshness(stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 + 3 * HOUR }));
    expect(r.status).toBe('stale');
    if (r.status !== 'stale') throw new Error('unreachable');
    expect(r.lagMs).toBe(3 * HOUR);
    expect(r.newestSrcFile).toBe('/repo/src/atlas/queue-auth.ts');
  });

  it('treats an exactly-equal mtime as fresh (no flapping on same-second builds)', () => {
    const r = compareBuildFreshness(stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 }));
    expect(r.status).toBe('fresh');
  });

  it('flags even a one-millisecond-newer source — no grace window', () => {
    const r = compareBuildFreshness(stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 + 1 }));
    expect(r.status).toBe('stale');
  });
});

describe('runnerStartAllowed', () => {
  it('refuses only stale builds without an explicit override', () => {
    const stale = compareBuildFreshness(
      stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 + HOUR }),
    );
    expect(runnerStartAllowed(stale, false)).toBe(false);
    expect(runnerStartAllowed(stale, true)).toBe(true);
    expect(runnerStartAllowed({ status: 'unknown', reason: 'synthetic' }, false)).toBe(true);
    expect(runnerStartAllowed(compareBuildFreshness(stamp()), false)).toBe(true);
  });
});

// ── newestSourceFile (what counts as a build input) ────────────────────

describe('newestSourceFile', () => {
  it('returns null when there are no source files', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(newestSourceFile(join(root, 'src'))).toBeNull();
  });

  it('finds the newest .ts file across nested directories', () => {
    writeAt(join(root, 'src', 'cli.ts'), T0);
    writeAt(join(root, 'src', 'atlas', 'queue-auth.ts'), T0 + 5 * HOUR);
    writeAt(join(root, 'src', 'atlas', 'cos', 'deep.ts'), T0 + HOUR);

    const newest = newestSourceFile(join(root, 'src'));
    expect(newest?.path).toContain('queue-auth.ts');
    expect(newest?.mtimeMs).toBeCloseTo(T0 + 5 * HOUR, -3);
  });

  it('ignores *.test.ts — editing a test must not demand a rebuild', () => {
    writeAt(join(root, 'src', 'cli.ts'), T0);
    writeAt(join(root, 'src', 'atlas-runner.test.ts'), T0 + 99 * HOUR);

    const newest = newestSourceFile(join(root, 'src'));
    expect(newest?.path).toContain('cli.ts');
  });

  it('ignores whole __tests__ directories', () => {
    writeAt(join(root, 'src', 'cli.ts'), T0);
    writeAt(join(root, 'src', '__tests__', 'helper.ts'), T0 + 99 * HOUR);

    const newest = newestSourceFile(join(root, 'src'));
    expect(newest?.path).toContain('cli.ts');
  });

  it('ignores .d.ts declarations and non-TypeScript files', () => {
    writeAt(join(root, 'src', 'cli.ts'), T0);
    writeAt(join(root, 'src', 'types.d.ts'), T0 + 99 * HOUR);
    writeAt(join(root, 'src', 'notes.md'), T0 + 99 * HOUR);

    const newest = newestSourceFile(join(root, 'src'));
    expect(newest?.path).toContain('cli.ts');
  });

  it('does not crash on a missing directory', () => {
    expect(newestSourceFile(join(root, 'does-not-exist'))).toBeNull();
  });
});

// ── isDistEntry ────────────────────────────────────────────────────────

describe('isDistEntry', () => {
  it('recognises a built entry on both path separators', () => {
    expect(isDistEntry('C:\\repo\\ANUS\\dist\\cli.js')).toBe(true);
    expect(isDistEntry('/home/user/ANUS/dist/cli.js')).toBe(true);
  });

  it('rejects source and unrelated entries', () => {
    expect(isDistEntry('C:\\repo\\ANUS\\src\\cli.ts')).toBe(false);
    expect(isDistEntry('/home/user/ANUS/dist/learning-api.js')).toBe(false);
    expect(isDistEntry('/usr/local/bin/vitest')).toBe(false);
  });
});

// ── inspectBuildFreshness (end to end on a synthetic repo) ─────────────

describe('inspectBuildFreshness', () => {
  it('detects the real defect: a build older than a source file', () => {
    const entry = makeRepo({
      distMtimeMs: T0,
      srcFiles: [['cli.ts', T0 - HOUR], ['atlas/queue-auth.ts', T0 + 6 * HOUR]],
    });

    const r = inspectBuildFreshness({ entryPath: entry });
    expect(r.status).toBe('stale');
    if (r.status !== 'stale') throw new Error('unreachable');
    expect(r.newestSrcFile).toContain('queue-auth.ts');
    expect(r.lagMs).toBeGreaterThan(5 * HOUR);
  });

  it('passes a build newer than every source', () => {
    const entry = makeRepo({
      distMtimeMs: T0 + 10 * HOUR,
      srcFiles: [['cli.ts', T0], ['atlas/queue-auth.ts', T0 + HOUR]],
    });

    expect(inspectBuildFreshness({ entryPath: entry }).status).toBe('fresh');
  });

  it('stays fresh when only a test file is newer than the build', () => {
    const entry = makeRepo({
      distMtimeMs: T0,
      srcFiles: [['cli.ts', T0 - HOUR], ['__tests__/atlas-runner.test.ts', T0 + 50 * HOUR]],
    });

    expect(inspectBuildFreshness({ entryPath: entry }).status).toBe('fresh');
  });

  it('reports unknown — never stale — when not running from dist/cli.js', () => {
    makeRepo({ distMtimeMs: T0, srcFiles: [['cli.ts', T0 + 99 * HOUR]] });

    const r = inspectBuildFreshness({ entryPath: join(root, 'src', 'cli.ts') });
    expect(r.status).toBe('unknown');
    if (r.status !== 'unknown') throw new Error('unreachable');
    expect(r.reason).toMatch(/not running from dist/);
  });

  it('reports unknown when the built entry does not exist', () => {
    const r = inspectBuildFreshness({ entryPath: join(root, 'dist', 'cli.js') });
    expect(r.status).toBe('unknown');
    if (r.status !== 'unknown') throw new Error('unreachable');
    expect(r.reason).toMatch(/not found/);
  });

  it('reports unknown when no src/ sits beside dist/ (packaged deploy)', () => {
    writeAt(join(root, 'dist', 'cli.js'), T0, '// built\n');

    const r = inspectBuildFreshness({ entryPath: join(root, 'dist', 'cli.js') });
    expect(r.status).toBe('unknown');
    if (r.status !== 'unknown') throw new Error('unreachable');
    expect(r.reason).toMatch(/no src\//);
  });

  it('reports unknown when src/ holds no build inputs', () => {
    writeAt(join(root, 'dist', 'cli.js'), T0, '// built\n');
    writeAt(join(root, 'src', 'only.test.ts'), T0 + HOUR);

    const r = inspectBuildFreshness({ entryPath: join(root, 'dist', 'cli.js') });
    expect(r.status).toBe('unknown');
    if (r.status !== 'unknown') throw new Error('unreachable');
    expect(r.reason).toMatch(/no build-input sources/);
  });

  it('defaults to process.argv[1] and is inert under the test runner', () => {
    // Vitest's entry is not dist/cli.js, so the gate must be silent here
    // rather than guessing — proves the default path does not throw.
    expect(inspectBuildFreshness().status).toBe('unknown');
  });
});

// ── formatStaleDistError (the loud part) ───────────────────────────────

describe('formatStaleDistError', () => {
  it('names the offending source, the refusal, and the exact fix', () => {
    const r = compareBuildFreshness(
      stamp({ distMtimeMs: T0, newestSrcMtimeMs: T0 + 26 * HOUR }),
    );
    if (r.status !== 'stale') throw new Error('expected stale');

    const msg = formatStaleDistError(r, '/repo');
    expect(msg).toMatch(/REFUSING TO START/);
    expect(msg).toContain('queue-auth.ts');
    expect(msg).toContain('npm run build');
    expect(msg).toMatch(/ATLAS_ALLOW_STALE_DIST/);
    expect(msg).toMatch(/26h newer/);
  });
});
