import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendJournal } from '../atlas/memory-manager.js';

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'atlas-test-'));
  await mkdir(join(tmpRoot, 'memory', 'atlas'), { recursive: true });
  await writeFile(join(tmpRoot, 'memory', 'atlas', 'journal.md'), '', 'utf-8');
  process.env.MEMORY_ROOT = tmpRoot;
});

afterAll(async () => {
  delete process.env.MEMORY_ROOT;
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('appendJournal', () => {
  it('writes entry to journal.md on disk', async () => {
    await appendJournal('test entry');
    const content = await readFile(join(tmpRoot, 'memory', 'atlas', 'journal.md'), 'utf-8');
    expect(content).toContain('test entry');
  });
});
