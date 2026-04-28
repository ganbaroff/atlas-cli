/**
 * Atlas ecosystem memory interface — event recording.
 *
 * Each product surface calls recordEcosystemEvent() to drop a signal
 * into Atlas's canonical memory inbox. Atomic write via tmp + rename.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type SourceProduct =
  | 'volaura'
  | 'mindshift'
  | 'lifesim'
  | 'brandedby'
  | 'zeus'
  | 'atlas-cli';

export interface EcosystemEvent {
  source_product: SourceProduct;
  event_type: string;
  user_id: string;
  content: Record<string, unknown>;
  emotional_intensity: number;
  timestamp: string;
  event_id: string;
}

const INBOX_SUBPATH = join('memory', 'atlas', 'ecosystem-inbox');

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'event'
  );
}

function findInboxDir(startDir: string = process.cwd()): string | null {
  let current = resolve(startDir);
  while (true) {
    const marker = join(current, 'memory', 'atlas');
    if (existsSync(marker)) {
      return join(current, INBOX_SUBPATH);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function atomicWrite(target: string, payload: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, payload, { encoding: 'utf-8' });
  await rename(tmp, target);
}

function formatMarkdown(event: EcosystemEvent): string {
  const front = JSON.stringify(event, null, 2);
  const content = JSON.stringify(event.content, null, 2);
  return (
    `---\n${front}\n---\n\n` +
    `Event from **${event.source_product}** — \`${event.event_type}\`.\n\n` +
    `User \`${event.user_id}\` at ${event.timestamp}. ` +
    `Emotional intensity: ${event.emotional_intensity}/5.\n\n` +
    `Content:\n\n\`\`\`json\n${content}\n\`\`\`\n`
  );
}

export interface RecordEventInput {
  source_product: SourceProduct;
  event_type: string;
  user_id: string;
  content: Record<string, unknown>;
  emotional_intensity: number;
  inboxDir?: string;
}

export async function recordEcosystemEvent(
  input: RecordEventInput,
): Promise<string | null> {
  const now = new Date();
  const event: EcosystemEvent = {
    source_product: input.source_product,
    event_type: input.event_type,
    user_id: input.user_id,
    content: input.content,
    emotional_intensity: input.emotional_intensity,
    timestamp: now.toISOString(),
    event_id: randomUUID(),
  };

  const targetDir = input.inboxDir ?? findInboxDir();
  if (!targetDir) {
    return null;
  }

  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const shortId = event.event_id.split('-')[0];
  const filename = `${ts}-${event.source_product}-${slugify(
    event.event_type,
  )}-${shortId}.md`;
  const path = join(targetDir, filename);

  await atomicWrite(path, formatMarkdown(event));
  return path;
}
