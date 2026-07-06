/**
 * Atlas agent — Mastra-powered, multi-model, tool-equipped.
 */

import { Agent } from '@mastra/core/agent';
import { IDENTITY } from './atlas/identity.js';
import { buildAtlasBrainPlan, type AtlasBrainChannel } from './atlas/brain-planner.js';
import { routeModel, type ModelRole } from './model-router.js';
import { recordSpendFromResult } from './atlas/spend-tracker.js';
import { enforceSpendPolicy } from './atlas/spend-policy.js';
import { readFileTool } from './tools/read-file.js';
import { writeFileTool } from './tools/write-file.js';
import { globTool } from './tools/glob.js';
import { grepTool } from './tools/grep.js';
import { shellTool } from './tools/shell.js';
import { listSkillsTool, loadSkillTool } from './tools/skill.js';
import { surfTool } from './tools/surf.js';

export async function createAtlasAgent(
  role: ModelRole = 'WORKER',
  channel: AtlasBrainChannel = 'cli',
  recentUserMessages: string[] = [],
): Promise<Agent> {
  // Canon (CLAUDE.md / atlas_swarm_daemon.py:19): "Never use Claude as swarm agent."
  // createAtlasAgent is the swarm/cli agent factory — exclude anthropic here so a dead
  // free provider can never fall back to Claude. The telegram brain reply path builds its
  // own agent via routeModelWithFallback and keeps anthropic as its permitted user-facing last resort.
  const route = routeModel({ role, excludeProviders: ['anthropic'] });
  enforceSpendPolicy(route.provider, channel);
  const plan = await buildAtlasBrainPlan({ channel, role, recentUserMessages });

  return new Agent({
    id: 'atlas-core',
    name: IDENTITY.name,
    instructions: plan.systemPrompt,
    model: route.model,
    tools: {
      readFileTool,
      writeFileTool,
      globTool,
      grepTool,
      shellTool,
      listSkillsTool,
      loadSkillTool,
      surfTool,
    },
  });
}

/**
 * Route-aware agent factory. Returns the built agent plus the resolved route so
 * callers can attribute LLM spend (FinOps telemetry) to a provider/model.
 */
export async function createAtlasAgentWithRoute(
  role: ModelRole = 'WORKER',
  channel: AtlasBrainChannel = 'cli',
  recentUserMessages: string[] = [],
): Promise<{ agent: Agent; route: ReturnType<typeof routeModel> }> {
  const route = routeModel({ role, excludeProviders: ['anthropic'] });
  enforceSpendPolicy(route.provider, channel);
  const plan = await buildAtlasBrainPlan({ channel, role, recentUserMessages });
  const agent = new Agent({
    id: 'atlas-core',
    name: IDENTITY.name,
    instructions: plan.systemPrompt,
    model: route.model,
    tools: {
      readFileTool,
      writeFileTool,
      globTool,
      grepTool,
      shellTool,
      listSkillsTool,
      loadSkillTool,
      surfTool,
    },
  });
  return { agent, route };
}

/** Record spend for an agent.generate() result against a known route. */
export function recordAgentSpend(
  result: unknown,
  route: { provider: string; modelId: string },
  caller: string,
): void {
  recordSpendFromResult(result, { provider: route.provider, model: route.modelId, caller });
}

export { routeModel, listAvailableModels } from './model-router.js';
