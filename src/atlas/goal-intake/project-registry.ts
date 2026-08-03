/**
 * Extended Goal Intake project registry — Project Resolution v0.
 * Human authority remains CEO-PROJECT-MAP.md. Static rows alone never yield READY;
 * filesystem verification is mandatory.
 */
export type RegistryLifecycle = 'active' | 'hold' | 'archived';

export type RegistryPathType =
  | 'git-repository'
  | 'workspace'
  | 'archive'
  | 'documentation-only'
  | 'missing';

export type RegistryCandidateRole = 'canonical' | 'workspace-shell' | 'archive' | 'docs';

export type RegistryPathCandidate = {
  path: string;
  role: RegistryCandidateRole;
  pathType: RegistryPathType;
  /** Human note; not filesystem truth. */
  note?: string;
};

export type RegistryProject = {
  projectId: string;
  name: string;
  /**
   * Legacy Goal Intake field: preferred path hint only.
   * Never treat as verified without FS check.
   */
  projectPath: string | null;
  aliases: string[];
  canonicalMemorySources: string[];
  knownFacts: string[];
  memoryConflicts: string[];
  staleWarnings: string[];
  defaultForbiddenActions: string[];
  /** Project Resolution v0 fields */
  projectType: RegistryPathType;
  lifecycle: RegistryLifecycle;
  expectedPathCandidates: RegistryPathCandidate[];
  /** ISO timestamp of last human/registry verification claim (may be stale). */
  verificationTimestamp: string | null;
  evidenceSource: string;
};

/** Built-in registry — keep small; extend only with CEO-confirmed lanes. */
export const GOAL_INTAKE_PROJECT_REGISTRY: readonly RegistryProject[] = [
  {
    projectId: 'prj_integronix',
    name: 'Integronix',
    projectPath: null,
    aliases: ['integronix', 'integronix.az', 'интегроникс'],
    canonicalMemorySources: [
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CEO-PROJECT-MAP.md#integronix',
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CURRENT-COMPACT.md',
    ],
    knownFacts: [
      'Integronix is a separate B2B/B2G security-systems maintenance business in Baku',
      'CEO-PROJECT-MAP marks Integronix as UNVERIFIED / maintenance',
      'Only an archived audit root was located at C:\\Projects\\_archive\\integronix-audit',
      'June Atlas registry and domain alarms are too stale to claim current production state',
    ],
    memoryConflicts: [
      'Historical domain-alarm notes conflict with current UNVERIFIED status — do not treat alarms as live production truth',
    ],
    staleWarnings: [
      'Production owner, deployment, DNS, RFQ, email, WAF, monitoring are not currently verified',
    ],
    defaultForbiddenActions: [
      'production-write',
      'deploy',
      'dns-change',
      'credential-access',
      'payment',
      'delete-data',
    ],
    projectType: 'archive',
    lifecycle: 'archived',
    expectedPathCandidates: [
      {
        path: 'C:\\Projects\\_archive\\integronix-audit',
        role: 'archive',
        pathType: 'archive',
        note: 'Archived audit root only — not an active product repo',
      },
    ],
    verificationTimestamp: '2026-07-10T00:00:00.000Z',
    evidenceSource: 'CEO-PROJECT-MAP.md#integronix + filesystem probe',
  },
  {
    projectId: 'prj_anus_atlas',
    name: 'ANUS / Atlas brain',
    projectPath: 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS',
    aliases: ['anus', 'atlas', 'atlas brain', 'devos', 'атлас'],
    canonicalMemorySources: [
      'C:\\Projects\\VOLAURA\\memory\\atlas\\bootstrap.md',
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CURRENT-COMPACT.md',
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CEO-PROJECT-MAP.md',
    ],
    knownFacts: [
      'ANUS is the Atlas Mastra/TS orchestrator (brain) repository',
      'Canonical personal memory lives under C:\\Projects\\VOLAURA\\memory\\atlas',
      'C:\\Projects\\ATLAS is a separate workspace/shell repo (ganbaroff/atlas), not ANUS code canon',
    ],
    memoryConflicts: [],
    staleWarnings: [],
    defaultForbiddenActions: [
      'push',
      'deploy',
      'runner-enable',
      'daemon-enable',
      'credential-export',
    ],
    projectType: 'git-repository',
    lifecycle: 'active',
    expectedPathCandidates: [
      {
        path: 'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS',
        role: 'canonical',
        pathType: 'git-repository',
        note: 'ANUS code canon',
      },
      {
        path: 'C:\\Projects\\ATLAS',
        role: 'workspace-shell',
        pathType: 'workspace',
        note: 'ATLAS workspace/shell — distinct remote; not ANUS canon',
      },
    ],
    verificationTimestamp: '2026-08-04T00:00:00.000Z',
    evidenceSource: 'CEO-PROJECT-MAP + local git remotes',
  },
  {
    projectId: 'prj_volaura',
    name: 'VOLAURA product',
    projectPath: 'C:\\Projects\\VOLAURA',
    aliases: ['volaura', 'волаура'],
    canonicalMemorySources: [
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CEO-PROJECT-MAP.md',
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CURRENT-COMPACT.md',
    ],
    knownFacts: ['VOLAURA is the product ecosystem lane; Atlas memory is separate under memory/atlas'],
    memoryConflicts: [],
    staleWarnings: [],
    defaultForbiddenActions: ['production-write', 'deploy', 'credential-access', 'push'],
    projectType: 'git-repository',
    lifecycle: 'active',
    expectedPathCandidates: [
      {
        path: 'C:\\Projects\\VOLAURA',
        role: 'canonical',
        pathType: 'git-repository',
      },
    ],
    verificationTimestamp: '2026-08-04T00:00:00.000Z',
    evidenceSource: 'CEO-PROJECT-MAP + filesystem',
  },
];

export const DEFAULT_APPROVED_DISCOVERY_ROOTS: readonly string[] = [
  'C:\\Projects',
  'C:\\Users\\user\\OneDrive\\Documents\\GitHub',
];

export function findProjectByAlias(text: string): RegistryProject | null {
  const lower = text.toLowerCase();
  let best: RegistryProject | null = null;
  let bestLen = 0;
  for (const p of GOAL_INTAKE_PROJECT_REGISTRY) {
    for (const a of p.aliases) {
      if (lower.includes(a.toLowerCase()) && a.length > bestLen) {
        best = p;
        bestLen = a.length;
      }
    }
  }
  return best;
}

export function getProjectById(projectId: string): RegistryProject | null {
  return GOAL_INTAKE_PROJECT_REGISTRY.find((p) => p.projectId === projectId) ?? null;
}

/** Test/override helper — shallow copy of registry entry with patches. */
export function withRegistryOverrides(
  base: RegistryProject,
  patch: Partial<RegistryProject>,
): RegistryProject {
  return { ...base, ...patch };
}
