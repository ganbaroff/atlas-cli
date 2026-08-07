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
  'src/atlas/emotional-safety.ts': [
    operational(['emotion-audit'], 'tone-safety audit trail'),
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
  'src/atlas/telegram-capability.ts': [
    surface(
      'ephemeral',
      'temporary',
      'local STT/OCR round-trip scratch files under os.tmpdir(), unlinked in a finally block immediately after each request',
    ),
  ],
  'src/atlas/voice-adapter-client.ts': [
    surface(
      'configuration-content',
      'caller-target',
      'voiceTts() writes synthesized audio bytes to the caller-supplied outPath argument',
    ),
  ],
  'src/atlas/executor/mission-record.ts': [
    operational(
      ['operator-state'],
      'durable mission continuity record: missionId, work-order hash, milestone, completed steps, lease owner, spend claim id and evidence path. Written atomically (temp + rename) so a killed process leaves either the old record or the new one. Executor session state is carried as an opaque reference and is never Atlas memory authority',
    ),
  ],
  'src/atlas/executor/tool-broker.ts': [
    surface(
      'configuration-content',
      'caller-target',
      'write_file/apply_patch mutate only files inside the mission worktree named by the signed Work Order; every write is scope-checked against allowedPaths/forbiddenPaths and refused before the side effect, and nothing lands under ATLAS_STATE_ROOT',
    ),
  ],
  'src/atlas/work-order/repo-writer-lock.ts': [
    authoritative(
      ['instance-lease'],
      'RepoWriterLease per-repository writer mutual-exclusion reuses the instance-lease state family (no new store); stale-lease takeover is never silent and always requires recorded evidence',
    ),
  ],
  'src/atlas/work-order/replay.ts': [
    authoritative(
      ['queue-auth'],
      'work-order nonce/workOrderId one-time-claim ledger reuses the queue-auth state family (no new store); durable replay protection must survive restart',
    ),
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
  'src/courier/courier-loop.ts': [
    surface(
      'operational',
      'explicit-proof-path',
      'courier receipts write only to caller-selected quarantine evidenceDir',
    ),
  ],
  'src/hands/chatgpt-browser-reviewer-adapter.ts': [
    surface(
      'operational',
      'explicit-proof-path',
      'ChatGPT reviewer screenshots/JSON under caller quarantine evidenceDir; profile is dedicated Atlas quarantine',
    ),
  ],
  'src/hands/cursor-headless-adapter.ts': [
    surface(
      'operational',
      'explicit-proof-path',
      'Cursor stream-json/meta under caller quarantine evidenceDir; may apply proposed writes only inside disposable workspace',
    ),
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
