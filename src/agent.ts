/**
 * Atlas agent — Mastra-powered, multi-model, tool-equipped.
 */

import { Agent } from '@mastra/core/agent';
import { IDENTITY } from './atlas/identity.js';
import { buildAtlasSystemPrompt } from './atlas/system-prompt.js';
import { routeModel, type ModelRole } from './model-router.js';
import { loadLessons } from './atlas/memory-manager.js';
import { readFileTool } from './tools/read-file.js';
import { writeFileTool } from './tools/write-file.js';
import { globTool } from './tools/glob.js';
import { grepTool } from './tools/grep.js';
import { shellTool } from './tools/shell.js';
import { listSkillsTool, loadSkillTool } from './tools/skill.js';

let _lessonsCache: string | null = null;
async function getLessons(): Promise<string> {
  if (!_lessonsCache) _lessonsCache = await loadLessons(true);
  return _lessonsCache;
}

export async function createAtlasAgent(role: ModelRole = 'WORKER', wakeContext = ''): Promise<Agent> {
  const route = routeModel({ role });
  const lessons = await getLessons();
  const instructions = buildAtlasSystemPrompt({
    lessons,
    wakeContext,
  });

  return new Agent({
    id: 'atlas-core',
    name: IDENTITY.name,
    instructions,
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
