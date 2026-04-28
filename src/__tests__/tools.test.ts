import { describe, it, expect, afterAll } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { shellTool, globTool, grepTool, writeFileTool } from '../tools/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TMP = join(ROOT, 'src', '__tests__', 'tmp-write-test.txt');
const CTX = {} as never;

afterAll(async () => {
  await rm(TMP, { force: true });
});

describe('shell tool', () => {
  it('executes echo and returns stdout', async () => {
    const result = await shellTool.execute!({ command: 'echo hello' }, CTX);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });
});

describe('glob tool', () => {
  it('finds .ts files in src/', async () => {
    const result = await globTool.execute!({ pattern: '**/*.ts', cwd: join(ROOT, 'src') }, CTX);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.some((f: string) => f.endsWith('.ts'))).toBe(true);
  });
});

describe('grep tool', () => {
  it('finds "Atlas" in identity.test.ts', async () => {
    const target = join(ROOT, 'src', '__tests__', 'identity.test.ts');
    const result = await grepTool.execute!({ pattern: 'Atlas', paths: [target] }, CTX);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].text).toMatch(/Atlas/i);
  });
});

describe('write-file tool', () => {
  it('writes file and content is readable', async () => {
    const result = await writeFileTool.execute!({ path: TMP, content: 'hello atlas' }, CTX);
    expect(result.written).toBe(true);
    const content = await readFile(TMP, 'utf-8');
    expect(content).toBe('hello atlas');
  });
});
