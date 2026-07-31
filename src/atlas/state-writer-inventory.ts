/**
 * Reviewed inventory of production TypeScript files that invoke filesystem
 * mutators. The structural test discovers that file set independently, so a
 * new writer cannot appear without an explicit classification decision.
 *
 * `state-root` means the surface must be migrated under ATLAS_STATE_ROOT.
 * Other locations are explicit exclusions: proof artifacts, VOLAURA content,
 * caller-owned workspace output, or disposable temporary data.
 */

import type { StateStore } from './state-root.js';

export type StateWriterClassification =
  | 'authoritative'
  | 'operational'
  | 'ephemeral'
  | 'configuration-content';

export type StateWriterLocation =
  | 'state-root'
  | 'explicit-proof-path'
  | 'external-memory-domain'
  | 'temporary'
  | 'caller-target';

export interface StateWriterSurface {
  classification: StateWriterClassification;
  location: StateWriterLocation;
  stores?: readonly StateStore[];
  reason: string;
}

function surface(
  classification: StateWriterClassification,
  location: StateWriterLocation,
  reason: string,
  stores?: readonly StateStore[],
): StateWriterSurface {
  return { classification, location, reason, stores };
}

const authoritative = (stores: readonly StateStore[], reason: string): StateWriterSurface =>
  surface('authoritative', 'state-root', reason, stores);

const operational = (stores: readonly StateStore[], reason: string): StateWriterSurface =>
  surface('operational', 'state-root', reason, stores);

export const STATE_WRITER_INVENTORY: Readonly<
  Record<string, readonly StateWriterSurface[]>
