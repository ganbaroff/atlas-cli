/**
 * Swarm perspectives — loaded from user config, not bundled in package.
 * Perspective names, instructions, and provider assignments are internal
 * architecture. Published dist ships only generic defaults.
 *
 * Resolution order:
 *   1. ATLAS_PERSPECTIVES_PATH env var
 *   2. ~/.atlas/perspectives.json
 *   3. Built-in generic defaults
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Perspective {
  name: string;
  instruction: string;
  provider?: string;
}

const DEFAULT_PERSPECTIVES: Perspective[] = [
  {
    name: 'reviewer-1',
    instruction: 'Review for correctness, edge cases, and potential failures.',
  },
  {
    name: 'reviewer-2',
    instruction: 'Review for simplicity. Flag unnecessary complexity.',
  },
  {
    name: 'reviewer-3',
    instruction: 'Review for security. Assume hostile input on every boundary.',
  },
];

function loadFromFile(path: string): Perspective[] | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(raw)) return null;
    return raw.filter(
      (p: any) => typeof p.name === 'string' && typeof p.instruction === 'string',
    );
  } catch {
    return null;
  }
}

function loadPerspectives(): Perspective[] {
  const envPath = process.env.ATLAS_PERSPECTIVES_PATH;
  if (envPath) {
    const loaded = loadFromFile(envPath);
    if (loaded?.length) return loaded;
  }

  const homePath = join(homedir(), '.atlas', 'perspectives.json');
  const loaded = loadFromFile(homePath);
  if (loaded?.length) return loaded;

  return DEFAULT_PERSPECTIVES;
}

export const PERSPECTIVES: Perspective[] = loadPerspectives();

export function getPerspective(name: string): Perspective | undefined {
  return PERSPECTIVES.find(p => p.name === name);
}

export function assignPerspectives(taskCount?: number): Perspective[] {
  const count = taskCount ?? PERSPECTIVES.length;
  return PERSPECTIVES.slice(0, Math.min(count, PERSPECTIVES.length));
}
