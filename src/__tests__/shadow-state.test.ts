import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ledgerEventSchema, type LedgerEvent } from '../exec-graph/contracts.js';
import { foldEvents } from '../exec-graph/ledger.js';
import {
  compareExecGraphDirectories,
  inspectExecGraphDirectory,
} from '../atlas/shadow-state.js';

const NOW = '2026-07-30T00:00:00.000Z';

describe('atlas/shadow-state', () => {
  let sandboxDir: string;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), 'atlas-shadow-state-'));
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  function fixtureEvents(title = 'shadow task'): LedgerEvent[] {
    return [
      ledgerEventSchema.parse({
        eventId: 'evt-shadow-goal',
        kind: 'goal-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          goal: {
            id: 'gol_shadow_state',
            title: 'shadow goal',
            source: { kind: 'exec-graph', ref: 'shadow-goal' },
            status: 'open',
            createdAt: NOW,
          },
        },
      }),
      ledgerEventSchema.parse({
        eventId: 'evt-shadow-task',
        kind: 'task-created',
        ts: NOW,
        actor: 'atlas',
        payload: {
          task: {
            id: 'tsk_shadow_state',
            goalId: 'gol_shadow_state',
            title,
            source: { kind: 'exec-graph', ref: 'shadow-task' },
            owner: 'atlas',
            status: 'proposed',
            riskClass: 'low',
            idempotencyKey: 'exec-graph:shadow-task',
            evidence: [],
            createdAt: NOW,
            transitions: [
              {
                from: null,
                to: 'proposed',
                ts: NOW,
                actor: 'atlas',
              },
            ],
          },
        },
      }),
    ];
  }

  function writeValidGraphFixture(name: string, title = 'shadow task'): string {
    const directory = join(sandboxDir, name);
    const events = fixtureEvents(title);
    const snapshot = foldEvents(events);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'ledger.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    writeFileSync(
      join(directory, 'graph.json'),
      `${JSON.stringify(
        {
          goals: Object.values(snapshot.goals),
          tasks: Object.values(snapshot.tasks),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return directory;
  }

  it('strictly inspects a valid explicit exec-graph directory', () => {
    const directory = writeValidGraphFixture('source');
    const result = inspectExecGraphDirectory(directory);

    expect(result.directory).toBe(resolve(directory));
    expect(result.eventCount).toBe(2);
    expect(result.goalCount).toBe(1);
    expect(result.taskCount).toBe(1);
    expect(result.ledgerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.semanticSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects one malformed ledger line instead of skipping it', () => {
    const directory = writeValidGraphFixture('bad-ledger');
    appendFileSync(join(directory, 'ledger.jsonl'), '{not-json}\n', 'utf8');

    expect(() => inspectExecGraphDirectory(directory)).toThrow(
      expect.objectContaining({ code: 'ledger_invalid' }),
    );
  });

  it('rejects an empty ledger even when the snapshot is also empty', () => {
    const directory = join(sandboxDir, 'empty-state');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'ledger.jsonl'), '', 'utf8');
    writeFileSync(join(directory, 'graph.json'), '{"goals":[],"tasks":[]}\n', 'utf8');

    expect(() => inspectExecGraphDirectory(directory)).toThrow(
      expect.objectContaining({ code: 'ledger_empty' }),
    );
  });

  it('rejects a valid snapshot that diverges from its ledger fold', () => {
    const directory = writeValidGraphFixture('diverged');
    writeFileSync(join(directory, 'graph.json'), '{"goals":[],"tasks":[]}\n', 'utf8');

    expect(() => inspectExecGraphDirectory(directory)).toThrow(
      expect.objectContaining({ code: 'snapshot_diverged' }),
    );
  });

  it('rejects a duplicate ledger event id even when the fold result is unchanged', () => {
    const directory = writeValidGraphFixture('duplicate-event');
    const firstLine = readFileSync(join(directory, 'ledger.jsonl'), 'utf8').split(/\r?\n/)[0];
    appendFileSync(join(directory, 'ledger.jsonl'), `${firstLine}\n`, 'utf8');

    expect(() => inspectExecGraphDirectory(directory)).toThrow(
      expect.objectContaining({ code: 'ledger_invalid' }),
    );
  });

  it('rejects an orphan event instead of accepting the fold that skipped it', () => {
    const directory = writeValidGraphFixture('orphan-event');
    const orphan = ledgerEventSchema.parse({
      eventId: 'evt-shadow-orphan',
      kind: 'transition',
      ts: NOW,
      actor: 'atlas',
      payload: {
        taskId: 'tsk_shadow_missing',
        transition: {
          from: 'proposed',
          to: 'accepted',
          ts: NOW,
          actor: 'atlas',
        },
      },
    });
    appendFileSync(join(directory, 'ledger.jsonl'), `${JSON.stringify(orphan)}\n`, 'utf8');

    expect(() => inspectExecGraphDirectory(directory)).toThrow(
      expect.objectContaining({ code: 'ledger_invalid' }),
    );
  });

  it('rejects duplicate snapshot ids instead of collapsing extra rows', () => {
    const directory = writeValidGraphFixture('duplicate-snapshot');
    const snapshot = JSON.parse(readFileSync(join(directory, 'graph.json'), 'utf8')) as {
      goals: unknown[];
      tasks: unknown[];
    };
    snapshot.goals.push(snapshot.goals[0]);
    writeFileSync(join(directory, 'graph.json'), JSON.stringify(snapshot), 'utf8');

    expect(() => inspectExecGraphDirectory(directory)).toThrow(
      expect.objectContaining({ code: 'snapshot_invalid' }),
    );
  });

  it('accepts byte-identical ledger and semantically identical state', () => {
    const source = writeValidGraphFixture('source');
    const candidate = writeValidGraphFixture('candidate');

    expect(compareExecGraphDirectories(source, candidate)).toMatchObject({
      ledgerBytesEqual: true,
      snapshotBytesEqual: true,
      semanticStateEqual: true,
      countsEqual: true,
      accepted: true,
      blocker: 'not-applicable',
      liveResolverChanged: false,
    });
  });

  it('accepts harmless snapshot formatting differences when ledger bytes and semantics match', () => {
    const source = writeValidGraphFixture('source');
    const candidate = writeValidGraphFixture('candidate');
    const events = fixtureEvents();
    const snapshot = foldEvents(events);
    writeFileSync(
      join(candidate, 'graph.json'),
      JSON.stringify({
        goals: Object.values(snapshot.goals),
        tasks: Object.values(snapshot.tasks),
      }),
      'utf8',
    );

    expect(compareExecGraphDirectories(source, candidate)).toMatchObject({
      ledgerBytesEqual: true,
      snapshotBytesEqual: false,
      semanticStateEqual: true,
      countsEqual: true,
      accepted: true,
      blocker: 'not-applicable',
    });
  });

  it('refuses a candidate whose valid ledger represents different state', () => {
    const source = writeValidGraphFixture('source');
    const candidate = writeValidGraphFixture('candidate', 'different shadow task');

    expect(compareExecGraphDirectories(source, candidate)).toMatchObject({
      accepted: false,
      ledgerBytesEqual: false,
      semanticStateEqual: false,
      countsEqual: true,
      liveResolverChanged: false,
    });
  });
});
