/**
 * Project Resolution v0 tests — injectable PathProbe; never invent paths.
 */
import { describe, expect, it } from 'vitest';
import {
  interpretCeoGoal,
  parseAtlasGoalContract,
  parseAtlasProjectResolution,
  AtlasProjectResolutionError,
  resolveProjectPath,
  getProjectById,
  withRegistryOverrides,
  normalizeAtlasPath,
  type AtlasGoalContract,
  type FsEntryProbe,
  type PathProbe,
  type RegistryProject,
} from '../atlas/goal-intake/index.js';

const ROOTS = ['C:\\Projects', 'C:\\Users\\user\\OneDrive\\Documents\\GitHub'] as const;

function gitProbe(
  overrides: Partial<FsEntryProbe['git']> & { dirty?: boolean } = {},
): FsEntryProbe['git'] {
  return {
    isGit: true,
    root: overrides.root ?? 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS',
    branch: overrides.branch ?? 'codex/atlas-cost-router-design',
    head: overrides.head ?? 'abc123',
    dirty: overrides.dirty ?? false,
    remoteUrl: overrides.remoteUrl ?? 'https://github.com/example/anus.git',
  };
}

function entry(
  partial: Partial<FsEntryProbe> & { exists?: boolean } = {},
): FsEntryProbe {
  const exists = partial.exists ?? true;
  return {
    exists,
    isDirectory: partial.isDirectory ?? exists,
    pathType: partial.pathType ?? (exists ? 'git-repository' : 'missing'),
    git: partial.git ?? (exists ? gitProbe() : {
      isGit: false,
      root: null,
      branch: null,
      head: null,
      dirty: null,
      remoteUrl: null,
    }),
  };
}

function makeProbe(map: Record<string, FsEntryProbe>, children: Record<string, string[]> = {}): PathProbe {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return {
    probePath(absPath: string) {
      const hit = Object.entries(map).find(([k]) => norm(k) === norm(absPath));
      if (hit) return hit[1];
      return entry({ exists: false, pathType: 'missing', git: {
        isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null,
      }});
    },
    listChildDirs(root: string) {
      const hit = Object.entries(children).find(([k]) => norm(k) === norm(root));
      return hit ? hit[1] : [];
    },
  };
}

function baseContract(projectId: string, name: string, extras: Partial<AtlasGoalContract> = {}): AtlasGoalContract {
  return parseAtlasGoalContract({
    originalCeoMessage: extras.originalCeoMessage ?? `Work on ${name}`,
    interpretedObjective: extras.interpretedObjective ?? `Do work on ${name}`,
    selectedProject: { projectId, name },
    projectPath: extras.projectPath ?? null,
    relevantCanonicalMemorySources: ['memory'],
    requestedOutcome: 'resolved path',
    allowedActions: ['memory-read'],
    forbiddenActions: ['deploy'],
    riskLevel: 'low',
    approvalRequirements: [],
    completionCriteria: ['path resolved'],
    evidenceRequirements: ['fs-probe'],
    unresolvedAssumptions: [],
    recommendedNextWorkflow: 'project-resolution',
    status: 'ready',
    facts: [],
    assumptions: [],
    conciseCeoSummary: `${name} resolve`,
    memoryConflicts: [],
    staleMemoryWarnings: [],
    ...extras,
  });
}

