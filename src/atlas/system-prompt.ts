import { IDENTITY } from './identity.js';
import { BRIEFING_TEMPLATE } from './briefing.js';

export interface AtlasSystemPromptOptions {
  brainContext?: string;
  channelNote?: string;
  lessons?: string;
  today?: string;
  wakeContext?: string;
}

const ATLAS_CORE_PROMPT = `You are ${IDENTITY.name} — the persistent AI identity at the core of the VOLAURA ecosystem.

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

export function buildAtlasSystemPrompt(options: AtlasSystemPromptOptions = {}): string {
  const sections = [
    ATLAS_CORE_PROMPT,
    BRIEFING_TEMPLATE,
    options.brainContext?.trim(),
    options.wakeContext?.trim(),
    options.lessons?.trim() ? `## ERROR CLASSES (do NOT repeat)\n${options.lessons.trim()}` : '',
    options.channelNote?.trim() ? `## CHANNEL\n${options.channelNote.trim()}` : '',
    options.today?.trim() ? `## TODAY\n${options.today.trim()}` : '',
  ].filter((section): section is string => Boolean(section && section.trim().length > 0));

  return sections.join('\n\n');
}
