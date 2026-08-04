import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(ROOT, 'src', 'cli.ts');
const STATE_DIR = join(ROOT, 'state');

interface ChildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): ChildResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseOnlyJson(value: string): Record<string, unknown> {
  return JSON.parse(value.trim()) as Record<string, unknown>;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const ATLAS_MSG = 'Проверь текущее состояние Atlas. Ничего не меняй.';
const ATLAS_ALIAS_MSG = 'Проверь состояние проекта ANUS. Ничего не меняй.';
const INTEGRONIX_MSG = 'Проведи аудит integronix.az. Ничего не меняй.';
const UNKNOWN_MSG = 'Почини проект Зюзюблик.';

// The ANUS repo itself is the canonical project the ATLAS_MSG resolves to, so its
// live git working-tree cleanliness is an observed input to the brain's own
// dirty-worktree safety gate (exec-graph refuses READY on a dirty canonical repo —
// it requires CEO approval before executing on top of possibly-conflicting local
// work). That gate is a real safety property, not a bug: when this suite itself is
// run from an uncommitted checkout (e.g. mid-fix, before a verifier commits), the
// ATLAS_MSG case legitimately resolves NEEDS_APPROVAL/exit 3 instead of READY/exit 0.
// Hardcoding one branch made T1/T2/T6/T8 flaky across commit boundaries; assert the
// safety invariants (originalCeoMessage preservation, exit-code distinctness,
// read-only guarantee, correct projectId) while deriving the ready-vs-gated branch
// from the same git state the CLI itself observes.
function isCanonicalTreeDirty(): boolean {
  return execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
}

describe('atlas goal resolve CLI', () => {
  it('T1: resolves Atlas/ANUS message to READY (clean tree) or NEEDS_APPROVAL (dirty tree)', () => {
    const dirty = isCanonicalTreeDirty();
    const res = runCli(['goal', 'resolve', '--message', ATLAS_MSG, '--json']);
    expect(res.status).toBe(dirty ? 3 : 0);
    const out = parseOnlyJson(res.stdout);
    expect(out.finalStatus).toBe(dirty ? 'needs-approval' : 'ready');
    const resolution = out.projectResolution as Record<string, unknown>;
    expect(resolution.status).toBe(dirty ? 'NEEDS_APPROVAL' : 'READY');
    if (!dirty) {
      expect(String(resolution.canonicalPath)).toMatch(/GitHub\\ANUS$/i);
    }
    expect(resolution.pathType).toBe('git-repository');
    const contract = out.goalContract as Record<string, unknown>;
    expect(contract.originalCeoMessage).toBe(ATLAS_MSG);
  });

  it('T2: a different alias resolves to the same projectId as T1', () => {
    const dirty = isCanonicalTreeDirty();
    const res = runCli(['goal', 'resolve', '--message', ATLAS_ALIAS_MSG, '--json']);
    expect(res.status).toBe(dirty ? 3 : 0);
    const out = parseOnlyJson(res.stdout);
    const contract = out.goalContract as Record<string, unknown>;
    const selectedProject = contract.selectedProject as Record<string, unknown>;
    expect(selectedProject.projectId).toBe('prj_anus_atlas');
    const resolution = out.projectResolution as Record<string, unknown>;
    expect(resolution.projectId).toBe('prj_anus_atlas');
  });

  it('T3: Integronix resolves BLOCKED with no invented path, exit 2', () => {
    const res = runCli(['goal', 'resolve', '--message', INTEGRONIX_MSG, '--json']);
    expect(res.status).toBe(2);
    const out = parseOnlyJson(res.stdout);
    expect(out.finalStatus).toBe('blocked');
    const resolution = out.projectResolution as Record<string, unknown>;
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.canonicalPath).toBeNull();
    expect(typeof resolution.recommendedNextAction).toBe('string');
    expect((resolution.recommendedNextAction as string).length).toBeGreaterThan(0);
    const serialized = JSON.stringify(out);
    // No invented live path — any Projects\integronix reference must be the archive candidate.
    const matches = serialized.match(/Projects\\\\integronix[^"]*/gi) ?? [];
    for (const m of matches) {
      expect(m.toLowerCase()).toContain('archive');
    }
  });

  it('T4: unknown project resolves to a fail-closed status, no invented path', () => {
    const res = runCli(['goal', 'resolve', '--message', UNKNOWN_MSG, '--json']);
    const out = parseOnlyJson(res.stdout);
    // Document actual brain behavior: unknown-project contract status short-circuits
    // resolveProjectPath's prj_unknown branch, which itself reports BLOCKED.
    expect(out.finalStatus).toBe('unknown-project');
    expect(res.status).toBe(4);
    const resolution = out.projectResolution as Record<string, unknown>;
    expect(resolution.canonicalPath).toBeNull();
    const contract = out.goalContract as Record<string, unknown>;
    const selectedProject = contract.selectedProject as Record<string, unknown>;
    expect(selectedProject.projectId).toBe('prj_unknown');
  });

  it('T5: malformed/empty --message fails closed, exit 1, no stack trace on stdout', () => {
    const res = runCli(['goal', 'resolve', '--message', '']);
    expect(res.status).toBe(1);
    expect(res.stdout).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    const err = parseOnlyJson(res.stderr);
    expect(typeof err.error).toBe('string');
  });

  it('T6: read-only guarantee — repo git state and state/ dir unchanged', () => {
    const before = {
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }),
      head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      stateDir: safeReaddir(STATE_DIR),
    };
    const dirty = isCanonicalTreeDirty();
    const res = runCli(['goal', 'resolve', '--message', ATLAS_MSG, '--json']);
    expect(res.status).toBe(dirty ? 3 : 0);
    const after = {
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }),
      head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      stateDir: safeReaddir(STATE_DIR),
    };
    expect(after.status).toBe(before.status);
    expect(after.head).toBe(before.head);
    expect(after.stateDir).toEqual(before.stateDir);
  });

  it('T7: JSON output is stable across repeated runs (git head/branch are stable here)', () => {
    const a = parseOnlyJson(runCli(['goal', 'resolve', '--message', ATLAS_MSG, '--json']).stdout);
    const b = parseOnlyJson(runCli(['goal', 'resolve', '--message', ATLAS_MSG, '--json']).stdout);
    // No volatile fields are known to exist in this envelope (no timestamps emitted);
    // git head/branch are stable for a clean tree during this run. Assert deep equality.
    expect(b).toEqual(a);
  });

  it('T8: exit codes matrix — ready=0|needs-approval=3 (dirty tree), blocked=2, invalid=1', () => {
    const dirty = isCanonicalTreeDirty();
    const cases: Array<{ args: string[]; expected: number }> = [
      { args: ['goal', 'resolve', '--message', ATLAS_MSG, '--json'], expected: dirty ? 3 : 0 },
      { args: ['goal', 'resolve', '--message', INTEGRONIX_MSG, '--json'], expected: 2 },
      { args: ['goal', 'resolve', '--message', '', '--json'], expected: 1 },
    ];
    for (const { args, expected } of cases) {
      const res = runCli(args);
      expect(res.status).toBe(expected);
    }
  });
});
