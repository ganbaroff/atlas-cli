import type { ModelRole } from '../model-router.js';
import {
  buildControlContext,
  controlAllowsModelCalls,
  getControlState,
  readOperatorState,
  type OperatorStateRecord,
} from './control-plane.js';
import { loadBrainContext, loadLessons, loadWakeContext } from './memory-manager.js';
import { buildAtlasSystemPrompt } from './system-prompt.js';

export type AtlasBrainChannel = 'cli' | 'telegram' | 'api' | 'operator';

export interface AtlasBrainPlanOptions {
  channel: AtlasBrainChannel;
  role?: ModelRole;
  state?: OperatorStateRecord;
  brainContext?: string;
  wakeContext?: string;
  lessons?: string;
  operatorContext?: string;
}

export interface AtlasBrainPlan {
  channel: AtlasBrainChannel;
  role: ModelRole;
  state: OperatorStateRecord;
  source: 'brain' | 'wake';
  operatorContext: string;
  controlContext: string;
  lessons: string;
  channelNote: string;
  today: string;
  systemPrompt: string;
  canCallModel: boolean;
}

const CHANNEL_NOTES: Record<AtlasBrainChannel, string> = {
  cli: 'You are talking to operator on local CLI. Be concise.',
  telegram: 'You are talking to CEO Yusif via Telegram. Be concise.',
  api: 'You are talking through Atlas API. Be concise.',
  operator: 'You are planning operator work. Be concise.',
};

let lessonsCache: string | null = null;
let wakeCache: string | null = null;
let brainCache: string | null = null;

function toBulletList(items: string[]): string {
  if (items.length === 0) return '- none';
  return items.map((item) => `- ${item}`).join('\n');
}

export function buildOperatorContext(state: OperatorStateRecord = readOperatorState()): string {
  const control = getControlState(state);
  const lastRun = state.last_run;
  const proofTokens = lastRun?.proof_tokens ?? [];
  const evidenceTypes = lastRun?.evidence_types ?? [];

  return [
    '## OPERATOR STATE',
    `status: ${state.status ?? 'unknown'}`,
    `phase next: ${state.phase?.next ?? 'unknown'}`,
    `control mode: ${control.mode}`,
    `control next lane: ${control.next_lane}`,
    lastRun
      ? `last run: ${lastRun.task_id ?? 'unknown'} (${lastRun.status ?? 'unknown'})`
      : 'last run: none',
    lastRun?.trace_path ? `trace path: ${lastRun.trace_path}` : '',
    lastRun?.reason ? `reason: ${lastRun.reason}` : '',
    `proof tokens:\n${toBulletList(proofTokens)}`,
    `evidence types: ${evidenceTypes.length > 0 ? evidenceTypes.join(', ') : 'none'}`,
  ].filter((line) => line.trim().length > 0).join('\n');
}

async function getLessons(override?: string): Promise<string> {
  if (typeof override === 'string') return override;
  if (lessonsCache === null) lessonsCache = await loadLessons(true);
  return lessonsCache;
}

async function getChannelContext(
  channel: AtlasBrainChannel,
  override?: { brainContext?: string; wakeContext?: string },
): Promise<{ source: 'brain' | 'wake'; context: string }> {
  if (channel === 'telegram') {
    if (typeof override?.brainContext === 'string') {
      return { source: 'brain', context: override.brainContext };
    }
    if (brainCache === null) brainCache = await loadBrainContext();
    return { source: 'brain', context: brainCache };
  }

  if (typeof override?.wakeContext === 'string') {
    return { source: 'wake', context: override.wakeContext };
  }
  if (wakeCache === null) wakeCache = await loadWakeContext();
  return { source: 'wake', context: wakeCache };
}

export async function buildAtlasBrainPlan(options: AtlasBrainPlanOptions): Promise<AtlasBrainPlan> {
  const state = options.state ?? readOperatorState();
  const role = options.role ?? 'WORKER';
  const [lessons, channelContext] = await Promise.all([
    getLessons(options.lessons),
    getChannelContext(options.channel, {
      brainContext: options.brainContext,
      wakeContext: options.wakeContext,
    }),
  ]);

  const operatorContext = typeof options.operatorContext === 'string'
    ? options.operatorContext
    : buildOperatorContext(state);
  const controlContext = buildControlContext(state);
  const channelNote = CHANNEL_NOTES[options.channel];
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildAtlasSystemPrompt({
    brainContext: channelContext.source === 'brain' ? channelContext.context : undefined,
    wakeContext: channelContext.source === 'wake' ? channelContext.context : undefined,
    operatorContext,
    controlContext,
    lessons,
    channelNote,
    today,
  });

  return {
    channel: options.channel,
    role,
    state,
    source: channelContext.source,
    operatorContext,
    controlContext,
    lessons,
    channelNote,
    today,
    systemPrompt,
    canCallModel: controlAllowsModelCalls(state),
  };
}
