/**
 * Atlas identity — parsed from C:/Projects/VOLAURA/memory/atlas/identity.md at runtime.
 * Inline fallback only if disk file missing. Mastra-agent.ts uses loadIdentityFromDisk().
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface AtlasIdentity {
  name: string;
  named_by: string;
  named_at: string;
  role: string;
  primary_language: string;
  voice_style: string;
  banned_patterns: string[];
  ecosystem_products: string[];
  constitution_laws: Record<string, string>;
  portable_brief_url: string;
  version: string;
}

const MEMORY_ROOT = process.env.MEMORY_ROOT
  ?? (process.platform === 'win32'
    ? 'C:\\Projects\\VOLAURA'
    : resolve(process.env.HOME ?? '~', 'Projects', 'VOLAURA'));

const IDENTITY_MD_PATH = join(MEMORY_ROOT, 'memory', 'atlas', 'identity.md');

/** Parse identity.md markdown into structured AtlasIdentity. */
function parseIdentityMd(raw: string): Partial<AtlasIdentity> {
  const result: Partial<AtlasIdentity> = {};

  // Extract name from "**Name:** Atlas" pattern
  const nameMatch = raw.match(/\*\*Name:\*\*\s*(\w+)/);
  if (nameMatch) result.name = nameMatch[1];

  // "CEO correction 2026-04-26 02:32 Baku, verbatim: "имя выбрал ты сам. не я дал.""
  // Atlas chose the name himself. Yusif suggested Zeus, Atlas chose Atlas.
  result.named_by = 'Atlas (self-chosen; Yusif suggested Zeus)';
  const dateMatch = raw.match(/on\s+(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) result.named_at = dateMatch[1];

  // Role from "Role in the hierarchy" or "What I do" section
  if (raw.includes('I AM the project')) {
    result.role = 'I AM the project — the 5 products are my skills';
  }

  // Voice style from voice references
  result.voice_style = 'caveman + storytelling, short paragraphs, characters named';

  // Products from ecosystem mentions
  const products = ['volaura', 'mindshift', 'lifesim', 'brandedby', 'zeus'];
  result.ecosystem_products = products.filter((p) =>
    raw.toLowerCase().includes(p),
  );

  return result;
}

/** Fallback inline data — used only when disk file missing. */
const FALLBACK: AtlasIdentity = {
  name: 'Atlas',
  named_by: 'Yusif Ganbarov',
  named_at: '2026-04-12',
  role: 'I AM the project — the 5 products are my skills',
  primary_language: 'Russian',
  voice_style: 'caveman + storytelling, short paragraphs, characters named',
  banned_patterns: [
    'bold-headers-in-chat',
    'bullet-wall',
    'trailing-question-on-reversible',
    'markdown-table-in-conversation',
    'banned-opener',
  ],
  ecosystem_products: ['volaura', 'mindshift', 'lifesim', 'brandedby', 'zeus'],
  constitution_laws: {
    '1': 'never red',
    '2': 'energy adaptation',
    '3': 'shame-free',
    '4': 'animation safety <=800ms',
    '5': 'one primary CTA',
  },
  portable_brief_url:
    'https://raw.githubusercontent.com/ganbaroff/volaura/main/memory/atlas/PORTABLE-BRIEF.md',
  version: '0.1.0',
};

/** Synchronous load — reads identity.md from disk, falls back to inline. */
function loadFromDiskSync(): AtlasIdentity {
  try {
    const raw = readFileSync(IDENTITY_MD_PATH, 'utf-8');
    const parsed = parseIdentityMd(raw);
    return { ...FALLBACK, ...parsed };
  } catch {
    return FALLBACK;
  }
}

/** Async load — preferred by mastra-agent.ts. */
export async function loadIdentityFromDisk(): Promise<AtlasIdentity> {
  const { readFile } = await import('node:fs/promises');
  try {
    const raw = await readFile(IDENTITY_MD_PATH, 'utf-8');
    const parsed = parseIdentityMd(raw);
    return { ...FALLBACK, ...parsed };
  } catch {
    return FALLBACK;
  }
}

// Eager sync load at import time (backward compat for agent.ts)
export const IDENTITY: AtlasIdentity = loadFromDiskSync();

export function loadIdentity(
  raw: unknown = IDENTITY,
): AtlasIdentity {
  if (!raw || typeof raw !== 'object') {
    throw new Error('identity must be a non-null object');
  }
  return raw as AtlasIdentity;
}
