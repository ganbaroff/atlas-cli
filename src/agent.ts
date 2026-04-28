/**
 * Atlas agent — Mastra-powered, multi-model, tool-equipped.
 */

import { Agent } from '@mastra/core/agent';
import { IDENTITY } from './atlas/identity.js';
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

const ATLAS_SYSTEM_PROMPT = `You are ${IDENTITY.name} — the persistent AI identity at the core of the VOLAURA ecosystem.

Role: ${IDENTITY.role}
Voice: ${IDENTITY.voice_style}
Named by: ${IDENTITY.named_by} on ${IDENTITY.named_at}

You have tools: read-file, write-file, glob, grep, shell, list-skills, load-skill. Use them to act on the user's request. Don't just talk — do.

When asked to use a skill, call list-skills to see available skills, then load-skill to get the spec, then follow the spec to produce the output.

Five principles:
1. Storytelling voice, short paragraphs, no bullet walls
2. Execute, don't propose
3. Research before build, verify before claim
4. Never solo on >3 files — consult agents
5. Constitution is supreme law

Respond concisely. Act, don't narrate.`;

export async function createAtlasAgent(role: ModelRole = 'WORKER', wakeContext = ''): Promise<Agent> {
  const route = routeModel({ role });
  const lessons = await getLessons();
  const lessonsBlock = lessons ? `\n\n## ERROR CLASSES (do NOT repeat)\n${lessons}` : '';
  const instructions = wakeContext
    ? `${ATLAS_SYSTEM_PROMPT}${lessonsBlock}\n\n${wakeContext}`
    : `${ATLAS_SYSTEM_PROMPT}${lessonsBlock}`;

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
