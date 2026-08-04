/**
 * atlas goal resolve — isolated from live OneDrive ANUS dirtiness.
 * READY / dirty / blocked matrix uses injected PathProbe (+ optional temp git fixture).
 * CLI spawn covers fail-closed / Integronix / unknown wiring only.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import {
  interpretCeoGoal,
  resolveProjectPath,
  getProjectById,
  withRegistryOverrides,
  normalizeAtlasPath,
  type FsEntryProbe,
  type PathProbe,
} from '../atlas/goal-intake/index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(ROOT, 'src', 'cli.ts');
const STATE_DIR = join(ROOT, 'state');

const ATLAS_MSG = 'Проверь текущее состояние Atlas. Ничего не меняй.';
const ATLAS_ALIAS_MSG = 'Проверь состояние проекта ANUS. Ничего не меняй.';
const INTEGRONIX_MSG = 'Проведи аудит integronix.az. Ничего не меняй.';
const UNKNOWN_MSG = 'Почини проект Зюзюблик.';

const FIXTURE_ANUS = 'C:\\Projects\\_fixtures\\ANUS-clean';
const ROOTS = ['C:\\Projects', 'C:\\Projects\\_fixtures'] as const;

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

function gitProbe(
  overrides: Partial<FsEntryProbe['git']> = {},
): FsEntryProbe['git'] {
  return {
    isGit: true,
    root: overrides.root ?? FIXTURE_ANUS,
    branch: overrides.branch ?? 'main',
    head: overrides.head ?? 'deadbeef',
    dirty: overrides.dirty ?? false,
    remoteUrl: overrides.remoteUrl ?? 'https://github.com/example/anus.git',
  };
}

function entry(partial: Partial<FsEntryProbe> = {}): FsEntryProbe {
  const exists = partial.exists ?? true;
  return {
    exists,
    isDirectory: partial.isDirectory ?? exists,
    pathType: partial.pathType ?? (exists ? 'git-repository' : 'missing'),
    git: partial.git ?? (exists
      ? gitProbe()
      : { isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null }),
  };
}

function makeProbe(map: Record<string, FsEntryProbe>): PathProbe {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return {
    probePath(absPath: string) {
      const hit = Object.entries(map).find(([k]) => norm(k) === norm(absPath));
      if (hit) return hit[1];
      return entry({
        exists: false,
        pathType: 'missing',
        git: { isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null },
      });
    },
    listChildDirs() {
      return [];
    },
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('atlas goal resolve — injected probe (no live OneDrive)', () => {
  it('T1: clean fixture → READY exit semantics via resolve API', () => {
    const probe = makeProbe({
      [FIXTURE_ANUS]: entry({ git: gitProbe({ dirty: false }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [
        { path: FIXTURE_ANUS, role: 'canonical', pathType: 'git-repository' },
      ],
      projectPath: FIXTURE_ANUS,
    });
    const contract = {
      ...interpretCeoGoal({ ceoMessage: ATLAS_MSG }),
      projectPath: null,
    };
    const { resolution } = resolveProjectPath(contract, {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('READY');
    expect(resolution.canonicalPath).toBe(FIXTURE_ANUS);
    expect(resolution.workingTree).toBe('clean');
    expect(contract.originalCeoMessage).toBe(ATLAS_MSG);
  });

  it('T1b: dirty fixture → NEEDS_APPROVAL (same path, requireClean)', () => {
    const probe = makeProbe({
      [FIXTURE_ANUS]: entry({ git: gitProbe({ dirty: true }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [
        { path: FIXTURE_ANUS, role: 'canonical', pathType: 'git-repository' },
      ],
      projectPath: FIXTURE_ANUS,
    });
    const { resolution } = resolveProjectPath(
      { ...interpretCeoGoal({ ceoMessage: ATLAS_MSG }), projectPath: null },
      {
        probe,
        registryProject: reg,
        approvedRoots: ROOTS,
      },
    );
    expect(resolution.status).toBe('NEEDS_APPROVAL');
    expect(resolution.workingTree).toBe('dirty');
  });

  it('T2: alias resolves to same projectId', () => {
    const a = interpretCeoGoal({ ceoMessage: ATLAS_MSG });
    const b = interpretCeoGoal({ ceoMessage: ATLAS_ALIAS_MSG });
    expect(a.selectedProject.projectId).toBe('prj_anus_atlas');
    expect(b.selectedProject.projectId).toBe('prj_anus_atlas');
  });

  it('Windows path normalization: C:\\… equals c:/…', () => {
    const a = normalizeAtlasPath('C:\\Projects\\_fixtures\\ANUS-clean');
    const b = normalizeAtlasPath('c:/Projects/_fixtures/ANUS-clean');
    expect(a).toBe(b);
  });

  it('isolated temp git fixture → READY without OneDrive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-resolve-'));
    tempDirs.push(dir);
    execFileSync('git', ['init'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    execFileSync('git', ['config', 'user.name', 'test'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    writeFileSync(join(dir, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', '.'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const probe = makeProbe({
      [dir]: entry({
        git: gitProbe({ root: dir, head, dirty: false }),
      }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [{ path: dir, role: 'canonical', pathType: 'git-repository' }],
      projectPath: dir,
    });
    const { resolution } = resolveProjectPath(
      { ...interpretCeoGoal({ ceoMessage: ATLAS_MSG }), projectPath: null },
      {
        probe,
        registryProject: reg,
        approvedRoots: [tmpdir(), dir],
      },
    );
    expect(resolution.status).toBe('READY');
    expect(resolution.gitHead).toBe(head);
  });
});

describe('atlas goal resolve CLI (wiring; no dirtiness gate on live ANUS)', () => {
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
    const matches = serialized.match(/Projects\\\\integronix[^"]*/gi) ?? [];
    for (const m of matches) {
      expect(m.toLowerCase()).toContain('archive');
    }
  });

  it('T4: unknown project resolves fail-closed, exit 4', () => {
    const res = runCli(['goal', 'resolve', '--message', UNKNOWN_MSG, '--json']);
    const out = parseOnlyJson(res.stdout);
    expect(out.finalStatus).toBe('unknown-project');
    expect(res.status).toBe(4);
    const resolution = out.projectResolution as Record<string, unknown>;
    expect(resolution.canonicalPath).toBeNull();
    const contract = out.goalContract as Record<string, unknown>;
    const selectedProject = contract.selectedProject as Record<string, unknown>;
    expect(selectedProject.projectId).toBe('prj_unknown');
  });

  it('T5: malformed/empty --message fails closed, exit 1', () => {
    const res = runCli(['goal', 'resolve', '--message', '']);
    expect(res.status).toBe(1);
    expect(res.stdout).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    // stderr may include unrelated [atlas] noise from host processes; require an error object somewhere
    const jsonMatch = res.stderr.match(/\{[\s\S]*"error"[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();
    const err = JSON.parse(jsonMatch![0]!) as Record<string, unknown>;
    expect(typeof err.error).toBe('string');
  });

  it('T6: CLI read-only — this worktree HEAD/state/ unchanged (not OneDrive probe)', () => {
    const before = {
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }),
      head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      stateDir: safeReaddir(STATE_DIR),
    };
    const res = runCli(['goal', 'resolve', '--message', INTEGRONIX_MSG, '--json']);
    expect(res.status).toBe(2);
    const after = {
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }),
      head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      stateDir: safeReaddir(STATE_DIR),
    };
    expect(after.status).toBe(before.status);
    expect(after.head).toBe(before.head);
    expect(after.stateDir).toEqual(before.stateDir);
  });

  it('T7: Integronix JSON stable across runs', () => {
    const a = parseOnlyJson(runCli(['goal', 'resolve', '--message', INTEGRONIX_MSG, '--json']).stdout);
    const b = parseOnlyJson(runCli(['goal', 'resolve', '--message', INTEGRONIX_MSG, '--json']).stdout);
    expect(b).toEqual(a);
  });

  it('T8: exit codes — blocked=2, invalid=1 (Atlas READY asserted via probe suite)', () => {
    expect(runCli(['goal', 'resolve', '--message', INTEGRONIX_MSG, '--json']).status).toBe(2);
    expect(runCli(['goal', 'resolve', '--message', '', '--json']).status).toBe(1);
  });
});
