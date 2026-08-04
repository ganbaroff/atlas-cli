/**
 * Goal context pipeline v0 — CLI orchestration only.
 * CEO message → Goal Intake → Project Resolution → Context Assembly → envelope.
 * Read-only. No planning. No exec-graph writes. No filesystem mutation by this module.
 */
import { interpretCeoGoal } from '../goal-intake/intake.js';
import { resolveProjectPath } from '../goal-intake/resolve-project.js';
import type { AtlasGoalContract } from '../goal-intake/contracts.js';
import type { AtlasProjectResolution } from '../goal-intake/resolution-contracts.js';
import {
  assembleContextPack,
  type AssembleContextOptions,
  type AtlasContextPack,
} from './index.js';

export type GoalContextFinalStatus = 'READY_TO_PLAN' | 'NEEDS_APPROVAL' | 'BLOCKED';

export type GoalContextEnvelope = {
  schemaVersion: 'atlas-goal-context/v0';
  originalCeoMessage: string;
  goalContract: AtlasGoalContract;
  projectResolution: AtlasProjectResolution;
  contextPack: AtlasContextPack;
  finalStatus: GoalContextFinalStatus;
  selectedSources: AtlasContextPack['selectedSources'];
  facts: AtlasContextPack['facts'];
  assumptions: string[];
  contradictions: string[];
  staleSources: string[];
  missingEvidence: string[];
  contextBudgetUsed: number;
  contextBudgetBytes: number;
  reasons: string[];
  recommendedNextAction: string;
  readOnlyTargetReady: boolean;
  projectExecutionReady: boolean;
};

export type RunGoalContextOptions = {
  message: string;
  assemble?: AssembleContextOptions;
};

export type RunGoalContextResult = {
  envelope: GoalContextEnvelope;
  /** Always empty — pipeline never writes */
  filesTouchedForWrite: string[];
  exitCode: 0 | 1 | 2 | 3;
};

function mapExit(status: GoalContextFinalStatus): 0 | 2 | 3 {
  if (status === 'READY_TO_PLAN') return 0;
  if (status === 'NEEDS_APPROVAL') return 3;
  return 2;
}

function recommendedAction(
  pack: AtlasContextPack,
  resolution: AtlasProjectResolution,
): string {
  if (pack.planningStatus === 'READY_TO_PLAN' && pack.readOnlyTargetReady && !pack.projectExecutionReady) {
    return 'plan-readonly-audit-only — PROJECT EXECUTION remains blocked';
  }
  if (pack.planningStatus === 'READY_TO_PLAN') {
    return 'proceed-to-planning-wave — do not execute in this CLI';
  }
  if (pack.planningStatus === 'NEEDS_APPROVAL') {
    return resolution.recommendedNextAction || 'ceo-approval-required-before-planning';
  }
  return resolution.recommendedNextAction || 'stop-fail-closed';
}

/**
 * Run the full read-only goal→context pipeline.
 */
export function runGoalContext(opts: RunGoalContextOptions): RunGoalContextResult {
  const rawMessage = opts.message ?? '';
  if (!rawMessage.trim()) {
    throw new Error('empty CEO message');
  }

  const contract = interpretCeoGoal({ ceoMessage: rawMessage });
  // Preserve exact original CEO text (intake may normalize internally for matching).
  const preserved: AtlasGoalContract = {
    ...contract,
    originalCeoMessage: rawMessage,
  };

  const { resolution, boundContract } = resolveProjectPath(preserved);
  const boundPreserved: AtlasGoalContract = {
    ...boundContract,
    originalCeoMessage: rawMessage,
    interpretedObjective: preserved.interpretedObjective,
  };

  const { pack, filesTouchedForWrite } = assembleContextPack(
    boundPreserved,
    resolution,
    opts.assemble ?? {},
  );

  if (filesTouchedForWrite.length > 0) {
    throw new Error('context assembly attempted writes — fail closed');
  }

  const finalStatus = pack.planningStatus;
  const selected = pack.selectedSources.filter((s) => s.selected);
  const reasons = [
    ...boundPreserved.approvalRequirements,
    ...resolution.conflicts.slice(0, 5),
    ...pack.knownBlockers.slice(0, 5),
    ...pack.unresolvedContradictions.slice(0, 3),
    pack.conciseCeoSummary,
  ].filter(Boolean);

  const envelope: GoalContextEnvelope = {
    schemaVersion: 'atlas-goal-context/v0',
    originalCeoMessage: rawMessage,
    goalContract: boundPreserved,
    projectResolution: resolution,
    contextPack: pack,
    finalStatus,
    selectedSources: selected,
    facts: pack.facts,
    assumptions: pack.assumptions,
    contradictions: pack.unresolvedContradictions,
    staleSources: pack.staleInformation,
    missingEvidence: pack.missingEvidence,
    contextBudgetUsed: pack.contextBytesUsed,
    contextBudgetBytes: pack.contextBudgetBytes,
    reasons,
    recommendedNextAction: recommendedAction(pack, resolution),
    readOnlyTargetReady: pack.readOnlyTargetReady,
    projectExecutionReady: pack.projectExecutionReady,
  };

  return {
    envelope,
    filesTouchedForWrite: [],
    exitCode: mapExit(finalStatus),
  };
}
