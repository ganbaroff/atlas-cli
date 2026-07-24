/**
 * Governed tool registry — single source of truth for which tools each
 * channel gets.
 *
 * Before this file existed, src/agent.ts (CLI + swarm) and
 * src/atlas/mastra-agent.ts each hand-listed their own copy of the same
 * imports, and src/telegram.ts's live CEO-chat agent had NO tools at all
 * (every "read this file" / "run this command" request from CEO chat was
 * answered by narration instead of a real tool call). One list here, three
 * consumers (agent.ts, atlas/mastra-agent.ts, atlas/telegram-agent.ts).
 *
 * compile-wiki is intentionally NOT part of this registry — only
 * atlas/mastra-agent.ts (dead prod code, kept import-compatible) uses it,
 * and it imports compileWikiTool directly rather than through a channel here.
 */
import type { createTool } from '@mastra/core/tools';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { shellTool } from './shell.js';
import { listSkillsTool, loadSkillTool } from './skill.js';
import { surfTool } from './surf.js';
import { shrinkToolDict, cavemanShrinkEnabled } from '../atlas/caveman-shrink.js';

export type ToolChannel = 'cli' | 'telegram' | 'swarm';

/**
 * cli / swarm / telegram all get the identical 8-tool governed set today.
 * Kept as a channel-aware function (not a flat exported const) so a future
 * channel can diverge from the others without touching any consumer.
 *
 * Descriptions pass through the optional caveman-shrink compressor (see
 * docs/CAVEMAN-ADOPTION.md). Disabled by default (ATLAS_CAVEMAN_SHRINK=0) —
 * shrinkToolDict returns this exact object, byte-identical, when off.
 */
export function getToolDict(channel: ToolChannel): Record<string, ReturnType<typeof createTool>> {
  switch (channel) {
    case 'cli':
    case 'swarm':
    case 'telegram':
      return shrinkToolDict(
        {
          readFileTool,
          writeFileTool,
          globTool,
          grepTool,
          shellTool,
          listSkillsTool,
          loadSkillTool,
          surfTool,
        },
        cavemanShrinkEnabled(),
      );
  }
}
