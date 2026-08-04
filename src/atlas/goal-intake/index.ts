export {
  AtlasGoalIntakeError,
  atlasGoalContractSchema,
  parseAtlasGoalContract,
  type AtlasGoalContract,
  type GoalIntakeRisk,
  type GoalIntakeStatus,
} from './contracts.js';
export {
  GOAL_INTAKE_PROJECT_REGISTRY,
  DEFAULT_APPROVED_DISCOVERY_ROOTS,
  findProjectByAlias,
  getProjectById,
  withRegistryOverrides,
  type RegistryProject,
  type RegistryPathCandidate,
  type RegistryLifecycle,
  type RegistryPathType,
} from './project-registry.js';
export { interpretCeoGoal, intakeCeoGoal, type InterpretGoalInput, type BindGoalOptions } from './intake.js';
export { isReadOnlyCeoIntent, READ_ONLY_CEO_INTENT_RE } from './read-only-intent.js';
export {
  AtlasProjectResolutionError,
  atlasProjectResolutionSchema,
  parseAtlasProjectResolution,
  type AtlasProjectResolution,
  type ResolutionStatus,
  type ResolutionPathType,
} from './resolution-contracts.js';
export {
  resolveProjectPath,
  bindResolution,
  createDefaultPathProbe,
  normalizeAtlasPath,
  type PathProbe,
  type FsEntryProbe,
  type GitProbeResult,
  type ResolveProjectOptions,
  type ResolveProjectResult,
} from './resolve-project.js';
