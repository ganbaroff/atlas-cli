/**
 * @volaura/atlas-core — canonical Atlas identity + voice + memory interface.
 * Ported into ANUS CLI as the persistent identity layer.
 */
export { IDENTITY, loadIdentity } from './identity.js';
export type { AtlasIdentity } from './identity.js';

export { validateVoice } from './voice.js';
export type { Breach, VoiceCheckResult } from './voice.js';

export { recordEcosystemEvent } from './memory.js';
export type {
  EcosystemEvent,
  SourceProduct,
  RecordEventInput,
} from './memory.js';