> = {
  'src/telegram.ts': [
    surface('ephemeral', 'temporary', 'downloaded voice input is deleted after processing'),
    surface(
      'configuration-content',
      'external-memory-domain',
      'conversation deletion targets canonical VOLAURA memory',
    ),
  ],
  'src/atlas/autonomy-loop.ts': [
    operational(['alert-state'], 'deduplicates persisted autonomy alerts'),
    surface('ephemeral', 'temporary', 'controlled-live-test notification marker'),
  ],
  'src/atlas/control-plane.ts': [
    authoritative(['operator-state'], 'pause/control decisions change model and task authority'),
  ],
  'src/atlas/conversation-store.ts': [
    surface(
      'configuration-content',
      'external-memory-domain',
      'Telegram conversation history belongs to canonical VOLAURA memory',
    ),
  ],
  'src/atlas/cost-router-state.ts': [
    authoritative(['cost-router'], 'provider ownership, budgets, retries, and async handles'),
  ],
  'src/atlas/cron.ts': [
    surface('configuration-content', 'external-memory-domain', 'health reports are VOLAURA memory'),
  ],
  'src/atlas/effect-journal.ts': [
    authoritative(
      ['effect-journal'],
      'durable effect intent/start/receipt ledger for no-automatic-duplicate execution',
    ),
  ],
  'src/atlas/emotional-safety.ts': [
    operational(['emotion-audit'], 'tone-safety audit trail'),
  ],
  'src/atlas/full-root-rehearsal.ts': [
    surface(
      'operational',
      'explicit-proof-path',
      'caller-selected full-root fixture rehearsal artifact and rollback cleanup',
    ),
  ],
  'src/atlas/instance-lease.ts': [
    authoritative(['instance-lease'], 'machine writer ownership and runner liveness'),
  ],
  'src/atlas/mastra-agent.ts': [
    surface('configuration-content', 'external-memory-domain', 'raw/concept notes are memory content'),
  ],
  'src/atlas/memory-manager.ts': [
    surface('configuration-content', 'external-memory-domain', 'journal and heartbeat are VOLAURA memory'),
  ],
  'src/atlas/memory.ts': [
    surface('configuration-content', 'external-memory-domain', 'ecosystem inbox is VOLAURA memory'),
  ],
  'src/atlas/notify-queue.ts': [
    authoritative(['notify-queue'], 'pending notification delivery and retry state'),
  ],
  'src/atlas/preserved-state-rehearsal.ts': [
    surface('operational', 'explicit-proof-path', 'caller-selected retained rehearsal artifact'),
  ],
  'src/atlas/provider-health.ts': [
    operational(['provider-health'], 'routing cooldown and provider health observations'),
  ],
  'src/atlas/pulse.ts': [
    surface('configuration-content', 'external-memory-domain', 'MOOD.md is canonical VOLAURA memory'),
  ],
  'src/atlas/python-bridge.ts': [
    surface('configuration-content', 'external-memory-domain', 'shared-bus request is VOLAURA content'),
  ],
  'src/atlas/queue-auth.ts': [
    authoritative(['queue-auth'], 'nonce replay protection must survive restart'),
  ],
  'src/atlas/repo-watch.ts': [
    operational(['repo-watch'], 'last observed repository heads suppress duplicate notices'),
  ],
  'src/atlas/screen-capture.ts': [
    surface('ephemeral', 'temporary', 'screen images and throttle state are disposable captures'),
  ],
  'src/atlas/shadow-rehearsal.ts': [
    surface('operational', 'explicit-proof-path', 'synthetic proof directory is caller-isolated'),
  ],
  'src/atlas/spend-tracker.ts': [
    authoritative(['spend-receipts'], 'daily cap rehydrates from durable spend receipts'),
  ],
  'src/atlas/swarm-logger.ts': [
    surface('configuration-content', 'external-memory-domain', 'swarm history is VOLAURA memory'),
  ],
  'src/atlas/task-spawner.ts': [
    authoritative(['task-results'], 'local executor result records'),
  ],
  'src/atlas/write-back-hook.ts': [
    operational(['breadcrumbs'], 'session-exit audit breadcrumbs'),
  ],
  'src/evidence/auditor.ts': [
    operational(['evidence'], 'audit results are children of the selected evidence ledger root'),
  ],
  'src/evidence/ledger.ts': [
    authoritative(['evidence'], 'hash-chained claims and derived snapshot'),
  ],
  'src/exec-graph/ledger.ts': [
    authoritative(['exec-graph'], 'task/goal event authority and derived snapshot'),
  ],
  'src/goal-runner/budgets.ts': [
    authoritative(['goal-budgets'], 'goal ceilings, attempts, fingerprints, and goal lease'),
  ],
  'src/learning/claim-file-lock.ts': [
    authoritative(['learning'], 'claim mutation exclusion'),
  ],
  'src/learning/claim-store.ts': [
    authoritative(['learning'], 'learning claims and receipts'),
  ],
  'src/learning/projections.ts': [
    authoritative(['learning'], 'projection idempotency locks'),
  ],
  'src/learning/request-port.ts': [
    authoritative(['learning'], 'learning request/receipt exchange'),
  ],
  'src/learning/state-dir.ts': [
    authoritative(['learning'], 'learning state directory bootstrap'),
  ],
  'src/learning/test-isolation.ts': [
    surface('ephemeral', 'temporary', 'test-only state isolation roots'),
  ],
  'src/operator/dispatcher.ts': [
    authoritative(['operator-state', 'operator-runs'], 'operator control snapshot and run traces'),
  ],
  'src/operator/run-ledger.ts': [
    authoritative(['operator-runs'], 'append-only operator run ledger'),
  ],
  'src/opsboard/goal-request-port.ts': [
    authoritative(['opsboard-exchange'], 'goal requests, receipts, and processed markers'),
  ],
  'src/research-swarm/artifact.ts': [
    surface('configuration-content', 'external-memory-domain', 'research artifacts are VOLAURA memory'),
  ],
  'src/swarm-exec/intake.ts': [
    authoritative(['intake-drafts'], 'compiled swarm intake drafts'),
  ],
  'src/swarm-exec/run-bundle.ts': [
    authoritative(['swarm-runs'], 'swarm run evidence bundles and terminal proof token'),
  ],
  'src/tools/compile-wiki.ts': [
    surface('configuration-content', 'caller-target', 'tool mutates caller-selected wiki content'),
  ],
  'src/tools/fs-guard.ts': [
    operational(['shell-audit'], 'filesystem refusal audit'),
  ],
  'src/tools/shell.ts': [
    operational(['shell-audit'], 'shell refusal/execution audit'),
  ],
  'src/tools/write-file.ts': [
    surface('configuration-content', 'caller-target', 'tool writes caller-selected workspace content'),
  ],
};

/** Root-managed stores written outside production TypeScript. */
export const EXTERNAL_STATE_WRITERS: Readonly<
  Partial<Record<StateStore, { classification: 'authoritative' | 'operational'; reason: string }>>
> = {
  'pause-control': {
    classification: 'authoritative',
    reason: 'desktop panic control writes the PAUSE marker',
  },
  'runner-log': {
    classification: 'operational',
    reason: 'scripts/start-runner.cmd appends the autostart log',
  },
};
