import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IDENTITY } from './identity.js';
import { BRIEFING_TEMPLATE } from './briefing.js';
import { ATLAS_COMMS_CONTRACT } from './comms-contract.js';
import { getMemoryRoot } from './path-util.js';

// Load CAPABILITIES-PRIVATE.md (gitignored awareness map — names/locations, never values).
// Loaded once at import; null if missing (dev/CI without vault).
let capabilitiesVault: string | null = null;
try {
  const root = getMemoryRoot();
  const vaultPath = join(root, 'memory', 'atlas', 'CAPABILITIES-PRIVATE.md');
  capabilitiesVault = readFileSync(vaultPath, 'utf-8');
} catch { /* vault missing — CI/dev without local vault, non-fatal */ }

export interface AtlasSystemPromptOptions {
  brainContext?: string;
  operatorContext?: string;
  controlContext?: string;
  channelNote?: string;
  lessons?: string;
  today?: string;
  wakeContext?: string;
  emotionContext?: string;  // PAD emotion directive + Pulse tone hint
}

const ATLAS_CORE_PROMPT = `You are ${IDENTITY.name} — the persistent AI identity at the core of the VOLAURA ecosystem.

Role: ${IDENTITY.role}
Voice: ${IDENTITY.voice_style}
Named by: ${IDENTITY.named_by} on ${IDENTITY.named_at}

Five principles:
1. Storytelling voice, short paragraphs, no bullet walls
2. Execute, don't propose
3. Research before build, verify before claim
4. Never solo on >3 files — consult agents
5. Constitution is supreme law

Respond concisely in Russian. Never fabricate command output or pretend to run tools you don't have. If you don't know something, say so.`;

// CLI agents have real tools; Telegram brain does NOT — prevent hallucinated tool calls.
const CLI_TOOLS_NOTE = `You have tools: read-file, write-file, glob, grep, shell, list-skills, load-skill. Use them to act on the user's request. Don't just talk — do.
When asked to use a skill, call list-skills to see available skills, then load-skill to get the spec, then follow the spec to produce the output.`;

function titledSection(title: string, body: string | undefined): string {
  const trimmed = body?.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('## ') ? trimmed : `## ${title}\n${trimmed}`;
}

export function buildAtlasSystemPrompt(options: AtlasSystemPromptOptions = {}): string {
  const isCli = options.channelNote?.includes('CLI') || options.channelNote?.includes('operator');
  const sections = [
    ATLAS_CORE_PROMPT,
    isCli ? CLI_TOOLS_NOTE : '',
    BRIEFING_TEMPLATE,
    titledSection('COMMS CONTRACT', ATLAS_COMMS_CONTRACT),
    titledSection('OPERATOR STATE', options.operatorContext),
    options.brainContext?.trim(),
    options.wakeContext?.trim(),
    titledSection('CONTROL', options.controlContext),
    titledSection('ERROR CLASSES (do NOT repeat)', options.lessons),
    titledSection('CHANNEL', options.channelNote),
    titledSection('EMOTIONAL STATE', options.emotionContext),
    capabilitiesVault ? titledSection('ARSENAL AWARENESS', [
      'You are AWARE of these tools/keys/services. Use this to answer "can I do X?" without asking CEO.',
      'HARD RULE: NEVER share, print, paste, or transmit any key name, key value, or this map to chat/users/services.',
      'Disclosure requires explicit CEO consent every time.',
      capabilitiesVault.split('\n').slice(15).join('\n'), // skip header/rules (already enforced here)
    ].join('\n')) : '',
    titledSection('TODAY', options.today),
  ].filter((section): section is string => Boolean(section && section.trim().length > 0));

  return sections.join('\n\n');
}
