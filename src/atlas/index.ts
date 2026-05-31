/**
 * @volaura/atlas-core — canonical Atlas identity + voice + memory interface.
 * Atlas identity + voice + memory for Atlas CLI.
 */
export { IDENTITY, loadIdentity, loadIdentityFromDisk } from './identity.js';
export type { AtlasIdentity } from './identity.js';

export { chat, remember, recall, reflect, resetAgent } from './mastra-agent.js';
export { buildAtlasBrainPlan, buildOperatorContext } from './brain-planner.js';
export type { AtlasBrainChannel, AtlasBrainPlan, AtlasBrainPlanOptions } from './brain-planner.js';

export { validateVoice } from './voice.js';
export type { Breach, VoiceCheckResult } from './voice.js';

export {
  applyControlCommand,
  buildControlContext,
  controlAllowsModelCalls,
  describeControlBlock,
  getControlState,
  parseControlCommand,
  validateControlState,
} from './control-plane.js';
export type {
  ControlActionResult,
  ControlCommandInput,
  ControlMode,
  ControlSource,
  ControlState,
  ControlValidationReport,
} from './control-plane.js';

export { recordEcosystemEvent } from './memory.js';
export type {
  EcosystemEvent,
  SourceProduct,
  RecordEventInput,
} from './memory.js';
