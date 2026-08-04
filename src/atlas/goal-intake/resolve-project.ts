/**
 * Project Resolution v0 — deterministic path resolver + GoalContract binder.
 * Precedence: registry → memory sources cited → FS existence → git evidence →
 * bounded discovery under approved roots → fail closed.
 * Never invents paths. Static registry alone cannot yield READY.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseAtlasGoalContract,
  type AtlasGoalContract,
} from './contracts.js';
import {
  parseAtlasProjectResolution,
  AtlasProjectResolutionError,
  type AtlasProjectResolution,
  type ResolutionPathType,
} from './resolution-contracts.js';
import {
  DEFAULT_APPROVED_DISCOVERY_ROOTS,
  getProjectById,
  type RegistryPathCandidate,
  type RegistryProject,
} from './project-registry.js';

export type GitProbeResult = {
  isGit: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
  remoteUrl: string | null;
};

export type FsEntryProbe = {
  exists: boolean;
  isDirectory: boolean;
  pathType: ResolutionPathType;
  git: GitProbeResult;
};

export type PathProbe = {
  probePath(absPath: string): FsEntryProbe;
  /** Depth-1 name match under an approved root (bounded). */
  listChildDirs(root: string): string[];
};

export type ResolveProjectOptions = {
  approvedRoots?: readonly string[];
  nowIso?: string;
  probe?: PathProbe;
  /** Optional registry override for tests (same schema, not a second registry). */
  registryProject?: RegistryProject;
  /** When true, dirty READY path → NEEDS_APPROVAL (default true). */
  requireCleanForReady?: boolean;
};

export type ResolveProjectResult = {
  resolution: AtlasProjectResolution;
  boundContract: AtlasGoalContract;
};

