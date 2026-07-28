/**
 * atlas/build-freshness.ts — is the running dist/ build older than src/?
 *
 * Why this exists (defect found live 2026-07-28, P0 activation):
 * the Windows scheduled task "AtlasRunner" launches `node dist\cli.js
 * runner start`, and nothing in the merge/deploy path rebuilds dist/.
 * The local runner had been executing a build that predated
 * src/atlas/queue-auth.ts entirely — the P0.1 signing gate was inert and
 * emitted no signal at all. A stale build is indistinguishable from a
 * working one at runtime, so the only defence is to check at startup.
 *
 * Policy: prefer a LOUD REFUSAL over a silent stale run. `runner start`
 * exits non-zero on staleness unless the operator explicitly opts out.
 *
 * The check is inert (status 'unknown') whenever it cannot be trusted:
 *   - not running from dist/cli.js (dev via tsx — source IS the build)
 *   - no src/ next to dist/ (a packaged deploy that ships no sources)
 * Never guess. An unknown answer is reported as unknown.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────

export interface BuildStamp {
  /** Absolute path of the built entry actually being executed. */
  entryPath: string;
  /** mtime of that built file. */
  distMtimeMs: number;
  /** Newest non-test source file feeding that build. */
  newestSrcFile: string;
  newestSrcMtimeMs: number;
}

export type BuildFreshness =
  | ({ status: 'fresh' } & BuildStamp)
  | ({ status: 'stale'; lagMs: number } & BuildStamp)
  | { status: 'unknown'; reason: string };

// ── Source walking ─────────────────────────────────────────────────────

/**
 * Test files never reach the bundle (tsup builds src/cli.ts +
 * src/learning-api.ts and their import graph), so counting them would
 * demand a rebuild after every test edit. A gate that cries wolf gets
 * ignored, which is the failure mode this module exists to prevent.
 */
function isBuildInput(name: string): boolean {
  if (!name.endsWith('.ts')) return false;
  if (name.endsWith('.d.ts')) return false;
  if (name.endsWith('.test.ts')) return false;
  return true;
}

function isSkippedDir(name: string): boolean {
  return name === '__tests__' || name === 'node_modules' || name.startsWith('.');
}

/** Newest build-input source file under `srcDir`, or null if there are none. */
export function newestSourceFile(
  srcDir: string,
): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip rather than crash a startup gate
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile() || !isBuildInput(entry.name)) continue;
      try {
        const { mtimeMs } = statSync(full);
        if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
      } catch {
        // vanished between readdir and stat — ignore
      }
    }
  };

  walk(srcDir);
  return best;
}

// ── Pure comparison ────────────────────────────────────────────────────

/**
 * Pure staleness rule: the build is stale iff a source file is strictly
 * newer than the built artifact. No grace window — a build always writes
 * dist AFTER reading src, so a newer source means an unbuilt change.
 * Erring toward "stale" is deliberate: a false alarm costs one
 * `npm run build`, a false all-clear costs a silently inert safety gate.
 */
export function compareBuildFreshness(stamp: BuildStamp): BuildFreshness {
  if (stamp.newestSrcMtimeMs > stamp.distMtimeMs) {
    return {
      status: 'stale',
      lagMs: stamp.newestSrcMtimeMs - stamp.distMtimeMs,
      ...stamp,
    };
  }
  return { status: 'fresh', ...stamp };
}

/** Only an explicit override permits starting from a known-stale build. */
export function runnerStartAllowed(
  freshness: BuildFreshness,
  override: boolean,
): boolean {
  return freshness.status !== 'stale' || override;
}

// ── Production wiring ──────────────────────────────────────────────────

const DIST_ENTRY_RE = /[\\/]dist[\\/]cli\.js$/;

/** True when this process was launched as `node .../dist/cli.js`. */
export function isDistEntry(entryPath: string): boolean {
  return DIST_ENTRY_RE.test(entryPath);
}

/**
 * Inspect the build the CURRENT process is running.
 *
 * `entryPath` defaults to process.argv[1] — the script node was told to
 * run. Injectable so tests can point at a synthetic repo layout.
 */
export function inspectBuildFreshness(
  opts: { entryPath?: string } = {},
): BuildFreshness {
  const rawEntry = opts.entryPath ?? process.argv[1];
  if (!rawEntry) {
    return { status: 'unknown', reason: 'no entry path (process.argv[1] unset)' };
  }

  const entryPath = resolve(rawEntry);
  if (!isDistEntry(entryPath)) {
    return {
      status: 'unknown',
      reason: `not running from dist/cli.js (entry: ${entryPath}) — source is the build`,
    };
  }
  if (!existsSync(entryPath)) {
    return { status: 'unknown', reason: `built entry not found: ${entryPath}` };
  }

  const repoRoot = dirname(dirname(entryPath));
  const srcDir = join(repoRoot, 'src');
  if (!existsSync(srcDir)) {
    return {
      status: 'unknown',
      reason: `no src/ beside dist/ at ${repoRoot} — cannot compare (packaged deploy?)`,
    };
  }

  let distMtimeMs: number;
  try {
    distMtimeMs = statSync(entryPath).mtimeMs;
  } catch (err) {
    return {
      status: 'unknown',
      reason: `cannot stat ${entryPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const newest = newestSourceFile(srcDir);
  if (!newest) {
    return { status: 'unknown', reason: `no build-input sources under ${srcDir}` };
  }

  return compareBuildFreshness({
    entryPath,
    distMtimeMs,
    newestSrcFile: newest.path,
    newestSrcMtimeMs: newest.mtimeMs,
  });
}

// ── Operator-facing message ────────────────────────────────────────────

function humanAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Loud, actionable refusal text. Names the file that proves staleness. */
export function formatStaleDistError(
  f: Extract<BuildFreshness, { status: 'stale' }>,
  repoRootHint?: string,
): string {
  const root = repoRootHint ?? dirname(dirname(f.entryPath));
  let rel = f.newestSrcFile;
  try {
    rel = relative(root, f.newestSrcFile) || f.newestSrcFile;
  } catch {
    /* keep absolute */
  }
  return [
    '[runner] REFUSING TO START — the built dist/ is older than src/.',
    `         built entry : ${f.entryPath}`,
    `                       built ${new Date(f.distMtimeMs).toISOString()}`,
    `         newest source: ${rel}`,
    `                       edited ${new Date(f.newestSrcMtimeMs).toISOString()} (${humanAge(f.lagMs)} newer)`,
    '',
    '  Running a stale build silently executes code that predates your changes —',
    '  safety gates you believe are live may not exist in this binary at all.',
    '',
    '  Fix:  npm run build     (then start the runner again)',
    '  Override (UNSAFE): --allow-stale-dist  or  ATLAS_ALLOW_STALE_DIST=1',
  ].join('\n');
}
