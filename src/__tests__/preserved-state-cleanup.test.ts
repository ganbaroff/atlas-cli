import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  failWorkRemoval: false,
  escapeWorkRealpath: false,
  workDirectory: '',
  workRemovalCalls: 0,
  m3cReceiptWrites: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mockedRealpathSync = ((...args: unknown[]) =>
    Reflect.apply(actual.realpathSync, actual, args)) as typeof actual.realpathSync;
  mockedRealpathSync.native = ((...args: unknown[]) => {
    const path = args[0];
    if (
      faults.escapeWorkRealpath &&
      typeof path === 'string' &&
      path === faults.workDirectory
    ) {
      return join(dirname(dirname(path)), 'outside-realpath', basename(path));
    }
    return Reflect.apply(actual.realpathSync.native, actual.realpathSync, args);
  }) as typeof actual.realpathSync.native;

  return {
    ...actual,
    realpathSync: mockedRealpathSync,
    mkdirSync: (...args: unknown[]) => {
      const result = Reflect.apply(actual.mkdirSync, actual, args);
      const path = args[0];
      if (typeof path === 'string' && basename(path).startsWith('.m3c-work-')) {
        faults.workDirectory = path;
      }
      return result;
    },
    rmSync: (...args: unknown[]) => {
      const path = args[0];
      const options = args[1];
      if (
        typeof path === 'string' &&
        basename(path).startsWith('.m3c-work-') &&
        typeof options === 'object' &&
        options !== null &&
        'recursive' in options &&
        options.recursive === true
      ) {
        faults.workRemovalCalls += 1;
        if (faults.failWorkRemoval) return;
      }
      return Reflect.apply(actual.rmSync, actual, args);
    },
    writeFileSync: (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string' && basename(path).startsWith('.m3c-receipt-')) {
        faults.m3cReceiptWrites += 1;
      }
      return Reflect.apply(actual.writeFileSync, actual, args);
    },
  };
});

import {
  preserveExecGraphSnapshot,
  rehearsePreservedExecGraph,
} from '../atlas/preserved-state-rehearsal.js';
import { writeExecGraphFixture } from './fixtures/exec-graph-shadow-fixture.js';

const ARTIFACT_NAME = 'atlas-exec-graph-m3c-20260730T182000Z-abcd1234';
const CHILD_TEST_TIMEOUT = 20_000;

describe('atlas/preserved-state safe cleanup', () => {
  let sandboxDirectory: string;
  let artifactDirectory: string;

  beforeEach(() => {
    faults.failWorkRemoval = false;
    faults.escapeWorkRealpath = false;
    faults.workDirectory = '';
    faults.workRemovalCalls = 0;
    faults.m3cReceiptWrites = 0;
    sandboxDirectory = mkdtempSync(join(tmpdir(), 'atlas-preserved-cleanup-'));
    const sourceDirectory = writeExecGraphFixture(sandboxDirectory, 'source');
    const preservationParentDirectory = join(sandboxDirectory, 'preservation');
    mkdirSync(preservationParentDirectory);
    artifactDirectory = join(preservationParentDirectory, ARTIFACT_NAME);
    preserveExecGraphSnapshot({
      sourceDirectory,
      preservationParentDirectory,
      artifactName: ARTIFACT_NAME,
    });
  });

  afterEach(() => {
    faults.failWorkRemoval = false;
    faults.escapeWorkRealpath = false;
    rmSync(sandboxDirectory, { recursive: true, force: true });
  });

  it(
    'cleanup failure supersedes success and never invokes M3C receipt writing',
    () => {
      faults.failWorkRemoval = true;

      expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
        expect.objectContaining({ code: 'cleanup_failed' }),
      );
      expect(faults.workRemovalCalls).toBe(1);
      expect(faults.m3cReceiptWrites).toBe(0);
      expect(existsSync(join(artifactDirectory, 'rehearsal-receipt.json'))).toBe(false);
      expect(existsSync(faults.workDirectory)).toBe(true);
    },
    CHILD_TEST_TIMEOUT,
  );

  it(
    'realpath escape fails cleanup before recursive removal or receipt writing',
    () => {
      faults.escapeWorkRealpath = true;

      expect(() => rehearsePreservedExecGraph({ artifactDirectory })).toThrow(
        expect.objectContaining({ code: 'cleanup_unsafe' }),
      );
      expect(faults.workRemovalCalls).toBe(0);
      expect(faults.m3cReceiptWrites).toBe(0);
      expect(existsSync(join(artifactDirectory, 'rehearsal-receipt.json'))).toBe(false);
      expect(existsSync(faults.workDirectory)).toBe(true);
    },
    CHILD_TEST_TIMEOUT,
  );
});
