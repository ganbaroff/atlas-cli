/**
 * Context Assembly v0 — assemble AtlasContextPack from GoalContract + ProjectResolution.
 * Read-only filesystem/URL metadata. Never writes. Never invents project details.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { AtlasGoalContract } from '../goal-intake/contracts.js';
import type { AtlasProjectResolution } from '../goal-intake/resolution-contracts.js';
import {
  AtlasContextAssemblyError,
  parseAtlasContextPack,
  type AtlasContextPack,
  type ContextSource,
  type ExtractedFact,
  type SourceAuthority,
} from './contracts.js';
import {
  AUTHORITY_RANK,
  CONTEXT_SOURCE_CATALOG,
  type CatalogEntry,
} from './source-catalog.js';

export type SourceReadResult = {
  ok: boolean;
  content: string;
  mtimeIso: string | null;
  error?: string;
};

export type ContextSourceReader = {
  read(pathOrUrl: string): SourceReadResult;
};

export type AssembleContextOptions = {
  reader?: ContextSourceReader;
  catalog?: readonly CatalogEntry[];
  budgetBytes?: number;
  nowIso?: string;
  /** Extra catalog rows for tests */
  extraSources?: CatalogEntry[];
  /** When true, treat unknown authority rows as fail-closed */
  failUnknownAuthority?: boolean;
};

export type AssembleContextResult = {
  pack: AtlasContextPack;
  /** GoalContract copy — intent fields unchanged */
  goalContract: AtlasGoalContract;
  filesTouchedForWrite: string[]; // always empty in v0
};

