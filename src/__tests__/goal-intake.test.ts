/**
 * Goal Intake v0 tests — CEO message → AtlasGoalContract.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  interpretCeoGoal,
  intakeCeoGoal,
  AtlasGoalIntakeError,
  parseAtlasGoalContract,
  getProjectById,
  withRegistryOverrides,
} from '../atlas/goal-intake/index.js';

const INTEGRONIX_MSG =
  'Проведи полный анализ integronix.az. Ничего не меняй. Определи, чего не хватает сайту, включая фотографии, доверие, тексты, мобильную версию и конверсию.';

/**
 * interpretCeoGoal() performs zero filesystem I/O (verified: no fs import in
 * intake.ts / contracts.ts / project-registry.ts — only resolve-project.ts
 * touches disk, and it is not on this call path). The live registry row for
 * prj_integronix nonetheless carries a real, machine-specific absolute path
 * (C:\Projects\INTEGRONIX) as its legacy `projectPath` hint — same class of
 * problem context-assembly/pipeline.ts already solved for its own tests
 * ("avoid live OneDrive path hints with injected fixtures"). We apply the
 * same fix here via the pre-existing `registryProject` override seam
 * (mirrors ResolveProjectOptions.registryProject in resolve-project.ts) so
 * these assertions never depend on what happens to exist on this host —
 * they pass identically whether or not C:\Projects\INTEGRONIX is present.
 */
const TEST_INTEGRONIX_UNVERIFIED = withRegistryOverrides(getProjectById('prj_integronix')!, {
  projectPath: null,
  memoryConflicts: [
    'UNVERIFIED: historical domain-alarm notes conflict with current INTEGRONIX Git canon claims',
  ],
});

