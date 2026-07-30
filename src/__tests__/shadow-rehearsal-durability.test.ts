import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ledgerEventSchema, type LedgerEvent } from '../exec-graph/contracts.js';
import { foldEvents } from '../exec-graph/ledger.js';

const observedWrites = vi.hoisted(
  () => [] as Array<{ readonly path: string; readonly options: unknown }>,
);
const receiptRenameFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      const path = args[0];
      if (
        typeof path === 'string' &&
        (/[\\/]\.staging-/.test(path) || /[\\/]\.shadow-rehearsal-receipt-/.test(path))
      ) {
        observedWrites.push({ path, options: args[2] });
      }
      return Reflect.apply(actual.writeFileSync, actual, args);
    },
    renameSync: (...args: unknown[]) => {
      const source = args[0];
      if (
        receiptRenameFailure.enabled &&
        typeof source === 'string' &&
        /[\\/]\.shadow-rehearsal-receipt-/.test(source)
      ) {
        throw new Error('synthetic receipt rename failure');
      }
      return Reflect.apply(actual.renameSync, actual, args);
    },
  };
});

import {
  copyExecGraphDirectoryAtomic,
  runShadowRehearsal,
} from '../atlas/shadow-rehearsal.js';

const NOW = '2026-07-30T00:00:00.000Z';

describe('atlas/shadow-rehearsal durable copy', () => {
  let sandboxDir: string;

  beforeEach(() => {
    observedWrites.length = 0;
    receiptRenameFailure.enabled = false;
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-durability-'));
  });

  function fixtureEvents(): LedgerEvent[] {
    return [
      ledgerEventSchema.parse({
        eventId: 'evt-durable-goal',
        kind: 'goal-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          goal: {
            id: 'gol_durable',
            title: 'durable goal',
            source: { kind: 'exec-graph', ref: 'durable-goal' },
            status: 'open',
            createdAt: NOW,
          },
        },
      }),
      ledgerEventSchema.parse({
        eventId: 'evt-durable-task',
        kind: 'task-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          task: {
            id: 'tsk_durable',
            goalId: 'gol_durable',
            title: 'durable task',
            source: { kind: 'exec-graph', ref: 'durable-task' },
            owner: 'atlas',
            status: 'proposed',
            riskClass: 'low',
            idempotencyKey: 'exec-graph:durable-task',
            evidence: [],
            createdAt: NOW,
            transitions: [{ from: null, to: 'proposed', ts: NOW, actor: 'atlas' }],
          },
        },
      }),
    ];
  }

  function writeValidGraphFixture(name: string): string {
    const directory = join(sandboxDir, name);
    const events = fixtureEvents();
    const snapshot = foldEvents(events);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'ledger.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    writeFileSync(
      join(directory, 'graph.json'),
      `${JSON.stringify({
        goals: Object.values(snapshot.goals),
        tasks: Object.values(snapshot.tasks),
      })}\n`,
      'utf8',
    );
    return directory;
  }

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

    const stagingWrites = observedWrites.filter((write) => /[\\/]\.staging-/.test(write.path));
    expect(stagingWrites).toHaveLength(2);
    expect(stagingWrites.map((write) => write.options)).toEqual([
      { flush: true },
      { flush: true },
    ]);
  });

  it('flushes the derived receipt before atomically renaming it', () => {
    const source = writeValidGraphFixture('receipt-source');
    const workDirectory = join(sandboxDir, 'receipt-work');
    mkdirSync(workDirectory);

    const receipt = runShadowRehearsal(source, { workDirectory });
    const receiptWrites = observedWrites.filter((write) =>
      /[\\/]\.shadow-rehearsal-receipt-/.test(write.path),
    );

    expect(receiptWrites).toHaveLength(1);
    expect(receiptWrites[0].options).toEqual({ encoding: 'utf8', flush: true });
    expect(receipt).toHaveProperty(
      'receiptPath',
      join(workDirectory, 'shadow-rehearsal-receipt.json'),
    );
  });

  it('removes only the receipt temporary file when its rename fails', () => {
    const source = writeValidGraphFixture('rename-failure-source');
    const workDirectory = join(sandboxDir, 'rename-failure-work');
    mkdirSync(workDirectory);
    receiptRenameFailure.enabled = true;

    expect(() => runShadowRehearsal(source, { workDirectory })).toThrow(
      expect.objectContaining({ code: 'receipt_write_failed' }),
    );
    expect(existsSync(join(workDirectory, 'shadow-rehearsal-receipt.json'))).toBe(false);
    expect(
      readdirSync(workDirectory).filter((entry) =>
        entry.startsWith('.shadow-rehearsal-receipt-'),
      ),
    ).toEqual([]);
  });
});
