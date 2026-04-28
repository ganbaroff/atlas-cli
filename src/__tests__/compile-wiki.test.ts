import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { compileWikiTool } from '../tools/compile-wiki.js';

const ROOT = process.cwd();
const RAW_DIR = join(ROOT, 'memory', 'raw');
const CONCEPTS_DIR = join(ROOT, 'memory', 'concepts');
const TEST_FILE = join(RAW_DIR, '_test-concept.md');
const CTX = {} as never;

beforeAll(async () => {
  await mkdir(RAW_DIR, { recursive: true });
  await writeFile(TEST_FILE, '# Test Concept\n\nSome raw note content.\n', 'utf-8');
});

afterAll(async () => {
  await rm(TEST_FILE, { force: true });
  await rm(join(CONCEPTS_DIR, 'test-concept.md'), { force: true });
});

describe('compile-wiki tool', () => {
  it('creates concepts dir and writes frontmatter file', async () => {
    const result = await compileWikiTool.execute!({}, CTX);
    expect(result.new).toBeGreaterThanOrEqual(1);
    expect(existsSync(CONCEPTS_DIR)).toBe(true);
    const files = await readdir(CONCEPTS_DIR);
    expect(files).toContain('test-concept.md');
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(CONCEPTS_DIR, 'test-concept.md'), 'utf-8');
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/title: Test Concept/);
  });
});