const DEFAULT_BUDGET = 48_000;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createDefaultSourceReader(): ContextSourceReader {
  return {
    read(pathOrUrl: string): SourceReadResult {
      if (/^https?:\/\//i.test(pathOrUrl)) {
        // External targets: metadata-only in v0 (no live fetch required for assembly)
        return {
          ok: true,
          content: `external-readonly-target:${pathOrUrl}`,
          mtimeIso: new Date().toISOString(),
        };
      }
      if (!existsSync(pathOrUrl)) {
        return { ok: false, content: '', mtimeIso: null, error: 'missing' };
      }
      try {
        const st = statSync(pathOrUrl);
        if (!st.isFile()) {
          return { ok: false, content: '', mtimeIso: null, error: 'not-a-file' };
        }
        const content = readFileSync(pathOrUrl, 'utf8');
        return { ok: true, content, mtimeIso: st.mtime.toISOString() };
      } catch (e) {
        return {
          ok: false,
          content: '',
          mtimeIso: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}

function goalText(contract: AtlasGoalContract): string {
  return `${contract.originalCeoMessage} ${contract.interpretedObjective} ${contract.requestedOutcome}`.toLowerCase();
}

function isRelevant(entry: CatalogEntry, contract: AtlasGoalContract, projectId: string): boolean {
  if (entry.projectIds.length > 0 && !entry.projectIds.includes(projectId)) return false;
  if (entry.relevanceHints.includes('voice-style-only-never-auto')) return false;
  if (entry.projectIds.length === 0 && entry.personalMemory) return false;
  const text = goalText(contract);
  if (entry.relevanceHints.length === 0) return entry.projectIds.includes(projectId);
  return entry.relevanceHints.some((h) => text.includes(h.toLowerCase()));
}

function isReadOnlyAudit(contract: AtlasGoalContract): boolean {
  return /ничего не меняй|read[\s-]?only|не трогай|audit|анализ/i.test(contract.originalCeoMessage);
}

function extractFactsFromContent(
  entry: CatalogEntry,
  content: string,
  contract: AtlasGoalContract,
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const cite = entry.pathOrUrl;
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (entry.authority === 'external-readonly-target') {
    facts.push({
      text: `External read-only audit target declared: ${entry.pathOrUrl}`,
      kind: 'fact',
      citation: cite,
    });
    facts.push({
      text: 'Live site observation required before claiming page content facts',
      kind: 'assumption',
      citation: cite,
    });
    return facts;
  }

  // Prefer lines that look like decisions / status
  for (const line of lines.slice(0, 80)) {
    if (/^\*\*Next restart:\*\*/i.test(line) || /^## /i.test(line)) continue;
    if (/MERGED|READY|BLOCKED|ACCEPT|DEBT-|NO-GO|UNVERIFIED/i.test(line)) {
      facts.push({
        text: line.replace(/\*\*/g, '').slice(0, 240),
        kind: /DEBT-|UNVERIFIED|NO-GO|BLOCKED/i.test(line) ? 'blocker' : 'fact',
        citation: cite,
      });
    }
    if (/Decision|Binding decision|CEO decision/i.test(line)) {
      facts.push({
        text: line.replace(/\*\*/g, '').slice(0, 240),
        kind: 'decision',
        citation: cite,
      });
    }
    if (facts.length >= 8) break;
  }

  if (entry.historical) {
    facts.push({
      text: `Source labelled historical — must not override current receipts`,
      kind: 'constraint',
      citation: cite,
    });
  }

  if (facts.length === 0 && content.length > 0) {
    facts.push({
      text: `Loaded ${entry.id} (${Math.min(content.length, 120)} chars preview used for planning context)`,
      kind: 'inference',
      citation: cite,
    });
  }

  // Contract constraints
  if (entry.id === 'ceo-project-map' && /integronix/i.test(goalText(contract))) {
    facts.push({
      text: 'Integronix marked UNVERIFIED / maintenance in project map — do not invent live repo path',
      kind: 'constraint',
      citation: cite,
    });
  }

  return facts;
}

function detectContradictions(
  sources: ContextSource[],
  contents: Map<string, string>,
): string[] {
  const out: string[] = [];
  const historical = sources.filter((s) => s.historical && s.selected);
  const receipts = sources.filter((s) => s.authority === 'recent-receipt' && s.selected);
  if (historical.length && receipts.length) {
    out.push(
      'Historical source(s) present alongside recent receipt(s) — receipts win; historical kept labelled only',
    );
  }

  // Stale "READY" claims in historical vs BLOCKED in resolution text
  for (const h of historical) {
    const c = contents.get(h.id) ?? '';
    if (/READY|production live|deployed/i.test(c)) {
      out.push(
        `Historical source ${h.pathOrUrl} asserts live/ready language that may conflict with current resolution`,
      );
    }
  }
  return out;
}

/**
 * Assemble a bounded context pack. Does not mutate goal message/objective.
 * Does not write any files.
 */
export function assembleContextPack(
  contract: AtlasGoalContract,
  resolution: AtlasProjectResolution,
  opts: AssembleContextOptions = {},
): AssembleContextResult {
  const reader = opts.reader ?? createDefaultSourceReader();
  const catalog = [...(opts.catalog ?? CONTEXT_SOURCE_CATALOG), ...(opts.extraSources ?? [])];
  const budget = opts.budgetBytes ?? DEFAULT_BUDGET;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const failUnknown = opts.failUnknownAuthority !== false;
  const filesTouchedForWrite: string[] = [];

  const projectId = contract.selectedProject.projectId;
  const goalId =
    contract.execGraphBinding?.goalId ??
    `goal-intake:${sha256(contract.originalCeoMessage).slice(0, 12)}`;

  const selectedSources: ContextSource[] = [];
  const excluded: ContextSource[] = [];
  const facts: ExtractedFact[] = [];
  const missingEvidence: string[] = [];
  const staleInformation: string[] = [];
  const assumptions: string[] = [];
  const contents = new Map<string, string>();
  let bytesUsed = 0;

  // Always include synthetic goal + resolution sources (in-memory, hashed)
  const goalBlob = JSON.stringify({
    originalCeoMessage: contract.originalCeoMessage,
    interpretedObjective: contract.interpretedObjective,
    status: contract.status,
    risk: contract.riskLevel,
  });
  selectedSources.push({
    id: 'goal-contract',
    sourceType: 'registry',
    pathOrUrl: `goal-contract:${projectId}`,
    authority: 'goal-contract',
    freshnessIso: nowIso,
    contentHash: sha256(goalBlob),
    bytesLoaded: Buffer.byteLength(goalBlob, 'utf8'),
    historical: false,
    selected: true,
  });
  bytesUsed += Buffer.byteLength(goalBlob, 'utf8');
  contents.set('goal-contract', goalBlob);
  facts.push({
    text: `CEO intent preserved: ${contract.interpretedObjective.slice(0, 200)}`,
    kind: 'fact',
    citation: 'goal-contract',
  });
  facts.push({
    text: `Allowed: ${contract.allowedActions.join(', ')}; Forbidden: ${contract.forbiddenActions.slice(0, 6).join(', ')}`,
    kind: 'constraint',
    citation: 'goal-contract',
  });

  const resBlob = JSON.stringify({
    status: resolution.status,
    canonicalPath: resolution.canonicalPath,
    pathType: resolution.pathType,
    conflicts: resolution.conflicts,
  });
  selectedSources.push({
    id: 'project-resolution',
    sourceType: 'registry',
    pathOrUrl: `project-resolution:${resolution.projectId}`,
    authority: 'project-resolution',
    freshnessIso: nowIso,
    contentHash: sha256(resBlob),
    bytesLoaded: Buffer.byteLength(resBlob, 'utf8'),
    historical: false,
    selected: true,
  });
  bytesUsed += Buffer.byteLength(resBlob, 'utf8');
  contents.set('project-resolution', resBlob);
  facts.push({
    text: `Project resolution status=${resolution.status}; pathType=${resolution.pathType}; canonicalPath=${resolution.canonicalPath ?? 'null'}`,
    kind: 'fact',
    citation: 'project-resolution',
  });

  for (const entry of catalog) {
    if (failUnknown && entry.authority === 'unknown') {
      throw new AtlasContextAssemblyError(
        `unknown authority for source ${entry.id}`,
        'UNKNOWN_AUTHORITY',
      );
    }

    const relevant = isRelevant(entry, contract, projectId);
    if (!relevant) {
      excluded.push({
        id: entry.id,
        sourceType: entry.sourceType,
        pathOrUrl: entry.pathOrUrl,
        authority: entry.authority,
        freshnessIso: nowIso,
        contentHash: sha256('excluded'),
        bytesLoaded: 0,
        historical: !!entry.historical,
        selected: false,
        exclusionReason: entry.personalMemory
          ? 'irrelevant-personal-memory-or-out-of-project'
          : 'not-relevant-to-goal',
      });
      continue;
    }

    const read = reader.read(entry.pathOrUrl);
    if (!read.ok) {
      missingEvidence.push(`missing-source:${entry.pathOrUrl}`);
      excluded.push({
        id: entry.id,
        sourceType: entry.sourceType,
        pathOrUrl: entry.pathOrUrl,
        authority: entry.authority,
        freshnessIso: nowIso,
        contentHash: sha256(`missing:${entry.pathOrUrl}`),
        bytesLoaded: 0,
        historical: !!entry.historical,
        selected: false,
        exclusionReason: read.error ?? 'missing',
      });
      continue;
    }

    let loadContent = read.content;
    let size = Buffer.byteLength(loadContent, 'utf8');
    if (bytesUsed + size > budget) {
      const remaining = budget - bytesUsed;
      if (remaining < 256) {
        excluded.push({
          id: entry.id,
          sourceType: entry.sourceType,
          pathOrUrl: entry.pathOrUrl,
          authority: entry.authority,
          freshnessIso: read.mtimeIso ?? nowIso,
          contentHash: sha256(read.content),
          bytesLoaded: 0,
          historical: !!entry.historical,
          selected: false,
          exclusionReason: 'context-budget-exceeded',
        });
        continue;
      }
      // Prefer dropping historical / lower authority entirely
      if (entry.historical || AUTHORITY_RANK[entry.authority] < 50) {
        excluded.push({
          id: entry.id,
          sourceType: entry.sourceType,
          pathOrUrl: entry.pathOrUrl,
          authority: entry.authority,
          freshnessIso: read.mtimeIso ?? nowIso,
          contentHash: sha256(read.content),
          bytesLoaded: 0,
          historical: !!entry.historical,
          selected: false,
          exclusionReason: 'context-budget-exceeded',
        });
        continue;
      }
      // High-authority: load bounded excerpt only (never invent; truncate with marker)
      const sliceChars = Math.max(200, Math.floor(remaining * 0.9));
      loadContent =
        read.content.slice(0, sliceChars) +
        `\n\n/* truncated-for-context-budget hash-of-full=${sha256(read.content)} */\n`;
      size = Buffer.byteLength(loadContent, 'utf8');
      if (bytesUsed + size > budget) {
        excluded.push({
          id: entry.id,
          sourceType: entry.sourceType,
          pathOrUrl: entry.pathOrUrl,
          authority: entry.authority,
          freshnessIso: read.mtimeIso ?? nowIso,
          contentHash: sha256(read.content),
          bytesLoaded: 0,
          historical: !!entry.historical,
          selected: false,
          exclusionReason: 'context-budget-exceeded',
        });
        continue;
      }
    }

    bytesUsed += size;
    contents.set(entry.id, loadContent);
    const src: ContextSource = {
      id: entry.id,
      sourceType: entry.sourceType,
      pathOrUrl: entry.pathOrUrl,
      authority: entry.authority,
      freshnessIso: read.mtimeIso ?? nowIso,
      contentHash: sha256(read.content), // full-file hash even when excerpt loaded
      bytesLoaded: size,
      historical: !!entry.historical,
      selected: true,
    };
    selectedSources.push(src);
    facts.push(...extractFactsFromContent(entry, loadContent, contract));

    if (entry.historical) {
      staleInformation.push(`historical-source:${entry.pathOrUrl}`);
    }
  }

  // Stale summary must not override newer receipt: if both selected, note constraint
  const hasReceipt = selectedSources.some((s) => s.authority === 'recent-receipt');
  const hasHistorical = selectedSources.some((s) => s.historical);
  const hasCompact = selectedSources.some((s) => s.authority === 'current-compact');
  if (hasReceipt && (hasHistorical || hasCompact)) {
    facts.push({
      text: 'Precedence: recent receipt overrides stale summary / historical language',
      kind: 'constraint',
      citation: 'context-assembly-precedence',
    });
  }

  const contradictions = [
    ...detectContradictions(selectedSources, contents),
    ...resolution.conflicts,
  ];

  const readOnly = isReadOnlyAudit(contract);
  const externalTarget =
    selectedSources.find((s) => s.authority === 'external-readonly-target')?.pathOrUrl ?? null;

  const projectExecutionReady = resolution.status === 'READY' && !!resolution.canonicalPath;
  const readOnlyTargetReady =
    readOnly &&
    (projectExecutionReady ||
      (!!externalTarget && resolution.status !== 'NEEDS_APPROVAL' && projectId !== 'prj_unknown'));

  // Integronix: repo BLOCKED + external target + read-only → READY_TO_PLAN for audit only
  let planningStatus: AtlasContextPack['planningStatus'] = 'BLOCKED';
  let confidence: AtlasContextPack['contextConfidence'] = 'none';
  const blockers: string[] = [...resolution.conflicts.filter((c) => /BLOCKED|absent|insufficient/i.test(c))];

  if (projectId === 'prj_unknown') {
    planningStatus = 'BLOCKED';
    blockers.push('Unknown project identity');
  } else if (readOnly && externalTarget && !projectExecutionReady) {
    planningStatus = 'READY_TO_PLAN';
    confidence = 'medium';
    assumptions.push(
      'READ-ONLY TARGET READY for audit planning; PROJECT EXECUTION remains blocked until repository authority resolves',
    );
    blockers.push('PROJECT EXECUTION NOT READY — repository unresolved');
    facts.push({
      text: 'READ-ONLY TARGET READY ≠ PROJECT EXECUTION READY',
      kind: 'constraint',
      citation: 'context-assembly-policy',
    });
  } else if (projectExecutionReady && resolution.workingTree === 'dirty') {
    planningStatus = 'NEEDS_APPROVAL';
    confidence = 'medium';
    blockers.push('Dirty worktree requires CEO approval before planning writes');
  } else if (projectExecutionReady) {
    planningStatus = 'READY_TO_PLAN';
    confidence = 'high';
  } else if (resolution.status === 'NEEDS_APPROVAL') {
    planningStatus = 'NEEDS_APPROVAL';
    confidence = 'low';
    blockers.push(...resolution.conflicts.slice(0, 3));
  } else {
    planningStatus = 'BLOCKED';
    confidence = 'low';
    if (!externalTarget) missingEvidence.push('no-verified-path-and-no-external-target');
  }

  if (missingEvidence.length > 3 && planningStatus === 'READY_TO_PLAN' && !readOnlyTargetReady) {
    planningStatus = 'NEEDS_APPROVAL';
  }

  // Separate personal vs project memory in assumptions note
  const personalCount = selectedSources.filter((s) => s.sourceType === 'personal-memory').length;
  const projectMemCount = selectedSources.filter((s) =>
    ['project-memory', 'repository-doc', 'receipt', 'decision'].includes(s.sourceType),
  ).length;
  assumptions.push(
    `Source mix: ${personalCount} personal-memory + ${projectMemCount} project/repo sources (personal memory not fully crawled)`,
  );

  const decisions = facts.filter((f) => f.kind === 'decision').map((f) => f.text);
  const constraints = [
    ...facts.filter((f) => f.kind === 'constraint').map((f) => f.text),
    ...contract.forbiddenActions.slice(0, 5).map((a) => `forbidden:${a}`),
  ];
  const knownBlockers = [
    ...blockers,
    ...facts.filter((f) => f.kind === 'blocker').map((f) => f.text),
  ];

  const pack = parseAtlasContextPack({
    goalId,
    projectId,
    verifiedProjectPath: resolution.canonicalPath,
    externalTarget,
    readOnlyTargetReady: !!readOnlyTargetReady,
    projectExecutionReady,
    selectedSources: [...selectedSources, ...excluded],
    facts: facts.filter((f) => f.kind === 'fact' || f.kind === 'inference'),
    decisions,
    constraints,
    knownBlockers: [...new Set(knownBlockers)],
    unresolvedContradictions: contradictions,
    staleInformation,
    assumptions: [
      ...assumptions,
      ...facts.filter((f) => f.kind === 'assumption').map((f) => f.text),
    ],
    missingEvidence,
    contextConfidence: confidence,
    contextBudgetBytes: budget,
    contextBytesUsed: bytesUsed,
    planningStatus,
    conciseCeoSummary: `${projectId}: plan=${planningStatus}; execReady=${projectExecutionReady}; readOnlyTarget=${!!readOnlyTargetReady}; bytes=${bytesUsed}/${budget}`,
  });

  // Preserve goal intent verbatim
  const goalContract: AtlasGoalContract = {
    ...contract,
    originalCeoMessage: contract.originalCeoMessage,
    interpretedObjective: contract.interpretedObjective,
  };

  return { pack, goalContract, filesTouchedForWrite };
}

/** Test helper: in-memory reader */
export function memoryReader(map: Record<string, { content: string; mtimeIso?: string }>): ContextSourceReader {
  return {
    read(pathOrUrl: string) {
      const hit = map[pathOrUrl];
      if (!hit) return { ok: false, content: '', mtimeIso: null, error: 'missing' };
      return { ok: true, content: hit.content, mtimeIso: hit.mtimeIso ?? '2026-08-04T00:00:00.000Z' };
    },
  };
}

export function assertNoWrites(result: AssembleContextResult): void {
  if (result.filesTouchedForWrite.length > 0) {
    throw new AtlasContextAssemblyError('assembly attempted writes', 'INVALID');
  }
}