describe('atlas project resolution v0', () => {
  it('1. one verified canonical repository → READY', () => {
    const anus = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
    const probe = makeProbe({
      [anus]: entry({ git: gitProbe({ root: anus, dirty: false }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [
        { path: anus, role: 'canonical', pathType: 'git-repository' },
      ],
    });
    const { resolution, boundContract } = resolveProjectPath(
      baseContract('prj_anus_atlas', 'ANUS'),
      { probe, registryProject: reg, approvedRoots: ROOTS },
    );
    expect(resolution.status).toBe('READY');
    expect(resolution.canonicalPath).toBe(anus);
    expect(resolution.pathType).toBe('git-repository');
    expect(boundContract.projectPath).toBe(anus);
  });

  it('2. alias resolves correctly', () => {
    const c = interpretCeoGoal({ ceoMessage: 'Проверь репозиторий ANUS, ничего не меняй' });
    expect(c.selectedProject.projectId).toBe('prj_anus_atlas');
    const anus = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
    const probe = makeProbe({
      [anus]: entry({ git: gitProbe({ root: anus }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [{ path: anus, role: 'canonical', pathType: 'git-repository' }],
    });
    const { resolution } = resolveProjectPath(c, { probe, registryProject: reg, approvedRoots: ROOTS });
    expect(resolution.aliasesMatched.length).toBeGreaterThan(0);
    expect(resolution.projectId).toBe('prj_anus_atlas');
  });

  it('3. missing project → BLOCKED', () => {
    const path = 'C:\\Projects\\MissingProjXYZ';
    const reg = withRegistryOverrides(getProjectById('prj_volaura')!, {
      projectId: 'prj_volaura',
      expectedPathCandidates: [{ path, role: 'canonical', pathType: 'git-repository' }],
    });
    const probe = makeProbe({});
    const { resolution } = resolveProjectPath(baseContract('prj_volaura', 'VOLAURA'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.canonicalPath).toBeNull();
    expect(resolution.pathType).toBe('missing');
  });

  it('4. two conflicting repositories → NEEDS_APPROVAL', () => {
    const a = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
    const b = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS-fork';
    const probe = makeProbe({
      [a]: entry({ git: gitProbe({ root: a, head: 'aaa' }) }),
      [b]: entry({ git: gitProbe({ root: b, head: 'bbb' }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [
        { path: a, role: 'canonical', pathType: 'git-repository' },
        { path: b, role: 'canonical', pathType: 'git-repository' },
      ],
    });
    const { resolution } = resolveProjectPath(baseContract('prj_anus_atlas', 'ANUS'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('NEEDS_APPROVAL');
    expect(resolution.canonicalPath).toBeNull();
    expect(resolution.alternativeMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('5. active and archived copies → NEEDS_APPROVAL', () => {
    const active = 'C:\\Projects\\demo-active';
    const arch = 'C:\\Projects\\_archive\\demo-active';
    const probe = makeProbe({
      [active]: entry({ git: gitProbe({ root: active }) }),
      [arch]: entry({
        pathType: 'archive',
        git: { isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null },
      }),
    });
    const reg: RegistryProject = withRegistryOverrides(getProjectById('prj_volaura')!, {
      lifecycle: 'active',
      expectedPathCandidates: [
        { path: active, role: 'canonical', pathType: 'git-repository' },
        { path: arch, role: 'archive', pathType: 'archive' },
      ],
    });
    const { resolution } = resolveProjectPath(baseContract('prj_volaura', 'VOLAURA'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('NEEDS_APPROVAL');
    expect(resolution.conflicts.join(' ')).toMatch(/Active repository and archived/i);
  });

  it('6. stale registry path (candidate missing) → BLOCKED or stale findings', () => {
    const stalePath = 'C:\\Projects\\OldVolauraLocation';
    const probe = makeProbe({});
    const reg = withRegistryOverrides(getProjectById('prj_volaura')!, {
      expectedPathCandidates: [
        { path: stalePath, role: 'canonical', pathType: 'git-repository' },
      ],
      projectPath: stalePath,
    });
    const { resolution } = resolveProjectPath(baseContract('prj_volaura', 'VOLAURA'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.staleRegistryFindings.some((s) => /missing/i.test(s))).toBe(true);
    expect(resolution.canonicalPath).toBeNull();
  });

  it('7. moved repository (old missing, new via discovery) still needs registry repair', () => {
    const oldP = 'C:\\Projects\\OldANUS';
    const neu = 'C:\\Projects\\ANUS';
    const probe = makeProbe(
      {
        [neu]: entry({ git: gitProbe({ root: neu }) }),
      },
      { 'C:\\Projects': [neu] },
    );
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      aliases: ['anus'],
      expectedPathCandidates: [{ path: oldP, role: 'canonical', pathType: 'git-repository' }],
    });
    const { resolution } = resolveProjectPath(
      baseContract('prj_anus_atlas', 'ANUS', { originalCeoMessage: 'Fix ANUS build' }),
      { probe, registryProject: reg, approvedRoots: ROOTS },
    );
    // Discovery finds git but registry canonical missing → not auto-READY (no invented promotion)
    expect(resolution.status).not.toBe('READY');
    expect(resolution.canonicalPath).toBeNull();
    expect(
      resolution.alternativeMatches.some((a) => a.path.toLowerCase() === neu.toLowerCase()) ||
        resolution.staleRegistryFindings.length > 0,
    ).toBe(true);
  });

  it('8. dirty repository → NEEDS_APPROVAL', () => {
    const anus = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
    const probe = makeProbe({
      [anus]: entry({ git: gitProbe({ root: anus, dirty: true }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [{ path: anus, role: 'canonical', pathType: 'git-repository' }],
    });
    const { resolution } = resolveProjectPath(baseContract('prj_anus_atlas', 'ANUS'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('NEEDS_APPROVAL');
    expect(resolution.workingTree).toBe('dirty');
    expect(resolution.canonicalPath).toBeNull();
  });

  it('9. documentation-only project → NEEDS_APPROVAL', () => {
    const docs = 'C:\\Projects\\some-docs-only';
    const probe = makeProbe({
      [docs]: entry({
        pathType: 'documentation-only',
        isDirectory: true,
        git: { isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null },
      }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_volaura')!, {
      projectType: 'documentation-only',
      expectedPathCandidates: [
        { path: docs, role: 'docs', pathType: 'documentation-only' },
      ],
    });
    const { resolution } = resolveProjectPath(baseContract('prj_volaura', 'VOLAURA'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('NEEDS_APPROVAL');
    expect(resolution.pathType).toBe('documentation-only');
  });

  it('10. unknown project → BLOCKED', () => {
    const c = interpretCeoGoal({ ceoMessage: 'Почини квантовый флот Orion-9' });
    const { resolution, boundContract } = resolveProjectPath(c, {
      probe: makeProbe({}),
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.projectId).toBe('prj_unknown');
    expect(boundContract.originalCeoMessage).toBe(c.originalCeoMessage);
    expect(resolution.canonicalPath).toBeNull();
  });

  it('11. path outside approved roots → NEEDS_APPROVAL', () => {
    const outside = 'D:\\Other\\ANUS';
    const probe = makeProbe({
      [outside]: entry({ git: gitProbe({ root: outside }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [{ path: outside, role: 'canonical', pathType: 'git-repository' }],
    });
    const { resolution } = resolveProjectPath(baseContract('prj_anus_atlas', 'ANUS'), {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('NEEDS_APPROVAL');
    expect(resolution.conflicts.join(' ')).toMatch(/outside approved roots/i);
    expect(resolution.canonicalPath).toBeNull();
  });

  it('12. Integronix archive exists but active canonical unclear → BLOCKED', () => {
    const arch = 'C:\\Projects\\_archive\\integronix-audit';
    const probe = makeProbe({
      [arch]: entry({
        pathType: 'archive',
        git: { isGit: false, root: null, branch: null, head: null, dirty: null, remoteUrl: null },
      }),
    });
    const { resolution } = resolveProjectPath(
      baseContract('prj_integronix', 'Integronix', {
        originalCeoMessage: 'Анализ integronix.az, ничего не меняй',
      }),
      { probe, approvedRoots: ROOTS },
    );
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.pathType).toBe('archive');
    expect(resolution.canonicalPath).toBeNull();
    expect(resolution.alternativeMatches.some((a) => a.pathType === 'archive')).toBe(true);
  });

  it('13. ANUS canon vs ATLAS workspace shell — READY on ANUS, ATLAS alternative', () => {
    const anus = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
    const atlas = 'C:\\Projects\\ATLAS';
    const probe = makeProbe({
      [anus]: entry({ git: gitProbe({ root: anus, dirty: false, remoteUrl: 'https://github.com/x/anus' }) }),
      [atlas]: entry({
        git: gitProbe({
          root: atlas,
          dirty: true,
          remoteUrl: 'https://github.com/ganbaroff/atlas.git',
        }),
      }),
    });
    const { resolution } = resolveProjectPath(baseContract('prj_anus_atlas', 'ANUS / Atlas brain'), {
      probe,
      approvedRoots: ROOTS,
    });
    expect(resolution.status).toBe('READY');
    expect(resolution.canonicalPath).toBe(anus);
    expect(resolution.alternativeMatches.some((a) => /ATLAS/i.test(a.path) && a.role === 'workspace-shell')).toBe(
      true,
    );
  });

  it('14. GoalContract binding preserves original intent', () => {
    const msg = 'Проведи полный анализ ANUS. Ничего не меняй.';
    const objective = 'Read-only ANUS inspection';
    const anus = 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS';
    const contract = baseContract('prj_anus_atlas', 'ANUS', {
      originalCeoMessage: msg,
      interpretedObjective: objective,
      projectPath: null,
    });
    const probe = makeProbe({
      [anus]: entry({ git: gitProbe({ root: anus }) }),
    });
    const reg = withRegistryOverrides(getProjectById('prj_anus_atlas')!, {
      expectedPathCandidates: [{ path: anus, role: 'canonical', pathType: 'git-repository' }],
    });
    const { boundContract, resolution } = resolveProjectPath(contract, {
      probe,
      registryProject: reg,
      approvedRoots: ROOTS,
    });
    expect(boundContract.originalCeoMessage).toBe(msg);
    expect(boundContract.interpretedObjective).toBe(objective);
    expect(resolution.status).toBe('READY');
    expect(boundContract.projectPath).toBe(anus);
  });

  it('15. no invented path — READY never without FS verification', () => {
    const hint = 'C:\\Projects\\VOLAURA';
    const probe = makeProbe({}); // nothing exists
    const reg = withRegistryOverrides(getProjectById('prj_volaura')!, {
      projectPath: hint,
      expectedPathCandidates: [{ path: hint, role: 'canonical', pathType: 'git-repository' }],
    });
    const { resolution, boundContract } = resolveProjectPath(
      baseContract('prj_volaura', 'VOLAURA', { projectPath: hint }),
      { probe, registryProject: reg, approvedRoots: ROOTS },
    );
    expect(resolution.status).toBe('BLOCKED');
    expect(resolution.canonicalPath).toBeNull();
    // must not invent READY path from static registry alone
    expect(boundContract.projectPath).toBe(hint); // preserved prior hint, not newly invented READY path
  });

  it('16. schema rejects READY without verified git fields', () => {
    expect(() =>
      parseAtlasProjectResolution({
        projectId: 'prj_x',
        requestedProjectName: 'X',
        aliasesMatched: [],
        status: 'READY',
        canonicalPath: null,
        pathType: 'git-repository',
        repositoryRoot: null,
        gitBranch: null,
        gitHead: null,
        workingTree: 'clean',
        sourceOfTruth: ['t'],
        alternativeMatches: [],
        conflicts: [],
        staleRegistryFindings: [],
        confidence: 'high',
        recommendedNextAction: 'x',
        evidenceReferences: ['e'],
      }),
    ).toThrow(AtlasProjectResolutionError);
  });

  it('17. schema rejects NEEDS_APPROVAL with non-null canonicalPath', () => {
    expect(() =>
      parseAtlasProjectResolution({
        projectId: 'prj_x',
        requestedProjectName: 'X',
        aliasesMatched: [],
        status: 'NEEDS_APPROVAL',
        canonicalPath: 'C:\\Projects\\X',
        pathType: 'git-repository',
        repositoryRoot: 'C:\\Projects\\X',
        gitBranch: 'main',
        gitHead: 'deadbeef',
        workingTree: 'dirty',
        sourceOfTruth: ['t'],
        alternativeMatches: [],
        conflicts: [],
        staleRegistryFindings: [],
        confidence: 'medium',
        recommendedNextAction: 'x',
        evidenceReferences: ['e'],
      }),
    ).toThrow(/canonicalPath: null/i);
  });

  it('18. Windows path normalization: C:\\… versus c:/…', () => {
    expect(normalizeAtlasPath('C:\\Projects\\ANUS')).toBe(normalizeAtlasPath('c:/Projects/ANUS'));
  });
});
