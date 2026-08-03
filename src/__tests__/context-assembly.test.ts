/**
 * Context Assembly v0 tests — injectable reader; no file writes.
 */
import { describe, expect, it } from 'vitest';
import {
  interpretCeoGoal,
  parseAtlasGoalContract,
  type AtlasGoalContract,
  type AtlasProjectResolution,
} from '../atlas/goal-intake/index.js';
import {
  assembleContextPack,
  memoryReader,
  assertNoWrites,
  AtlasContextAssemblyError,
  type CatalogEntry,
} from '../atlas/context-assembly/index.js';

function stubResolution(partial: Partial<AtlasProjectResolution> & Pick<AtlasProjectResolution, 'status' | 'projectId'>): AtlasProjectResolution {
  const status = partial.status;
  const base = {
    projectId: partial.projectId,
    requestedProjectName: partial.requestedProjectName ?? 'X',
    aliasesMatched: partial.aliasesMatched ?? [],
    status,
    canonicalPath: status === 'READY' ? (partial.canonicalPath ?? 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS') : null,
    pathType: partial.pathType ?? (status === 'READY' ? 'git-repository' : 'missing'),
    repositoryRoot: status === 'READY' ? (partial.repositoryRoot ?? partial.canonicalPath ?? 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS') : null,
    gitBranch: status === 'READY' ? (partial.gitBranch ?? 'main') : null,
    gitHead: status === 'READY' ? (partial.gitHead ?? 'abc') : null,
    workingTree: partial.workingTree ?? (status === 'READY' ? 'clean' : 'n/a'),
    sourceOfTruth: partial.sourceOfTruth ?? ['test'],
    alternativeMatches: partial.alternativeMatches ?? [],
    conflicts: partial.conflicts ?? [],
    staleRegistryFindings: partial.staleRegistryFindings ?? [],
    confidence: partial.confidence ?? 'medium',
    recommendedNextAction: partial.recommendedNextAction ?? 'x',
    evidenceReferences: partial.evidenceReferences ?? ['e'],
  };
  return base as AtlasProjectResolution;
}

function contract(msg: string, projectId: string, name: string): AtlasGoalContract {
  return parseAtlasGoalContract({
    originalCeoMessage: msg,
    interpretedObjective: msg.slice(0, 200),
    selectedProject: { projectId, name },
    projectPath: null,
    relevantCanonicalMemorySources: [],
    requestedOutcome: 'context',
    allowedActions: ['memory-read', 'web-observe-readonly'],
    forbiddenActions: ['deploy', 'production-write'],
    riskLevel: 'low',
    approvalRequirements: [],
    completionCriteria: ['context assembled'],
    evidenceRequirements: ['hashes'],
    unresolvedAssumptions: [],
    recommendedNextWorkflow: 'context-assembly',
    status: 'ready',
    facts: [],
    assumptions: [],
    conciseCeoSummary: 'c',
  });
}

const compactNew = 'CURRENT: Project Resolution MERGED. Tip ready. Next Context Assembly.';
const compactStale = 'STALE SUMMARY: everything broken forever.';
const receiptNew = 'RECEIPT: Project Resolution MERGED AND VERIFIED 2026-08-04.';
const historicalAlarm = 'HISTORICAL: Integronix production live READY deployed alarm.';

describe('atlas context assembly v0', () => {
  it('1. current canonical/receipt wins over stale summary', () => {
    const c = contract('Atlas brain status check, nothing else', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const catalog: CatalogEntry[] = [
      {
        id: 'stale-compact',
        pathOrUrl: 'mem://stale',
        sourceType: 'personal-memory',
        authority: 'current-compact',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['atlas', 'status'],
        personalMemory: true,
      },
      {
        id: 'receipt',
        pathOrUrl: 'mem://receipt',
        sourceType: 'receipt',
        authority: 'recent-receipt',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['atlas', 'resolution'],
        personalMemory: false,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({
        'mem://stale': { content: compactStale, mtimeIso: '2026-01-01T00:00:00.000Z' },
        'mem://receipt': { content: receiptNew, mtimeIso: '2026-08-04T00:00:00.000Z' },
      }),
    });
    expect(pack.selectedSources.filter((s) => s.selected).map((s) => s.id)).toEqual(
      expect.arrayContaining(['receipt', 'stale-compact']),
    );
    expect(pack.constraints.join(' ')).toMatch(/receipt overrides historical|Precedence|recent receipt/i);
    expect(AUTHORITY_ok(pack)).toBe(true);
  });

  it('2. conflicting memory sources surfaced', () => {
    const c = contract('integronix audit read-only', 'prj_integronix', 'Integronix');
    const r = stubResolution({
      status: 'BLOCKED',
      projectId: 'prj_integronix',
      pathType: 'archive',
      conflicts: ['No verified active canonical repository'],
    });
    const catalog: CatalogEntry[] = [
      {
        id: 'hist',
        pathOrUrl: 'mem://hist',
        sourceType: 'personal-memory',
        authority: 'historical',
        historical: true,
        projectIds: ['prj_integronix'],
        relevanceHints: ['integronix'],
        personalMemory: true,
      },
      {
        id: 'ext',
        pathOrUrl: 'https://integronix.az/',
        sourceType: 'external-url',
        authority: 'external-readonly-target',
        projectIds: ['prj_integronix'],
        relevanceHints: ['integronix', 'audit'],
        personalMemory: false,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({
        'mem://hist': { content: historicalAlarm },
        'https://integronix.az/': { content: 'external-readonly-target:https://integronix.az/' },
      }),
    });
    expect(pack.unresolvedContradictions.length).toBeGreaterThan(0);
  });

  it('3. historical source correctly labelled', () => {
    const c = contract('integronix audit', 'prj_integronix', 'Integronix');
    const r = stubResolution({ status: 'BLOCKED', projectId: 'prj_integronix', pathType: 'archive' });
    const catalog: CatalogEntry[] = [
      {
        id: 'hist',
        pathOrUrl: 'mem://hist',
        sourceType: 'personal-memory',
        authority: 'historical',
        historical: true,
        projectIds: ['prj_integronix'],
        relevanceHints: ['integronix'],
        personalMemory: true,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({ 'mem://hist': { content: historicalAlarm } }),
    });
    const hist = pack.selectedSources.find((s) => s.id === 'hist');
    expect(hist?.historical).toBe(true);
    expect(pack.staleInformation.some((s) => /historical-source/i.test(s))).toBe(true);
  });

  it('4. irrelevant personal memory excluded', () => {
    const c = contract('ANUS read-only review', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const catalog: CatalogEntry[] = [
      {
        id: 'voice',
        pathOrUrl: 'mem://voice',
        sourceType: 'personal-memory',
        authority: 'project-canon',
        projectIds: [],
        relevanceHints: ['voice-style-only-never-auto'],
        personalMemory: true,
      },
      {
        id: 'compact',
        pathOrUrl: 'mem://compact',
        sourceType: 'personal-memory',
        authority: 'current-compact',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['anus', 'atlas'],
        personalMemory: true,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({
        'mem://voice': { content: 'speak russian storytelling' },
        'mem://compact': { content: compactNew },
      }),
    });
    expect(pack.selectedSources.find((s) => s.id === 'voice')?.selected).toBe(false);
    expect(pack.selectedSources.find((s) => s.id === 'compact')?.selected).toBe(true);
  });

  it('5. project memory separated from personal memory', () => {
    const c = contract('ANUS courier debt', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const catalog: CatalogEntry[] = [
      {
        id: 'personal',
        pathOrUrl: 'mem://personal',
        sourceType: 'personal-memory',
        authority: 'current-compact',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['anus', 'courier'],
        personalMemory: true,
      },
      {
        id: 'debt',
        pathOrUrl: 'mem://debt',
        sourceType: 'repository-doc',
        authority: 'verified-repo-docs',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['courier', 'debt'],
        personalMemory: false,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({
        'mem://personal': { content: compactNew },
        'mem://debt': { content: 'DEBT: MALFORMED_REVIEW protocol' },
      }),
    });
    expect(pack.assumptions.join(' ')).toMatch(/personal-memory/i);
    expect(pack.selectedSources.some((s) => s.selected && s.sourceType === 'repository-doc')).toBe(true);
    expect(pack.selectedSources.some((s) => s.selected && s.sourceType === 'personal-memory')).toBe(true);
  });

  it('6. missing source recorded', () => {
    const c = contract('ANUS path docs', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const catalog: CatalogEntry[] = [
      {
        id: 'gone',
        pathOrUrl: 'mem://gone',
        sourceType: 'receipt',
        authority: 'recent-receipt',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['anus', 'path'],
        personalMemory: false,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({}),
    });
    expect(pack.missingEvidence.some((m) => /gone/i.test(m))).toBe(true);
  });

  it('7. excessive context budget fails or drops low-authority', () => {
    const c = contract('ANUS huge context', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const big = 'x'.repeat(5000);
    const catalog: CatalogEntry[] = [
      {
        id: 'big-hist',
        pathOrUrl: 'mem://big',
        sourceType: 'personal-memory',
        authority: 'historical',
        historical: true,
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['anus', 'huge'],
        personalMemory: true,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      budgetBytes: 2000,
      reader: memoryReader({ 'mem://big': { content: big } }),
    });
    expect(pack.selectedSources.find((s) => s.id === 'big-hist')?.selected).toBe(false);
    expect(pack.selectedSources.find((s) => s.id === 'big-hist')?.exclusionReason).toMatch(/budget/i);
  });

  it('8. Integronix live audit ready while repository execution blocked', () => {
    const c = interpretCeoGoal({
      ceoMessage: 'Проведи полный анализ integronix.az. Ничего не меняй.',
    });
    const r = stubResolution({
      status: 'BLOCKED',
      projectId: 'prj_integronix',
      pathType: 'archive',
      conflicts: ['No verified active canonical repository — archive/stale evidence insufficient for READY'],
    });
    const catalog: CatalogEntry[] = [
      {
        id: 'ext',
        pathOrUrl: 'https://integronix.az/',
        sourceType: 'external-url',
        authority: 'external-readonly-target',
        projectIds: ['prj_integronix'],
        relevanceHints: ['integronix', 'анализ'],
        personalMemory: false,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({
        'https://integronix.az/': { content: 'external-readonly-target:https://integronix.az/' },
      }),
    });
    expect(pack.planningStatus).toBe('READY_TO_PLAN');
    expect(pack.readOnlyTargetReady).toBe(true);
    expect(pack.projectExecutionReady).toBe(false);
    expect(pack.externalTarget).toBe('https://integronix.az/');
    expect(pack.verifiedProjectPath).toBeNull();
    expect(pack.constraints.join(' ') + pack.assumptions.join(' ')).toMatch(
      /READ-ONLY TARGET READY|PROJECT EXECUTION/i,
    );
  });

  it('9. Atlas development context ready', () => {
    const c = contract('ANUS courier review debt, read-only', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas', workingTree: 'clean' });
    const catalog: CatalogEntry[] = [
      {
        id: 'compact',
        pathOrUrl: 'mem://compact',
        sourceType: 'personal-memory',
        authority: 'current-compact',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['anus', 'courier'],
        personalMemory: true,
      },
      {
        id: 'decision',
        pathOrUrl: 'mem://decision',
        sourceType: 'decision',
        authority: 'canonical-decision',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['anus', 'courier'],
        personalMemory: true,
      },
      {
        id: 'debt',
        pathOrUrl: 'mem://debt',
        sourceType: 'repository-doc',
        authority: 'verified-repo-docs',
        projectIds: ['prj_anus_atlas'],
        relevanceHints: ['courier', 'debt', 'review'],
        personalMemory: false,
      },
    ];
    const { pack } = assembleContextPack(c, r, {
      catalog,
      reader: memoryReader({
        'mem://compact': { content: compactNew },
        'mem://decision': { content: 'Binding decision: Atlas sole brain. Courier loop MERGED.' },
        'mem://debt': { content: 'DEBT-2026-08-04 MALFORMED_REVIEW' },
      }),
    });
    expect(pack.planningStatus).toBe('READY_TO_PLAN');
    expect(pack.projectExecutionReady).toBe(true);
    expect(pack.verifiedProjectPath).toBeTruthy();
  });

  it('10. source hashes and evidence paths present', () => {
    const c = contract('ANUS tip', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const { pack } = assembleContextPack(c, r, {
      catalog: [
        {
          id: 'compact',
          pathOrUrl: 'mem://compact',
          sourceType: 'personal-memory',
          authority: 'current-compact',
          projectIds: ['prj_anus_atlas'],
          relevanceHints: ['anus'],
          personalMemory: true,
        },
      ],
      reader: memoryReader({ 'mem://compact': { content: compactNew } }),
    });
    const selected = pack.selectedSources.filter((s) => s.selected);
    expect(selected.every((s) => s.contentHash.length >= 32 && s.pathOrUrl.length > 0)).toBe(true);
  });

  it('11. facts versus assumptions separated', () => {
    const c = contract('Анализ integronix.az. Ничего не меняй.', 'prj_integronix', 'Integronix');
    const r = stubResolution({ status: 'BLOCKED', projectId: 'prj_integronix', pathType: 'archive' });
    const { pack } = assembleContextPack(c, r, {
      catalog: [
        {
          id: 'ext',
          pathOrUrl: 'https://integronix.az/',
          sourceType: 'external-url',
          authority: 'external-readonly-target',
          projectIds: ['prj_integronix'],
          relevanceHints: ['integronix', 'анализ'],
          personalMemory: false,
        },
      ],
      reader: memoryReader({
        'https://integronix.az/': { content: 'external-readonly-target:https://integronix.az/' },
      }),
    });
    expect(pack.facts.length).toBeGreaterThan(0);
    expect(pack.assumptions.length).toBeGreaterThan(0);
    expect(pack.facts.every((f) => f.citation)).toBe(true);
  });

  it('12. stale source cannot silently override current receipt', () => {
    const c = contract('integronix status', 'prj_integronix', 'Integronix');
    const r = stubResolution({ status: 'BLOCKED', projectId: 'prj_integronix', pathType: 'archive' });
    const { pack } = assembleContextPack(c, r, {
      catalog: [
        {
          id: 'hist',
          pathOrUrl: 'mem://hist',
          sourceType: 'personal-memory',
          authority: 'historical',
          historical: true,
          projectIds: ['prj_integronix'],
          relevanceHints: ['integronix', 'status'],
          personalMemory: true,
        },
        {
          id: 'receipt',
          pathOrUrl: 'mem://receipt',
          sourceType: 'receipt',
          authority: 'recent-receipt',
          projectIds: ['prj_integronix'],
          relevanceHints: ['integronix', 'status'],
          personalMemory: false,
        },
      ],
      reader: memoryReader({
        'mem://hist': { content: historicalAlarm },
        'mem://receipt': { content: 'RECEIPT: Integronix resolution BLOCKED archive only' },
      }),
    });
    expect(pack.constraints.join(' ')).toMatch(/receipt overrides|Precedence/i);
    expect(pack.unresolvedContradictions.length).toBeGreaterThan(0);
  });

  it('13. unknown authority fails closed', () => {
    const c = contract('ANUS x', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    expect(() =>
      assembleContextPack(c, r, {
        catalog: [
          {
            id: 'bad',
            pathOrUrl: 'mem://bad',
            sourceType: 'personal-memory',
            authority: 'unknown',
            projectIds: ['prj_anus_atlas'],
            relevanceHints: ['anus'],
            personalMemory: true,
          },
        ],
        reader: memoryReader({ 'mem://bad': { content: 'x' } }),
        failUnknownAuthority: true,
      }),
    ).toThrow(AtlasContextAssemblyError);
  });

  it('14. GoalContract intent remains unchanged', () => {
    const msg = 'Проведи полный анализ integronix.az. Ничего не меняй.';
    const c = interpretCeoGoal({ ceoMessage: msg });
    const r = stubResolution({ status: 'BLOCKED', projectId: 'prj_integronix', pathType: 'archive' });
    const { goalContract, pack } = assembleContextPack(c, r, {
      catalog: [
        {
          id: 'ext',
          pathOrUrl: 'https://integronix.az/',
          sourceType: 'external-url',
          authority: 'external-readonly-target',
          projectIds: ['prj_integronix'],
          relevanceHints: ['integronix', 'анализ'],
          personalMemory: false,
        },
      ],
      reader: memoryReader({
        'https://integronix.az/': { content: 'external-readonly-target:https://integronix.az/' },
      }),
    });
    expect(goalContract.originalCeoMessage).toBe(c.originalCeoMessage);
    expect(goalContract.interpretedObjective).toBe(c.interpretedObjective);
    expect(pack.goalId.length).toBeGreaterThan(0);
  });

  it('15. no file modifications during assembly', () => {
    const c = contract('ANUS', 'prj_anus_atlas', 'ANUS');
    const r = stubResolution({ status: 'READY', projectId: 'prj_anus_atlas' });
    const result = assembleContextPack(c, r, {
      catalog: [],
      reader: memoryReader({}),
    });
    expect(result.filesTouchedForWrite).toEqual([]);
    assertNoWrites(result);
  });
});

function AUTHORITY_ok(pack: { selectedSources: { authority: string; selected: boolean }[] }): boolean {
  return pack.selectedSources.some((s) => s.selected && s.authority === 'recent-receipt');
}
