import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ledgerEventSchema, type LedgerEvent } from '../../exec-graph/contracts.js';
import { foldEvents } from '../../exec-graph/ledger.js';

const NOW = '2026-07-30T00:00:00.000Z';

function fixtureEvents(title: string): LedgerEvent[] {
  return [
    ledgerEventSchema.parse({
      eventId: 'evt-preserved-goal',
      kind: 'goal-created',
      ts: NOW,
      actor: 'atlas',
      payload: {
        goal: {
          id: 'gol_preserved_state',
          title: 'preserved goal',
          source: { kind: 'exec-graph', ref: 'preserved-goal' },
          status: 'open',
          createdAt: NOW,
        },
      },
    }),
    ledgerEventSchema.parse({
      eventId: 'evt-preserved-task',
      kind: 'task-created',
      ts: NOW,
      actor: 'atlas',
      payload: {
        task: {
          id: 'tsk_preserved_state',
          goalId: 'gol_preserved_state',
          title,
          source: { kind: 'exec-graph', ref: 'preserved-task' },
          owner: 'atlas',
          status: 'proposed',
          riskClass: 'low',
          idempotencyKey: 'exec-graph:preserved-task',
          evidence: [],
          createdAt: NOW,
          transitions: [{ from: null, to: 'proposed', ts: NOW, actor: 'atlas' }],
        },
      },
    }),
  ];
}

export function writeExecGraphFixture(
  parent: string,
  name: string,
  title = 'preserved task',
): string {
  const directory = join(parent, name);
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
    `${JSON.stringify({
      goals: Object.values(snapshot.goals),
      tasks: Object.values(snapshot.tasks),
    })}\n`,
    'utf8',
  );
  return directory;
}
