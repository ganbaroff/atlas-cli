/**
 * Bounded source catalog for Context Assembly v0.
 * Not a second memory store — curated path templates only.
 */
import type { SourceAuthority, SourceType } from './contracts.js';

export type CatalogEntry = {
  id: string;
  pathOrUrl: string;
  sourceType: SourceType;
  authority: SourceAuthority;
  historical?: boolean;
  /** Project ids this source applies to; empty = universal personal-memory candidates */
  projectIds: string[];
  /** Goal keywords that make this source relevant (lowercase substrings) */
  relevanceHints: string[];
  personalMemory: boolean;
};

const MEMORY = 'C:\\Projects\\VOLAURA\\memory\\atlas';

/** Curated defaults — assembly still verifies existence via reader. */
export const CONTEXT_SOURCE_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'decision-core-hands',
    pathOrUrl: `${MEMORY}\\decisions\\ATLAS-CORE-AND-HANDS-DECISION-2026-08-03.md`,
    sourceType: 'decision',
    authority: 'canonical-decision',
    projectIds: ['prj_anus_atlas'],
    relevanceHints: ['anus', 'atlas', 'brain', 'devos', 'hand', 'courier'],
    personalMemory: true,
  },
  {
    id: 'decision-courier-loop',
    pathOrUrl: `${MEMORY}\\decisions\\ATLAS-AUTONOMOUS-COURIER-LOOP-DECISION-2026-08-03.md`,
    sourceType: 'decision',
    authority: 'canonical-decision',
    projectIds: ['prj_anus_atlas'],
    relevanceHints: ['courier', 'review', 'chatgpt', 'repair'],
    personalMemory: true,
  },
  {
    id: 'current-compact',
    pathOrUrl: `${MEMORY}\\CURRENT-COMPACT.md`,
    sourceType: 'personal-memory',
    authority: 'current-compact',
    projectIds: ['prj_anus_atlas', 'prj_integronix', 'prj_volaura'],
    relevanceHints: ['atlas', 'anus', 'integronix', 'volaura', 'status'],
    personalMemory: true,
  },
  {
    id: 'ceo-project-map',
    pathOrUrl: `${MEMORY}\\CEO-PROJECT-MAP.md`,
    sourceType: 'personal-memory',
    authority: 'project-canon',
    projectIds: ['prj_anus_atlas', 'prj_integronix', 'prj_volaura'],
    relevanceHints: ['project', 'integronix', 'anus', 'volaura', 'path'],
    personalMemory: true,
  },
  {
    id: 'irrelevant-personal-diary',
    pathOrUrl: `${MEMORY}\\voice.md`,
    sourceType: 'personal-memory',
    authority: 'project-canon',
    projectIds: [],
    relevanceHints: ['voice-style-only-never-auto'],
    personalMemory: true,
  },
  {
    id: 'receipt-goal-intake-merge',
    pathOrUrl:
      'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS\\docs\\atlas-cto\\RECEIPT-2026-08-04-goal-intake-v0-merge.md',
    sourceType: 'receipt',
    authority: 'recent-receipt',
    projectIds: ['prj_anus_atlas'],
    relevanceHints: ['goal', 'intake', 'contract'],
    personalMemory: false,
  },
  {
    id: 'receipt-project-resolution',
    pathOrUrl:
      'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS\\docs\\atlas-cto\\RECEIPT-2026-08-04-project-resolution-v0.md',
    sourceType: 'receipt',
    authority: 'recent-receipt',
    projectIds: ['prj_anus_atlas', 'prj_integronix'],
    relevanceHints: ['resolution', 'path', 'project'],
    personalMemory: false,
  },
  {
    id: 'debt-malformed-review',
    pathOrUrl:
      'C:\\Users\\user\\OneDrive\\Documents\\GitHub\\ANUS\\docs\\atlas-cto\\DEBT-2026-08-04-reviewer-response-protocol.md',
    sourceType: 'repository-doc',
    authority: 'verified-repo-docs',
    projectIds: ['prj_anus_atlas'],
    relevanceHints: ['review', 'malformed', 'chatgpt', 'courier'],
    personalMemory: false,
  },
  {
    id: 'historical-integronix-alarm',
    pathOrUrl: `${MEMORY}\\historical\\integronix-domain-alarm-STALE.md`,
    sourceType: 'personal-memory',
    authority: 'historical',
    historical: true,
    projectIds: ['prj_integronix'],
    relevanceHints: ['integronix', 'domain', 'alarm'],
    personalMemory: true,
  },
  {
    id: 'external-integronix-site',
    pathOrUrl: 'https://integronix.az/',
    sourceType: 'external-url',
    authority: 'external-readonly-target',
    projectIds: ['prj_integronix'],
    relevanceHints: ['integronix', 'анализ', 'audit', 'сайт', 'website'],
    personalMemory: false,
  },
];

/** Authority rank — higher wins conflicts. Historical always loses to current receipts. */
export const AUTHORITY_RANK: Record<SourceAuthority, number> = {
  'canonical-decision': 100,
  'recent-receipt': 90,
  'current-compact': 80,
  'project-canon': 70,
  'verified-repo-docs': 60,
  'project-resolution': 55,
  'goal-contract': 50,
  'external-readonly-target': 40,
  historical: 10,
  unknown: 0,
};
