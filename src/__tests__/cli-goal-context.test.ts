/**
 * CLI: atlas goal context — intake → resolve → assemble (read-only).
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGoalContext } from '../atlas/context-assembly/pipeline.js';
import { memoryReader, type CatalogEntry } from '../atlas/context-assembly/index.js';

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

const ATLAS_MSG = 'Проверь текущее состояние Atlas. Ничего не меняй.';
const INTEGRONIX_MSG = 'Проведи полный аудит integronix.az. Ничего не меняй.';

describe('atlas goal context CLI', () => {
  it('Atlas context ready (or needs-approval if dirty tree)', () => {
    const res = runCli(['goal', 'context', '--message', ATLAS_MSG, '--json']);
    expect([0, 3]).toContain(res.status);
    const out = parseOnlyJson(res.stdout);
    expect(out.schemaVersion).toBe('atlas-goal-context/v0');
    expect(out.originalCeoMessage).toBe(ATLAS_MSG);
    expect(['READY_TO_PLAN', 'NEEDS_APPROVAL']).toContain(out.finalStatus);
    // Exit codes must track finalStatus (not the worktree porcelain of this test checkout).
    expect(res.status).toBe(out.finalStatus === 'READY_TO_PLAN' ? 0 : 3);
    if (out.projectExecutionReady === true) {
      expect(out.finalStatus).toBe('READY_TO_PLAN');
      const resolution = out.projectResolution as Record<string, unknown>;
      expect(String(resolution.canonicalPath)).toMatch(/GitHub\\ANUS$/i);
    }
    const contract = out.goalContract as Record<string, unknown>;
    expect((contract.selectedProject as Record<string, unknown>).projectId).toBe('prj_anus_atlas');
    const sources = out.selectedSources as Array<Record<string, unknown>>;
    expect(sources.every((s) => typeof s.pathOrUrl === 'string' && typeof s.contentHash === 'string')).toBe(
      true,
    );
    // No unrelated personal biography dump: voice.md excluded
    expect(sources.some((s) => String(s.pathOrUrl).toLowerCase().includes('voice.md'))).toBe(false);
  });

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
    const serialized = JSON.stringify(out);
    const invented = serialized.match(/Projects\\\\integronix[^"\\]*/gi) ?? [];
    for (const m of invented) {
      expect(m.toLowerCase()).toContain('archive');
    }
  });

  it('stale source loses to current receipt (pipeline unit)', () => {
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
      assemble: {
        catalog,
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

  it('conflicting sources are exposed (Integronix historical vs resolution)', () => {
    const res = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    const out = parseOnlyJson(res.stdout);
    const contradictions = out.contradictions as string[];
    // At minimum resolution conflicts / archive insufficiency surface
    expect(contradictions.length + (out.reasons as string[]).length).toBeGreaterThan(0);
  });

  it('irrelevant personal memory excluded', () => {
    const res = runCli(['goal', 'context', '--message', ATLAS_MSG, '--json']);
    const out = parseOnlyJson(res.stdout);
    const sources = out.selectedSources as Array<Record<string, unknown>>;
    expect(sources.some((s) => /voice\.md/i.test(String(s.pathOrUrl)))).toBe(false);
  });

  it('context budget enforced', () => {
    const res = runCli([
      'goal',
      'context',
      '--message',
      ATLAS_MSG,
      '--json',
      '--budget',
      '2500',
    ]);
    expect([0, 2, 3]).toContain(res.status);
    const out = parseOnlyJson(res.stdout);
    expect(Number(out.contextBudgetUsed)).toBeLessThanOrEqual(Number(out.contextBudgetBytes));
    expect(Number(out.contextBudgetBytes)).toBe(2500);
  });

  it('missing authority fails closed (unit)', () => {
    expect(() =>
      runGoalContext({
        message: ATLAS_MSG,
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

  it('original CEO message preserved', () => {
    const msg = `  ${ATLAS_MSG}  `;
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
    const res = runCli(['goal', 'context', '--message', ATLAS_MSG, '--json']);
    expect([0, 3]).toContain(res.status);
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
    const atlas = runCli(['goal', 'context', '--message', ATLAS_MSG, '--json']);
    const integ = runCli(['goal', 'context', '--message', INTEGRONIX_MSG, '--json']);
    const bad = runCli(['goal', 'context', '--message', '', '--json']);
    const atlasOut = parseOnlyJson(atlas.stdout);
    expect(atlas.status).toBe(atlasOut.finalStatus === 'READY_TO_PLAN' ? 0 : atlasOut.finalStatus === 'NEEDS_APPROVAL' ? 3 : 2);
    expect(integ.status).toBe(0);
    expect(bad.status).toBe(1);
  });
});
