/**
 * CLI: atlas goal context — intake → resolve → assemble (read-only).
 * Atlas READY/dirty matrix uses injected resolve probe — no live OneDrive dependency.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGoalContext } from '../atlas/context-assembly/pipeline.js';
import { memoryReader, type CatalogEntry } from '../atlas/context-assembly/index.js';
import {
  getProjectById,
  withRegistryOverrides,
  type FsEntryProbe,
  type PathProbe,
} from '../atlas/goal-intake/index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(ROOT, 'src', 'cli.ts');
const STATE_DIR = join(ROOT, 'state');

const FIXTURE_ANUS = 'C:\\Projects\\_fixtures\\ANUS-clean';
const ROOTS = ['C:\\Projects', 'C:\\Projects\\_fixtures'] as const;
const NOW = '2026-08-04T12:00:00.000Z';

interface ChildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): ChildResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
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

function gitProbe(dirty = false): FsEntryProbe['git'] {
  return {
    isGit: true,
    root: FIXTURE_ANUS,
    branch: 'main',
    head: 'deadbeef',
    dirty,
    remoteUrl: 'https://github.com/example/anus.git',
  };
}

function entry(dirty = false): FsEntryProbe {
  return {
    exists: true,
    isDirectory: true,
    pathType: 'git-repository',
    git: gitProbe(dirty),
  };
}

function makeProbe(dirty = false): PathProbe {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return {
    probePath(absPath: string) {
      if (norm(absPath) === norm(FIXTURE_ANUS)) return entry(dirty);
      return {
        exists: false,
        isDirectory: false,
        pathType: 'missing',
        git: { isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null },
      };
    },
    listChildDirs() {
      return [];
    },
  };
}

function atlasResolveOpts(dirty = false) {
  const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
    expectedPathCandidates: [
      { path: FIXTURE_ANUS, role: 'canonical', pathType: 'git-repository' },
    ],
    projectPath: FIXTURE_ANUS,
  });
  return {
    probe: makeProbe(dirty),
    registryProject: reg,
    approvedRoots: ROOTS,
  };
}

const ATLAS_MSG = 'Проверь текущее состояние Atlas. Ничего не меняй.';
const INTEGRONIX_MSG = 'Проведи полный аудит integronix.az. Ничего не меняй.';

const emptyCatalog: CatalogEntry[] = [];

describe('atlas goal context — isolated pipeline', () => {
  it('Atlas context READY_TO_PLAN with clean injected fixture', () => {
    const { envelope, exitCode } = runGoalContext({
      message: ATLAS_MSG,
      resolve: atlasResolveOpts(false),
      projectPathOverride: null,
      assemble: { catalog: emptyCatalog, nowIso: NOW, reader: memoryReader({}) },
    });
    expect(exitCode).toBe(0);
    expect(envelope.finalStatus).toBe('READY_TO_PLAN');
    expect(envelope.projectExecutionReady).toBe(true);
    expect(envelope.originalCeoMessage).toBe(ATLAS_MSG);
    expect(envelope.contextPack.assembledAtIso).toBe(NOW);
    expect(envelope.goalContract.selectedProject.projectId).toBe('prj_anus_atlas');
  });

  it('Atlas dirty fixture → NEEDS_APPROVAL', () => {
    const { envelope, exitCode } = runGoalContext({
      message: ATLAS_MSG,
      resolve: atlasResolveOpts(true),
      projectPathOverride: null,
      assemble: { catalog: emptyCatalog, nowIso: NOW, reader: memoryReader({}) },
    });
    expect(exitCode).toBe(3);
    expect(envelope.finalStatus).toBe('NEEDS_APPROVAL');
  });

  it('pack reproducibility with same nowIso + inputs', () => {
    const opts = {
      message: ATLAS_MSG,
      resolve: atlasResolveOpts(false),
      projectPathOverride: null as string | null,
      assemble: { catalog: emptyCatalog, nowIso: NOW, reader: memoryReader({}) },
    };
    const a = runGoalContext(opts).envelope.contextPack;
    const b = runGoalContext(opts).envelope.contextPack;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.assembledAtIso).toBe(NOW);
    expect(a.selectedSources.map((s) => s.contentHash)).toEqual(
      b.selectedSources.map((s) => s.contentHash),
    );
  });

  it('stale source loses to current receipt', () => {
    const catalog: CatalogEntry[] = [
      {
        id: 'hist',
        pathOrUrl: 'mem://hist',
        sourceType: 'personal-memory',
        authority: 'historical',
        historical: true,
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['atlas', 'состояни'],
        personalMemory: true,
      },
      {
        id: 'receipt',
        pathOrUrl: 'mem://receipt',
        sourceType: 'receipt',
        authority: 'recent-receipt',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['atlas', 'состояни'],
        personalMemory: false,
      },
    ];
    const { envelope } = runGoalContext({
      message: ATLAS_MSG,
      resolve: atlasResolveOpts(false),
      projectPathOverride: null,
      assemble: {
        catalog,
        nowIso: NOW,
        reader: memoryReader({
          'mem://hist': { content: 'HISTORICAL: everything broken' },
          'mem://receipt': { content: 'RECEIPT: Project Resolution MERGED 2026-08-04' },
        }),
        budgetBytes: 32_000,
      },
    });
    expect(envelope.assumptions.concat(envelope.contextPack.constraints).join(' ')).toMatch(
      /receipt overrides|Precedence/i,
    );
  });

  it('missing authority fails closed', () => {
    expect(() =>
      runGoalContext({
        message: ATLAS_MSG,
        resolve: atlasResolveOpts(false),
        projectPathOverride: null,
        assemble: {
          catalog: [
            {
              id: 'bad',
              pathOrUrl: 'mem://bad',
              sourceType: 'personal-memory',
              authority: 'unknown',
              projectIds: ['prj_anus_atlas'],
              relevanceHints: ['atlas'],
              personalMemory: true,
            },
          ],
          reader: memoryReader({ 'mem://bad': { content: 'x' } }),
          failUnknownAuthority: true,
        },
      }),
    ).toThrow(/unknown authority/i);
  });
});

describe('atlas goal context CLI (wiring; Integronix + fail-closed)', () => {
  it('Integronix read-only audit ready while repo execution blocked', () => {
    const res = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    expect(res.status).toBe(0);
    const out = parseOnlyJson(res.stdout);
    expect(out.finalStatus).toBe('READY_TO_PLAN');
    expect(out.readOnlyTargetReady).toBe(true);
    expect(out.projectExecutionReady).toBe(false);
    expect(out.projectResolution).toMatchObject({ status: 'BLOCKED', canonicalPath: null });
    expect(String(out.recommendedNextAction)).toMatch(/readonly|EXECUTION remains blocked/i);
    const pack = out.contextPack as Record<string, unknown>;
    expect(pack.externalTarget).toBe('https://integronix.az/');
    expect(typeof pack.assembledAtIso).toBe('string');
    const serialized = JSON.stringify(out);
    const invented = serialized.match(/Projects\\\\integronix[^"\\]*/gi) ?? [];
    for (const m of invented) {
      expect(m.toLowerCase()).toContain('archive');
    }
  });

  it('conflicting sources exposed (Integronix)', () => {
    const res = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    const out = parseOnlyJson(res.stdout);
    const contradictions = out.contradictions as string[];
    expect(contradictions.length + (out.reasons as string[]).length).toBeGreaterThan(0);
  });

  it('irrelevant personal memory excluded (CLI Integronix envelope)', () => {
    const res = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    const out = parseOnlyJson(res.stdout);
    const sources = out.selectedSources as Array<Record<string, unknown>>;
    expect(sources.some((s) => /voice\.md/i.test(String(s.pathOrUrl)))).toBe(false);
  });

  it('context budget enforced', () => {
    const res = runCli([
      'goal',
      'context',
      '--message',
      INTEGRONIX_MSG,
      '--json',
      '--budget',
      '2500',
    ]);
    expect([0, 2, 3]).toContain(res.status);
    const out = parseOnlyJson(res.stdout);
    expect(Number(out.contextBudgetUsed)).toBeLessThanOrEqual(Number(out.contextBudgetBytes));
    expect(Number(out.contextBudgetBytes)).toBe(2500);
  });

  it('original CEO message preserved', () => {
    const msg = `  ${INTEGRONIX_MSG}  `;
    const res = runCli(['goal', 'context', '--message', msg, '--json']);
    const out = parseOnlyJson(res.stdout);
    expect(out.originalCeoMessage).toBe(msg);
    const contract = out.goalContract as Record<string, unknown>;
    expect(contract.originalCeoMessage).toBe(msg);
  });

  it('stable JSON schema keys across runs', () => {
    const a = parseOnlyJson(runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']).stdout);
    const b = parseOnlyJson(runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']).stdout);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.finalStatus).toBe(b.finalStatus);
    expect(a.schemaVersion).toBe('atlas-goal-context/v0');
    expect(a.projectExecutionReady).toBe(false);
  });

  it('no filesystem mutation', () => {
    const before = {
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }),
      head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      stateDir: safeReaddir(STATE_DIR),
    };
    const res = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    expect(res.status).toBe(0);
    const after = {
      status: execFileSync('git', ['status', '--porcelain=v1'], { cwd: ROOT, encoding: 'utf8' }),
      head: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      stateDir: safeReaddir(STATE_DIR),
    };
    expect(after.status).toBe(before.status);
    expect(after.head).toBe(before.head);
    expect(after.stateDir).toEqual(before.stateDir);
  });

  it('CLI exit-code matrix', () => {
    const integ = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    const bad = runCli(['goal', 'context', '--message', '', '--json']);
    expect(integ.status).toBe(0);
    expect(bad.status).toBe(1);
  });
});
