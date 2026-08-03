/**
 * Core Execution Spine — public exports (contracts only; no external adapters).
 */
export {
  parseExecutorAdapterContract,
  executorAdapterContractSchema,
  ExecutorAdapterContractError,
  type ExecutorAdapterContract,
} from './executor-adapter-contract.js';

export {
  parseProjectAgentContract,
  projectAgentContractSchema,
  ProjectAgentContractError,
  type ProjectAgentContract,
} from './project-agent-contract.js';

export {
  parseEvidencePack,
  evidencePackSchema,
  commandRunSchema,
  effectProofSchema,
  evidenceArtifactSchema,
  EvidencePackError,
  type EvidencePack,
  type CommandRun,
  type EffectProof,
  type EvidenceArtifact,
} from './evidence-pack-contract.js';

export {
  mapSpineStageToTaskStatus,
  assertSpineStageRepresentable,
  SPINE_STAGE_TO_TASK_STATUS,
  type SpineStage,
} from './lifecycle-binding.js';

export {
  verifyEvidencePack,
  assertIndependentVerifier,
  type SpineVerifyResult,
  type SpineVerifyOptions,
} from './spine-verifier.js';
