/**
 * @volaura/atlas-core — canonical Atlas identity + voice + memory interface.
 * Atlas identity + voice + memory for Atlas CLI.
 */
export { IDENTITY, loadIdentity, loadIdentityFromDisk } from './identity.js';
export type { AtlasIdentity } from './identity.js';

export { chat, remember, recall, reflect, resetAgent } from './mastra-agent.js';

export { validateVoice } from './voice.js';
export type { Breach, VoiceCheckResult } from './voice.js';

export { recordEcosystemEvent } from './memory.js';
export type {
  EcosystemEvent,
  SourceProduct,
  RecordEventInput,
} from './memory.js';
