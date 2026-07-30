import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stagingWrites = vi.hoisted(
  () => [] as Array<{ readonly path: string; readonly options: unknown }>,
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string' && /[\\/]\.staging-/.test(path)) {
        stagingWrites.push({ path, options: args[2] });
      }
      return Reflect.apply(actual.writeFileSync, actual, args);
    },
  };
});

import { copyExecGraphDirectoryAtomic } from '../atlas/shadow-rehearsal.js';

describe('atlas/shadow-rehearsal durable copy', () => {
  let sandboxDir: string;

  beforeEach(() => {
    stagingWrites.length = 0;
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-durability-'));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('flushes both staged files before atomically renaming the directory', () => {
    const source = join(sandboxDir, 'source');
    const destinationParent = join(sandboxDir, 'destination');
    mkdirSync(source, { recursive: true });
    mkdirSync(destinationParent, { recursive: true });
    writeFileSync(join(source, 'ledger.jsonl'), '{"eventId":"fixture"}\n', 'utf8');
    writeFileSync(join(source, 'graph.json'), '{"goals":[],"tasks":[]}\n', 'utf8');

    copyExecGraphDirectoryAtomic(source, destinationParent, 'shadow');

    expect(stagingWrites).toHaveLength(2);
    expect(stagingWrites.map((write) => write.options)).toEqual([
      { flush: true },
      { flush: true },
    ]);
  });
});
