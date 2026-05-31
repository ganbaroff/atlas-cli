/**
 * Atlas agent — Mastra-powered, multi-model, tool-equipped.
 */

import { Agent } from '@mastra/core/agent';
import { IDENTITY } from './atlas/identity.js';
import { buildAtlasBrainPlan, type AtlasBrainChannel } from './atlas/brain-planner.js';
import { routeModel, type ModelRole } from './model-router.js';
import { readFileTool } from './tools/read-file.js';
import { writeFileTool } from './tools/write-file.js';
import { globTool } from './tools/glob.js';
import { grepTool } from './tools/grep.js';
import { shellTool } from './tools/shell.js';
import { listSkillsTool, loadSkillTool } from './tools/skill.js';

export async function createAtlasAgent(role: ModelRole = 'WORKER', channel: AtlasBrainChannel = 'cli'): Promise<Agent> {
  const route = routeModel({ role });
  const plan = await buildAtlasBrainPlan({ channel, role });

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
    },
  });
}

export { routeModel, listAvailableModels } from './model-router.js';
