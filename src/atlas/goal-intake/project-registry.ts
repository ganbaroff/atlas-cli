/**
 * Thin project registry for Goal Intake v0.
 * Human authority remains CEO-PROJECT-MAP.md — this is a code mirror of known lanes only.
 * Does not invent live production facts.
 */
export type RegistryProject = {
  projectId: string;
  name: string;
  /** Absolute path if a durable workspace is known; null if unverified/absent. */
  projectPath: string | null;
  aliases: string[];
  canonicalMemorySources: string[];
  /** Explicit facts Atlas may state; everything else is assumption. */
  knownFacts: string[];
  /** Documented conflicts in canon (if any). */
  memoryConflicts: string[];
  /** Stale / unverified warnings from CEO-PROJECT-MAP. */
  staleWarnings: string[];
  defaultForbiddenActions: string[];
};

/** Built-in registry — keep small; extend only with CEO-confirmed lanes. */
export const GOAL_INTAKE_PROJECT_REGISTRY: readonly RegistryProject[] = [
  {
    projectId: 'prj_integronix',
    name: 'Integronix',
    projectPath: null, // CEO-PROJECT-MAP: only archived audit root located; no verified live repo
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
  },
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