function norm(p: string): string {
  return resolve(p.replace(/\//g, '\\')).replace(/\//g, '\\').toLowerCase();
}

/** Exported for tests — Windows path forms C:\… and c:/… normalize equal. */
export function normalizeAtlasPath(p: string): string {
  return norm(p);
}

function isUnderApprovedRoot(absPath: string, roots: readonly string[]): boolean {
  const n = norm(absPath);
  return roots.some((r) => {
    const root = norm(r);
    return n === root || n.startsWith(root.endsWith('\\') ? root : `${root}\\`);
  });
}

function realGitProbe(absPath: string): GitProbeResult {
  const empty: GitProbeResult = {
    isGit: false,
    root: null,
    branch: null,
    head: null,
    dirty: null,
    remoteUrl: null,
  };
  if (!existsSync(join(absPath, '.git')) && !existsSync(absPath)) return empty;
  try {
    const root = execFileSync('git', ['-C', absPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .trim()
      .replace(/\//g, '\\');
    const head = execFileSync('git', ['-C', absPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    const branch = execFileSync('git', ['-C', absPath, 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim() || null;
    const porcelain = execFileSync('git', ['-C', absPath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let remoteUrl: string | null = null;
    try {
      remoteUrl = execFileSync('git', ['-C', absPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
    } catch {
      remoteUrl = null;
    }
    return {
      isGit: true,
      root,
      branch,
      head,
      dirty: porcelain.trim().length > 0,
      remoteUrl,
    };
  } catch {
    return empty;
  }
}

export function createDefaultPathProbe(): PathProbe {
  return {
    probePath(absPath: string): FsEntryProbe {
      const exists = existsSync(absPath);
      if (!exists) {
        return {
          exists: false,
          isDirectory: false,
          pathType: 'missing',
          git: {
            isGit: false,
            root: null,
            branch: null,
            head: null,
            dirty: null,
            remoteUrl: null,
          },
        };
      }
      let isDirectory = false;
      try {
        isDirectory = statSync(absPath).isDirectory();
      } catch {
        isDirectory = false;
      }
      const git = realGitProbe(absPath);
      let pathType: ResolutionPathType = 'workspace';
      if (git.isGit) pathType = 'git-repository';
      else if (/[\\/]_?archive[\\/]/i.test(absPath) || /[\\/]archive[\\/]/i.test(absPath)) {
        pathType = 'archive';
      } else if (!isDirectory) {
        pathType = 'documentation-only';
      }
      return { exists, isDirectory, pathType, git };
    },
    listChildDirs(root: string): string[] {
      if (!existsSync(root)) return [];
      try {
        return readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(root, d.name));
      } catch {
        return [];
      }
    },
  };
}

type VerifiedHit = {
  path: string;
  candidate: RegistryPathCandidate | null;
  probe: FsEntryProbe;
  via: 'registry-candidate' | 'bounded-discovery' | 'contract-path';
};

function classifyFromCandidate(
  c: RegistryPathCandidate | null,
  probe: FsEntryProbe,
): ResolutionPathType {
  if (!probe.exists) return 'missing';
  if (c?.pathType === 'archive' || c?.role === 'archive') return 'archive';
  if (c?.pathType === 'documentation-only' || c?.role === 'docs') return 'documentation-only';
  if (c?.pathType === 'workspace' || c?.role === 'workspace-shell') {
    return probe.git.isGit ? 'git-repository' : 'workspace';
  }
  if (probe.git.isGit) return 'git-repository';
  if (probe.pathType === 'archive') return 'archive';
  return probe.isDirectory ? 'workspace' : 'documentation-only';
}

function collectHits(
  project: RegistryProject,
  contract: AtlasGoalContract,
  roots: readonly string[],
  probe: PathProbe,
): { hits: VerifiedHit[]; outsideRoot: string[]; stale: string[] } {
  const hits: VerifiedHit[] = [];
  const outsideRoot: string[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();

  const consider = (
    absPath: string,
    candidate: RegistryPathCandidate | null,
    via: VerifiedHit['via'],
  ) => {
    const resolved = resolve(absPath);
    const key = norm(resolved);
    if (seen.has(key)) return;
    seen.add(key);
    if (!isUnderApprovedRoot(resolved, roots)) {
      outsideRoot.push(resolved);
      return;
    }
    const p = probe.probePath(resolved);
    if (!p.exists) {
      if (candidate?.role === 'canonical' || via === 'registry-candidate') {
        stale.push(`Registry candidate missing on disk: ${resolved}`);
      }
      return;
    }
    hits.push({ path: resolved, candidate, probe: p, via });
  };

  for (const c of project.expectedPathCandidates) {
    consider(c.path, c, 'registry-candidate');
  }

  // Contract path hint — verify only; never invent
  if (contract.projectPath) {
    consider(contract.projectPath, null, 'contract-path');
  }

  // Bounded discovery: depth-1 under approved roots matching aliases (exact folder name)
  const aliasNames = project.aliases.map((a) => a.toLowerCase()).filter((a) => !a.includes('.'));
  for (const root of roots) {
    for (const child of probe.listChildDirs(root)) {
      const base = child.split(/[/\\]/).pop()?.toLowerCase() ?? '';
      if (aliasNames.some((a) => base === a || base === a.replace(/\s+/g, '-'))) {
        consider(child, null, 'bounded-discovery');
      }
    }
    // one more level under _archive only
    const archiveRoot = join(root, '_archive');
    if (probe.probePath(archiveRoot).exists) {
      for (const child of probe.listChildDirs(archiveRoot)) {
        const base = child.split(/[/\\]/).pop()?.toLowerCase() ?? '';
        if (aliasNames.some((a) => base.includes(a))) {
          consider(child, {
            path: child,
            role: 'archive',
            pathType: 'archive',
          }, 'bounded-discovery');
        }
      }
    }
  }

  return { hits, outsideRoot, stale };
}

function aliasesMatched(project: RegistryProject, contract: AtlasGoalContract): string[] {
  const text = `${contract.originalCeoMessage} ${contract.selectedProject.name} ${project.name}`.toLowerCase();
  return project.aliases.filter((a) => text.includes(a.toLowerCase()));
}

/**
 * Resolve project path for an existing GoalContract. Does not execute project work.
 */
export function resolveProjectPath(
  contract: AtlasGoalContract,
  opts: ResolveProjectOptions = {},
): ResolveProjectResult {
  const roots = opts.approvedRoots ?? DEFAULT_APPROVED_DISCOVERY_ROOTS;
  const probe = opts.probe ?? createDefaultPathProbe();
  const requireClean = opts.requireCleanForReady !== false;

  if (contract.selectedProject.projectId === 'prj_unknown') {
    const resolution = parseAtlasProjectResolution({
      projectId: 'prj_unknown',
      requestedProjectName: contract.selectedProject.name,
      aliasesMatched: [],
      status: 'BLOCKED',
      canonicalPath: null,
      pathType: 'missing',
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'n/a',
      sourceOfTruth: ['goal-contract', 'fail-closed'],
      alternativeMatches: [],
      conflicts: ['Project identity unknown — cannot resolve path'],
      staleRegistryFindings: [],
      confidence: 'none',
      recommendedNextAction: 'stop-and-ask-ceo-for-project-identity',
      evidenceReferences: ['goal-contract:prj_unknown'],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  const project =
    opts.registryProject ??
    getProjectById(contract.selectedProject.projectId) ??
    null;

  if (!project) {
    throw new AtlasProjectResolutionError(
      `unknown project id: ${contract.selectedProject.projectId}`,
      'UNKNOWN_PROJECT',
    );
  }

  const { hits, outsideRoot, stale } = collectHits(project, contract, roots, probe);
  const matched = aliasesMatched(project, contract);
  const evidence: string[] = [
    `registry:${project.projectId}`,
    project.evidenceSource,
    ...project.canonicalMemorySources.slice(0, 2),
  ];

  const conflicts: string[] = [...project.memoryConflicts];
  const staleFindings = [...stale, ...project.staleWarnings.map((w) => `memory-stale: ${w}`)];

  if (outsideRoot.length > 0) {
    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched,
      status: 'NEEDS_APPROVAL',
      canonicalPath: null,
      pathType: 'missing',
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'n/a',
      sourceOfTruth: ['approved-roots-policy', 'registry'],
      alternativeMatches: outsideRoot.map((p) => ({
        path: p,
        pathType: 'workspace' as const,
        role: 'outside-approved-roots',
        reason: 'Path exists or was claimed outside approved discovery roots',
      })),
      conflicts: [`Path(s) outside approved roots: ${outsideRoot.join('; ')}`],
      staleRegistryFindings: staleFindings,
      confidence: 'low',
      recommendedNextAction: 'ceo-approve-root-or-relocate-into-approved-roots',
      evidenceReferences: [...evidence, ...outsideRoot.map((p) => `outside-root:${p}`)],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  const canonicalHits = hits.filter(
    (h) => h.candidate?.role === 'canonical' || (h.candidate === null && h.probe.git.isGit && h.via !== 'bounded-discovery'),
  );
  const archiveHits = hits.filter(
    (h) =>
      h.candidate?.role === 'archive' ||
      h.probe.pathType === 'archive' ||
      classifyFromCandidate(h.candidate, h.probe) === 'archive',
  );
  const shellHits = hits.filter((h) => h.candidate?.role === 'workspace-shell');
  const docsHits = hits.filter(
    (h) =>
      h.candidate?.role === 'docs' ||
      h.candidate?.pathType === 'documentation-only' ||
      classifyFromCandidate(h.candidate, h.probe) === 'documentation-only',
  );
  const discoveryGit = hits.filter(
    (h) => h.via === 'bounded-discovery' && h.probe.git.isGit && h.candidate?.role !== 'archive',
  );

  // Prefer explicit canonical candidates that exist
  const verifiedCanonical = hits.filter((h) => h.candidate?.role === 'canonical' && h.probe.exists);

  // Conflicting multiple canonical git repos
  const gitCanonicals = verifiedCanonical.filter((h) => h.probe.git.isGit);
  const extraGit = discoveryGit.filter(
    (d) => !verifiedCanonical.some((c) => norm(c.path) === norm(d.path)),
  );

  if (gitCanonicals.length + (verifiedCanonical.length === 0 ? extraGit.length : 0) > 1) {
    const alts = [...gitCanonicals, ...extraGit].map((h) => ({
      path: h.path,
      pathType: classifyFromCandidate(h.candidate, h.probe),
      role: h.candidate?.role ?? h.via,
      reason: 'Multiple git repositories match project identity',
    }));
    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched,
      status: 'NEEDS_APPROVAL',
      canonicalPath: null,
      pathType: 'git-repository',
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'unknown',
      sourceOfTruth: ['filesystem', 'git', 'registry'],
      alternativeMatches: alts,
      conflicts: [
        'Multiple valid repositories match — CEO must pick canonical path',
        ...conflicts,
      ],
      staleRegistryFindings: staleFindings,
      confidence: 'medium',
      recommendedNextAction: 'ceo-pick-canonical-repo-and-update-registry',
      evidenceReferences: [...evidence, ...alts.map((a) => `conflict-repo:${a.path}`)],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  // Active vs archive: conflict only when canon is ambiguous.
  // CEO-registered single role=canonical git + role=archive alternatives → proceed to READY path.
  if (gitCanonicals.length >= 1 && archiveHits.length >= 1) {
    const primary = gitCanonicals[0]!;
    const unambiguousCanon =
      project.projectId === 'prj_integronix' &&
      gitCanonicals.length === 1 &&
      primary.candidate?.role === 'canonical' &&
      archiveHits.every(
        (h) => h.candidate?.role === 'archive' || h.candidate?.role == null || h.probe.pathType === 'archive',
      ) &&
      !archiveHits.some((h) => h.candidate?.role === 'canonical');
    if (!unambiguousCanon) {
      const resolution = parseAtlasProjectResolution({
        projectId: project.projectId,
        requestedProjectName: project.name,
        aliasesMatched: matched,
        status: 'NEEDS_APPROVAL',
        canonicalPath: null,
        pathType: 'git-repository',
        repositoryRoot: primary.probe.git.root,
        gitBranch: primary.probe.git.branch,
        gitHead: primary.probe.git.head,
        workingTree: primary.probe.git.dirty ? 'dirty' : 'clean',
        sourceOfTruth: ['filesystem', 'git', 'registry'],
        alternativeMatches: [
          {
            path: primary.path,
            pathType: 'git-repository',
            role: 'canonical-candidate',
            reason: 'Active git repository',
          },
          ...archiveHits.map((h) => ({
            path: h.path,
            pathType: 'archive' as const,
            role: 'archive',
            reason: 'Archived copy also present',
          })),
        ],
        conflicts: [
          'Active repository and archived copy both present — confirm which is authority',
          ...conflicts,
        ],
        staleRegistryFindings: staleFindings,
        confidence: 'medium',
        recommendedNextAction: 'ceo-confirm-active-vs-archive-authority',
        evidenceReferences: [
          ...evidence,
          `active:${primary.path}`,
          ...archiveHits.map((h) => `archive:${h.path}`),
        ],
      });
      return { resolution, boundContract: bindResolution(contract, resolution) };
    }
  }

  // Documentation-only only
  if (docsHits.length > 0 && verifiedCanonical.length === 0 && archiveHits.length === 0) {
    const doc = docsHits[0]!;
    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched,
      status: 'NEEDS_APPROVAL',
      canonicalPath: null,
      pathType: 'documentation-only',
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'n/a',
      sourceOfTruth: ['filesystem', 'registry'],
      alternativeMatches: docsHits.map((h) => ({
        path: h.path,
        pathType: 'documentation-only' as const,
        role: 'docs',
        reason: 'Documentation-only path — not an executable repo',
      })),
      conflicts: conflicts,
      staleRegistryFindings: staleFindings,
      confidence: 'low',
      recommendedNextAction: 'ceo-provide-executable-repo-or-accept-docs-only',
      evidenceReferences: [...evidence, `docs:${doc.path}`],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  // Archive-only / lifecycle archived → BLOCKED (do not force READY)
  if (
    (project.lifecycle === 'archived' || (archiveHits.length > 0 && verifiedCanonical.length === 0)) &&
    gitCanonicals.length === 0
  ) {
    const arch = archiveHits[0];
    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched,
      status: 'BLOCKED',
      canonicalPath: null,
      pathType: arch ? 'archive' : 'missing',
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'n/a',
      sourceOfTruth: ['filesystem', 'registry', 'fail-closed'],
      alternativeMatches: archiveHits.map((h) => ({
        path: h.path,
        pathType: 'archive' as const,
        role: 'archive',
        reason: 'Archived evidence only — not an active canonical source',
      })),
      conflicts: [
        'No verified active canonical repository — archive/stale evidence insufficient for READY',
        ...conflicts,
      ],
      staleRegistryFindings: staleFindings,
      confidence: arch ? 'low' : 'none',
      recommendedNextAction: 'ceo-locate-or-register-active-integronix-repo',
      evidenceReferences: [
        ...evidence,
        ...(arch ? [`archive:${arch.path}`] : ['no-archive-hit']),
      ],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  // Missing entirely
  if (hits.length === 0) {
    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched,
      status: 'BLOCKED',
      canonicalPath: null,
      pathType: 'missing',
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'n/a',
      sourceOfTruth: ['filesystem', 'registry', 'fail-closed'],
      alternativeMatches: [],
      conflicts: ['Project path absent under approved roots'],
      staleRegistryFindings: staleFindings,
      confidence: 'none',
      recommendedNextAction: 'ceo-provide-canonical-path',
      evidenceReferences: evidence,
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  // Single verified canonical git → candidate for READY
  if (gitCanonicals.length === 1) {
    const hit = gitCanonicals[0]!;
    const alts = [
      ...shellHits.map((h) => ({
        path: h.path,
        pathType: classifyFromCandidate(h.candidate, h.probe),
        role: 'workspace-shell',
        reason: h.candidate?.note ?? 'Registered workspace/shell alternative',
      })),
      ...archiveHits.map((h) => ({
        path: h.path,
        pathType: 'archive' as const,
        role: 'archive',
        reason: 'Archive present but not selected as canon',
      })),
      ...extraGit.map((h) => ({
        path: h.path,
        pathType: 'git-repository' as const,
        role: 'discovery',
        reason: 'Bounded discovery match',
      })),
    ];

    // Memory/FS disagree: registry projectPath hint missing but candidate exists is OK;
    // if contract.projectPath set and differs from verified → NEEDS_APPROVAL
    if (contract.projectPath && norm(contract.projectPath) !== norm(hit.path)) {
      const cp = probe.probePath(resolve(contract.projectPath));
      if (cp.exists && norm(resolve(contract.projectPath)) !== norm(hit.path)) {
        conflicts.push(
          `GoalContract.projectPath (${contract.projectPath}) disagrees with verified canonical (${hit.path})`,
        );
        const resolution = parseAtlasProjectResolution({
          projectId: project.projectId,
          requestedProjectName: project.name,
          aliasesMatched: matched,
          status: 'NEEDS_APPROVAL',
          canonicalPath: null,
          pathType: 'git-repository',
          repositoryRoot: hit.probe.git.root,
          gitBranch: hit.probe.git.branch,
          gitHead: hit.probe.git.head,
          workingTree: hit.probe.git.dirty ? 'dirty' : 'clean',
          sourceOfTruth: ['filesystem', 'git', 'goal-contract', 'registry'],
          alternativeMatches: [
            {
              path: hit.path,
              pathType: 'git-repository',
              role: 'verified-canonical',
              reason: 'Filesystem-verified registry canonical',
            },
            {
              path: resolve(contract.projectPath),
              pathType: classifyFromCandidate(null, cp),
              role: 'contract-path',
              reason: 'Path carried on GoalContract',
            },
            ...alts,
          ],
          conflicts,
          staleRegistryFindings: staleFindings,
          confidence: 'medium',
          recommendedNextAction: 'ceo-reconcile-contract-path-vs-registry',
          evidenceReferences: [
            ...evidence,
            `verified:${hit.path}`,
            `contract-path:${contract.projectPath}`,
          ],
        });
        return { resolution, boundContract: bindResolution(contract, resolution) };
      }
    }

    if (requireClean && hit.probe.git.dirty) {
      const resolution = parseAtlasProjectResolution({
        projectId: project.projectId,
        requestedProjectName: project.name,
        aliasesMatched: matched,
        status: 'NEEDS_APPROVAL',
        canonicalPath: null,
        pathType: 'git-repository',
        repositoryRoot: hit.probe.git.root,
        gitBranch: hit.probe.git.branch,
        gitHead: hit.probe.git.head,
        workingTree: 'dirty',
        sourceOfTruth: ['filesystem', 'git', 'registry'],
        alternativeMatches: alts,
        conflicts: [
          'Canonical repository working tree is dirty — future execution could affect local work',
          ...conflicts,
        ],
        staleRegistryFindings: staleFindings,
        confidence: 'high',
        recommendedNextAction: 'ceo-approve-dirty-worktree-or-clean-first',
        evidenceReferences: [...evidence, `dirty:${hit.path}`, `head:${hit.probe.git.head}`],
      });
      return { resolution, boundContract: bindResolution(contract, resolution) };
    }

    // Stale registry timestamp note (does not block READY if FS verifies)
    if (project.verificationTimestamp) {
      const ageMs = Date.now() - Date.parse(project.verificationTimestamp);
      if (Number.isFinite(ageMs) && ageMs > 1000 * 60 * 60 * 24 * 30) {
        staleFindings.push(
          `Registry verificationTimestamp older than 30d (${project.verificationTimestamp}) — FS re-verified now`,
        );
      }
    }

    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched.length ? matched : project.aliases.slice(0, 1),
      status: 'READY',
      canonicalPath: hit.path,
      pathType: 'git-repository',
      repositoryRoot: hit.probe.git.root,
      gitBranch: hit.probe.git.branch,
      gitHead: hit.probe.git.head,
      workingTree: hit.probe.git.dirty ? 'dirty' : 'clean',
      sourceOfTruth: ['filesystem', 'git', 'registry'],
      alternativeMatches: alts,
      conflicts,
      staleRegistryFindings: staleFindings,
      confidence: 'high',
      recommendedNextAction: 'proceed-with-bound-goal-contract',
      evidenceReferences: [
        ...evidence,
        `verified-path:${hit.path}`,
        `git-head:${hit.probe.git.head ?? 'none'}`,
        ...(hit.probe.git.remoteUrl ? [`remote:${hit.probe.git.remoteUrl}`] : []),
      ],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  // Workspace-only hit (no git canonical)
  const workspaceOnly = hits.filter((h) => !h.probe.git.isGit && h.probe.isDirectory);
  if (workspaceOnly.length === 1 && verifiedCanonical.length === 0) {
    const hit = workspaceOnly[0]!;
    const resolution = parseAtlasProjectResolution({
      projectId: project.projectId,
      requestedProjectName: project.name,
      aliasesMatched: matched,
      status: 'NEEDS_APPROVAL',
      canonicalPath: null,
      pathType: classifyFromCandidate(hit.candidate, hit.probe),
      repositoryRoot: null,
      gitBranch: null,
      gitHead: null,
      workingTree: 'n/a',
      sourceOfTruth: ['filesystem', 'registry'],
      alternativeMatches: [
        {
          path: hit.path,
          pathType: classifyFromCandidate(hit.candidate, hit.probe),
          role: hit.candidate?.role ?? 'workspace',
          reason: 'Non-git path found — not READY without git canon',
        },
      ],
      conflicts,
      staleRegistryFindings: staleFindings,
      confidence: 'low',
      recommendedNextAction: 'ceo-confirm-workspace-or-provide-git-root',
      evidenceReferences: [...evidence, `workspace:${hit.path}`],
    });
    return { resolution, boundContract: bindResolution(contract, resolution) };
  }

  // Fail closed
  const resolution = parseAtlasProjectResolution({
    projectId: project.projectId,
    requestedProjectName: project.name,
    aliasesMatched: matched,
    status: 'BLOCKED',
    canonicalPath: null,
    pathType: 'missing',
    repositoryRoot: null,
    gitBranch: null,
    gitHead: null,
    workingTree: 'n/a',
    sourceOfTruth: ['filesystem', 'registry', 'fail-closed'],
    alternativeMatches: hits.map((h) => ({
      path: h.path,
      pathType: classifyFromCandidate(h.candidate, h.probe),
      role: h.candidate?.role ?? h.via,
      reason: 'Unresolved hit — insufficient for READY',
    })),
    conflicts: ['Unresolved project path — fail closed', ...conflicts],
    staleRegistryFindings: staleFindings,
    confidence: 'none',
    recommendedNextAction: 'stop-fail-closed-ask-ceo',
    evidenceReferences: evidence,
  });
  return { resolution, boundContract: bindResolution(contract, resolution) };
}

/**
 * Bind resolution onto a GoalContract copy.
 * Preserves originalCeoMessage + interpretedObjective. Sets projectPath only when READY.
 */
export function bindResolution(
  contract: AtlasGoalContract,
  resolution: AtlasProjectResolution,
): AtlasGoalContract {
  return parseAtlasGoalContract({
    ...contract,
    originalCeoMessage: contract.originalCeoMessage,
    interpretedObjective: contract.interpretedObjective,
    projectPath: resolution.status === 'READY' ? resolution.canonicalPath : contract.projectPath,
  });
}

/** Convenience: dirname of a file path for tests — not used to invent project roots. */
export function parentDir(p: string): string {
  return dirname(p);
}
