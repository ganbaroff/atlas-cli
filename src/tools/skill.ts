import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SKILLS_DIR = 'C:/Projects/VOLAURA/memory/swarm/skills';

export const listSkillsTool = createTool({
  id: 'list-skills',
  description: 'List all available VOLAURA ecosystem skills. Each skill is a specialized capability of Atlas.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    skills: z.array(z.string()),
  }),
  execute: async () => {
    try {
      const files = await readdir(SKILLS_DIR);
      const skills = files
        .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
        .map((f) => f.replace('.md', ''));
      return { skills };
    } catch {
      return { skills: [] };
    }
  },
});

export const loadSkillTool = createTool({
  id: 'load-skill',
  description: 'Load a VOLAURA skill definition by name. Returns the full skill spec as markdown.',
  inputSchema: z.object({
    name: z.string().describe('Skill name, e.g. "behavior-pattern-analyzer"'),
  }),
  outputSchema: z.object({
    content: z.string(),
    found: z.boolean(),
  }),
  execute: async ({ name }) => {
    try {
      const path = join(SKILLS_DIR, `${name}.md`);
      const content = await readFile(path, 'utf-8');
      return { content, found: true };
    } catch {
      return { content: '', found: false };
    }
  },
});