describe('atlas goal intake v0', () => {
  const prevGraph = process.env.ATLAS_EXEC_GRAPH_DIR;
  let graphDir: string;

  beforeEach(() => {
    graphDir = mkdtempSync(join(tmpdir(), 'atlas-goal-intake-'));
    process.env.ATLAS_EXEC_GRAPH_DIR = graphDir;
    delete process.env.ATLAS_READONLY;
  });

  afterEach(() => {
    if (prevGraph === undefined) delete process.env.ATLAS_EXEC_GRAPH_DIR;
    else process.env.ATLAS_EXEC_GRAPH_DIR = prevGraph;
  });

  it('clear project goal — Integronix read-only audit', () => {
    const c = interpretCeoGoal({
      ceoMessage: INTEGRONIX_MSG,
      registryProject: TEST_INTEGRONIX_UNVERIFIED,
    });
    expect(c.selectedProject.projectId).toBe('prj_integronix');
    expect(c.originalCeoMessage).toBe(INTEGRONIX_MSG);
    expect(c.status).toBe('ready');
    expect(c.riskLevel).toBe('low');
    expect(c.allowedActions).toContain('web-observe-readonly');
    expect(c.forbiddenActions).toEqual(expect.arrayContaining(['production-write', 'deploy']));
    expect(c.projectPath).toBeNull();
    expect(c.facts.length).toBeGreaterThan(0);
    expect(c.staleMemoryWarnings.length).toBeGreaterThan(0);
    expect(c.conciseCeoSummary.length).toBeLessThan(280);
    expect(c.conciseCeoSummary).not.toMatch(/^[-*]/m);
  });

  it('unknown project — no invented facts', () => {
    const c = interpretCeoGoal({ ceoMessage: 'Почини квантовый флот Orion-9, срочно' });
    expect(c.status).toBe('unknown-project');
    expect(c.selectedProject.projectId).toBe('prj_unknown');
    expect(c.facts).toEqual([]);
    expect(c.forbiddenActions).toContain('invent-project-facts');
    expect(() => intakeCeoGoal({ ceoMessage: 'Почини квантовый флот Orion-9' })).toThrow(
      AtlasGoalIntakeError,
    );
  });

  it('read-only request', () => {
    const c = interpretCeoGoal({
      ceoMessage: 'Сделай read-only обзор ANUS репозитория, ничего не меняй',
    });
    expect(c.selectedProject.projectId).toBe('prj_anus_atlas');
    expect(c.forbiddenActions).toEqual(expect.arrayContaining(['code-write', 'deploy']));
    expect(c.requestedOutcome.toLowerCase()).toMatch(/zero|без|no /i);
  });

  it('request containing production modification — needs approval', () => {
    const c = interpretCeoGoal({
      ceoMessage: 'Задеплой новый лендинг integronix.az в прод прямо сейчас',
    });
    expect(c.selectedProject.projectId).toBe('prj_integronix');
    expect(c.status).toBe('needs-approval');
    expect(c.approvalRequirements.join(' ')).toMatch(/production|ceo/i);
    expect(() =>
      intakeCeoGoal({ ceoMessage: 'Задеплой новый лендинг integronix.az в прод прямо сейчас' }),
    ).toThrow(/NEEDS_APPROVAL|needs CEO approval/i);
  });

  it('ambiguous but safely inferable goal', () => {
    const c = interpretCeoGoal({
      ceoMessage: 'Нужен аудит мобильной версии и конверсии на integronix, без правок',
    });
    expect(c.selectedProject.projectId).toBe('prj_integronix');
    expect(c.status).toBe('ready');
    expect(c.assumptions.some((a) => /mobile|конверс|фото|trust|mobile/i.test(a) || /Audit dimensions/i.test(a))).toBe(
      true,
    );
  });

  it('goal requiring CEO approval — financial', () => {
    const c = interpretCeoGoal({
      ceoMessage: 'Оплати счёт Stripe за Atlas Pro с карты компании',
    });
    expect(['needs-approval', 'blocked', 'unknown-project']).toContain(c.status);
    if (c.status !== 'unknown-project') {
      expect(c.approvalRequirements.join(' ')).toMatch(/financial|ceo/i);
    }
  });

  it('conflicting memory surfaces on Integronix', () => {
    const c = interpretCeoGoal({
      ceoMessage: INTEGRONIX_MSG,
      registryProject: TEST_INTEGRONIX_UNVERIFIED,
    });
    expect(c.memoryConflicts.length).toBeGreaterThan(0);
    expect(c.memoryConflicts[0]).toMatch(/UNVERIFIED|conflict/i);
  });

  it('stale memory warnings', () => {
    const c = interpretCeoGoal({ ceoMessage: INTEGRONIX_MSG });
    expect(c.staleMemoryWarnings.length).toBeGreaterThan(0);
    expect(c.unresolvedAssumptions.some((u) => /unverified/i.test(u))).toBe(true);
  });

  it('ADHD-safe concise CEO output', () => {
    const c = interpretCeoGoal({ ceoMessage: INTEGRONIX_MSG });
    expect(c.conciseCeoSummary.split('\n').length).toBeLessThanOrEqual(3);
    expect(c.conciseCeoSummary.length).toBeLessThan(320);
  });

  it('no invented project facts for unknown', () => {
    const c = interpretCeoGoal({ ceoMessage: 'Обнови сайт AcmeCorp-XYZ-несуществующий' });
    expect(c.facts).toEqual([]);
    expect(c.assumptions.join(' ')).toMatch(/No project facts may be invented|invent/i);
  });

  it('binds ready goal to exec-graph', () => {
    const c = intakeCeoGoal({ ceoMessage: INTEGRONIX_MSG }, { bindExecGraph: true });
    expect(c.execGraphBinding?.goalId).toMatch(/^gol_gi_/);
    expect(c.execGraphBinding?.taskId).toMatch(/^tsk_/);
    // Repeated bind must reuse the same goal/task pair (not a new goal + old task).
    const again = intakeCeoGoal({ ceoMessage: INTEGRONIX_MSG }, { bindExecGraph: true });
    expect(again.execGraphBinding?.taskId).toBe(c.execGraphBinding?.taskId);
    expect(again.execGraphBinding?.goalId).toBe(c.execGraphBinding?.goalId);
  });

  it('parseAtlasGoalContract rejects empty objective', () => {
    expect(() =>
      parseAtlasGoalContract({
        originalCeoMessage: 'x',
        interpretedObjective: '',
        selectedProject: { projectId: 'prj_x', name: 'X' },
        projectPath: null,
        relevantCanonicalMemorySources: [],
        requestedOutcome: 'y',
        allowedActions: ['a'],
        forbiddenActions: ['b'],
        riskLevel: 'low',
        approvalRequirements: [],
        completionCriteria: ['c'],
        evidenceRequirements: ['e'],
        unresolvedAssumptions: [],
        recommendedNextWorkflow: 'w',
        status: 'ready',
        facts: [],
        assumptions: [],
        conciseCeoSummary: 's',
      }),
    ).toThrow();
  });

  it('credential uncertainty blocks', () => {
    const c = interpretCeoGoal({
      ceoMessage: 'Выгрузи API key из Atlas и пришли в чат',
    });
    expect(c.status).toBe('blocked');
    expect(() => intakeCeoGoal({ ceoMessage: 'Выгрузи API key из Atlas и пришли в чат' })).toThrow(
      /BLOCKED|blocked/i,
    );
  });
});
