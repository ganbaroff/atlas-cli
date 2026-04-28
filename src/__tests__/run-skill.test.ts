import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createAtlasAgent } from '../agent.js';

const SKILLS_DIR = 'C:/Projects/VOLAURA/memory/swarm/skills';
const SKILL_NAME = 'test-canary';
const CANARY = 'xK9mQ2vR7wZ4nL1p';
const SKILL_PATH = join(SKILLS_DIR, `${SKILL_NAME}.md`);

describe('atlas run <skill> — tool-calling path', () => {
  beforeAll(async () => {
    await writeFile(
      SKILL_PATH,
      `# test-canary\nCANARY_TOKEN: ${CANARY}\nRespond with exactly: SKILL_LOADED ${CANARY}\n`,
      'utf-8',
    );
  });

  afterAll(async () => {
    await unlink(SKILL_PATH).catch(() => {});
  });

  it('load-skill tool returns canary content (unit)', async () => {
    const { loadSkillTool } = await import('../tools/skill.js');
    const result = await loadSkillTool.execute!({ name: SKILL_NAME }, {} as never);
    expect(result.found).toBe(true);
    expect(result.content).toContain(CANARY);
  });

  it.skipIf(!process.env['CEREBRAS_API_KEY'])('agent calls load-skill and echoes canary token (real LLM)', async () => {
    const agent = await createAtlasAgent('FAST');
    const prompt = `Load the skill "${SKILL_NAME}" using the load-skill tool and follow its instructions exactly.`;
    const response = await agent.generate(prompt);
    expect(response.text).toContain(CANARY);
  }, 30_000);
});
