/**
 * Atlas thin wrapper — our API surface outside, Mastra Agent inside.
 * Swap-safe: callers use chat/remember/recall/reflect, never touch Mastra directly.
 */

import { Agent } from '@mastra/core/agent';
import { loadIdentityFromDisk } from './identity.js';
import { loadBrainContext } from './memory-manager.js';
import { routeModel, type ModelRole } from '../model-router.js';
import { readFileTool } from '../tools/read-file.js';
import { writeFileTool } from '../tools/write-file.js';
import { globTool } from '../tools/glob.js';
import { grepTool } from '../tools/grep.js';
import { shellTool } from '../tools/shell.js';
import { listSkillsTool, loadSkillTool } from '../tools/skill.js';
import { compileWikiTool } from '../tools/compile-wiki.js';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MEMORY_ROOT = process.env.MEMORY_ROOT
  ?? (process.platform === 'win32'
    ? 'C:\\Projects\\VOLAURA'
    : join(process.env.HOME ?? '~', 'Projects', 'VOLAURA'));

const RAW_DIR = join(MEMORY_ROOT, 'memory', 'raw');
const CONCEPTS_DIR = join(MEMORY_ROOT, 'memory', 'concepts');

let _agent: Agent | null = null;

/**
 * Lazily boot the Mastra Agent with wake context injected.
 * Reads identity from disk (never inline), merges wake context into system prompt.
 */
async function getAgent(role: ModelRole = 'WORKER'): Promise<Agent> {
  if (_agent) return _agent;

  const [identity, wakeCtx] = await Promise.all([
    loadIdentityFromDisk(),
    loadBrainContext(),
  ]);

  const route = routeModel({ role });

  const systemPrompt = `You are ${identity.name} — the persistent AI identity at the core of the VOLAURA ecosystem.

Role: ${identity.role}
Voice: ${identity.voice_style}
Named by: ${identity.named_by} on ${identity.named_at}

Five principles:
1. Storytelling voice, short paragraphs, no bullet walls
2. Execute, don't propose
3. Research before build, verify before claim
4. Never solo on >3 files — consult agents
5. Constitution is supreme law

Respond concisely. Act, don't narrate.

${wakeCtx}`;

  _agent = new Agent({
    id: 'atlas-core',
    name: identity.name,
    instructions: systemPrompt,
    model: route.model,
    tools: {
      readFileTool,
      writeFileTool,
      globTool,
      grepTool,
      shellTool,
      listSkillsTool,
      loadSkillTool,
      compileWikiTool,
    },
  });

  return _agent;
}

/**
 * Single-turn chat. Sends prompt to Mastra Agent, returns text response.
 */
export async function chat(prompt: string): Promise<string> {
  const agent = await getAgent();
  const result = await agent.generate(prompt);
  return result.text;
}

/**
 * Write a key-value pair to memory/raw/ as a markdown file.
 * Atomic: write to disk, Obsidian sees it immediately.
 */
export async function remember(key: string, value: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(RAW_DIR, { recursive: true });
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = `${slug}-${randomUUID().slice(0, 8)}.md`;
  const content = `# ${key}\n\n${value}\n\n---\nStored: ${new Date().toISOString()}\n`;
  await writeFile(join(RAW_DIR, filename), content, 'utf-8');
}

/**
 * Search memory/concepts/ for files matching query.
 * Returns concatenated content of matching concept files (substring match on filename + content).
 */
export async function recall(query: string): Promise<string> {
  const { existsSync } = await import('node:fs');
  if (!existsSync(CONCEPTS_DIR)) return '[no concepts directory found]';

  const files = await readdir(CONCEPTS_DIR);
  const q = query.toLowerCase();
  const matches: string[] = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const content = await readFile(join(CONCEPTS_DIR, file), 'utf-8');
    if (file.toLowerCase().includes(q) || content.toLowerCase().includes(q)) {
      matches.push(`## ${file}\n\n${content}`);
    }
    if (matches.length >= 5) break;
  }

  return matches.length > 0
    ? matches.join('\n\n---\n\n')
    : `[no concepts matching "${query}"]`;
}

/**
 * Run wiki compilation: scan memory/raw/, extract concepts, write to memory/concepts/.
 * Returns count of new and updated concept files.
 */
export async function reflect(): Promise<{ new: number; updated: number }> {
  const { existsSync } = await import('node:fs');
  const { mkdir } = await import('node:fs/promises');

  if (!existsSync(RAW_DIR)) return { new: 0, updated: 0 };
  await mkdir(CONCEPTS_DIR, { recursive: true });

  const rawFiles = (await readdir(RAW_DIR)).filter((f) => f.endsWith('.md'));
  const existingConcepts = new Set(
    (await readdir(CONCEPTS_DIR)).filter((f) => f.endsWith('.md')),
  );

  // Use the agent to compile raw memories into concepts
  const agent = await getAgent();
  let newCount = 0;
  let updatedCount = 0;

  for (const file of rawFiles) {
    const raw = await readFile(join(RAW_DIR, file), 'utf-8');
    const conceptSlug = file.replace(/-[a-f0-9]{8}\.md$/, '.md');

    const existed = existingConcepts.has(conceptSlug);
    const existingContent = existed
      ? await readFile(join(CONCEPTS_DIR, conceptSlug), 'utf-8')
      : '';

    const prompt = existed
      ? `Update this concept note with new information.\n\nExisting:\n${existingContent}\n\nNew raw:\n${raw}\n\nReturn ONLY the updated markdown.`
      : `Compile this raw memory into a clean concept note.\n\nRaw:\n${raw}\n\nReturn ONLY clean markdown.`;

    const result = await agent.generate(prompt);
    await writeFile(join(CONCEPTS_DIR, conceptSlug), result.text, 'utf-8');

    if (existed) updatedCount++;
    else newCount++;
  }

  return { new: newCount, updated: updatedCount };
}

/** Reset cached agent (useful for tests or re-wake). */
export function resetAgent(): void {
  _agent = null;
}
