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
  findProjectByAlias,
  getProjectById,
  type RegistryProject,
} from './project-registry.js';
export { interpretCeoGoal, intakeCeoGoal, type InterpretGoalInput, type BindGoalOptions } from './intake.js';
