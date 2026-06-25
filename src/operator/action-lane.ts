import { basename, resolve } from 'node:path';
import {
  parseOperatorTask,
  type OperatorResult,
  type OperatorRunLedgerEntry,
  type OperatorTask,
} from './contracts.js';
import { runOperatorLifecycle } from './lifecycle.js';
import { appendRunLedgerEntryForResult } from './run-ledger.js';

type ActionSource = 'cli' | 'telegram';
type RunLifecycleFn = (task: OperatorTask) => OperatorResult;
type AppendLedgerFn = (task: OperatorTask, result: OperatorResult) => OperatorRunLedgerEntry;

export interface OperatorActionLaneOptions {
  source?: ActionSource;
  now?: () => string;
  openManusCwd?: string;
  runLifecycle?: RunLifecycleFn;
  appendLedger?: AppendLedgerFn;
}

export interface OperatorActionLaneResult {
  handled: boolean;
  reply: string;
  task?: OperatorTask;
  result?: OperatorResult;
  ledgerEntry?: OperatorRunLedgerEntry;
  error?: string;
}

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'target';
}

function compactTimestamp(isoTimestamp: string): string {
  return isoTimestamp
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 19);
}

function trimTaskId(value: string): string {
  if (value.length <= 80) return value;
  return value.slice(0, 80).replace(/[-_.]+$/g, '');
}

type CompiledIntent =
  | { kind: 'web'; route: 'openmanus' | 'local'; url: string; expectedText: string }
  | { kind: 'file'; filePath: string; expectedText: string };

function stripOuterQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function parseFileSmokeIntent(text: string): { filePath: string; expectedText: string } | null {
  const match = text.trim().match(/^\/(?:operator|hands|atlas)\s+file-smoke\s+([\s\S]+)$/i);
  if (!match) return null;

  const rest = match[1]?.trim() ?? '';
  if (!rest) return null;

  const quoted = rest.match(/^["']([^"']+)["'](?:\s+([\s\S]+))?$/);
  if (quoted) {
    return {
      filePath: quoted[1],
      expectedText: stripOuterQuotes(quoted[2] ?? ''),
    };
  }

  const [filePath = '', ...expectedParts] = rest.split(/\s+/);
  return {
    filePath,
    expectedText: stripOuterQuotes(expectedParts.join(' ')),
  };
}

function parseSmokeIntent(text: string): CompiledIntent | null {
  const fileSmoke = parseFileSmokeIntent(text);
  if (fileSmoke) {
    return { kind: 'file', ...fileSmoke };
  }

  const match = text.trim().match(/^\/(?:operator|hands|atlas)\s+smoke\s+(https?:\/\/\S+)(?:\s+([\s\S]+))?$/i);
  const localMatch = text.trim().match(/^\/(?:operator|hands|atlas)\s+local-smoke\s+(https?:\/\/\S+)(?:\s+([\s\S]+))?$/i);
  const selected = match ?? localMatch;
  if (!selected) return null;

  const url = selected[1];
  const expectedText = stripOuterQuotes(selected[2] ?? '');

  return { kind: 'web', route: localMatch ? 'local' : 'openmanus', url, expectedText };
}

export function compileOperatorActionTask(
  text: string,
  options: OperatorActionLaneOptions = {},
): OperatorTask | null {
  const smoke = parseSmokeIntent(text);
  if (!smoke) return null;

  const createdAt = options.now?.() ?? new Date().toISOString();
  if (smoke.kind === 'file') {
    const cwd = process.cwd();
    const fileLabel = safeSlug(basename(smoke.filePath) || 'file');
    const taskId = trimTaskId(`${options.source ?? 'telegram'}-file-smoke-${fileLabel}-${compactTimestamp(createdAt)}`);

    return parseOperatorTask({
      id: taskId,
      title: `File smoke ${fileLabel}`,
      created_at: createdAt,
      route: 'local',
      mode: 'read_only',
      cwd,
      allowed_paths: [cwd],
      objective: `Verify local file ${smoke.filePath} through read-only file smoke with durable evidence.`,
      inputs: {
        runtime_mode: 'file_smoke',
        file_path: smoke.filePath,
        expected_text: smoke.expectedText,
        source: options.source ?? 'telegram',
      },
      expected_evidence: ['file_exists', 'file_read', 'log_trace'],
      safety: {
        sandbox_required: false,
        network_allowed: false,
        write_allowed: false,
      },
    });
  }

  const openManusCwd = resolve(options.openManusCwd ?? process.env.ATLAS_OPENMANUS_CWD ?? 'C:/Projects/OpenManus');
  const hostname = safeSlug(new URL(smoke.url).hostname);
  const routeLabel = smoke.route === 'openmanus' ? 'openmanus' : 'local';
  const taskId = trimTaskId(`${options.source ?? 'telegram'}-${routeLabel}-smoke-${hostname}-${compactTimestamp(createdAt)}`);
  const cwd = smoke.route === 'openmanus' ? openManusCwd : process.cwd();

  return parseOperatorTask({
    id: taskId,
    title: `${smoke.route === 'openmanus' ? 'OpenManus' : 'Local'} smoke ${hostname}`,
    created_at: createdAt,
    route: smoke.route,
    mode: 'read_only',
    cwd,
    allowed_paths: [cwd],
    objective: smoke.route === 'openmanus'
      ? `Verify ${smoke.url} through OpenManus hands with durable evidence.`
      : `Verify ${smoke.url} through local read-only HTTP smoke with durable evidence.`,
    inputs: {
      runtime_mode: smoke.route === 'local' ? 'http_smoke' : undefined,
      smoke_url: smoke.url,
      expected_text: smoke.expectedText,
      timeout_ms: smoke.route === 'openmanus' ? 180000 : 30000,
      source: options.source ?? 'telegram',
    },
    expected_evidence: ['command_exit', 'browser_observation', 'browser_session_trace', 'log_trace'],
    safety: {
      sandbox_required: smoke.route === 'openmanus',
      network_allowed: true,
      write_allowed: false,
    },
  });
}

function formatActionReply(
  task: OperatorTask,
  result: OperatorResult,
  ledgerEntry: OperatorRunLedgerEntry,
): string {
  const proofCount = ledgerEntry.proof_tokens.length;
  const reason = result.errors[0] ?? result.summary;
  const statusLine = ledgerEntry.verdict === 'passed'
    ? 'Action lane passed.'
    : `Action lane blocked: ${reason}`;

  return [
    statusLine,
    `task_id: ${task.id}`,
    `run_id: ${ledgerEntry.run_id}`,
    `status/verdict: ${ledgerEntry.status}/${ledgerEntry.verdict}`,
    `proof_tokens: ${proofCount}`,
    `result: ${ledgerEntry.result_path}`,
  ].join('\n');
}

export function runOperatorActionLane(
  text: string,
  options: OperatorActionLaneOptions = {},
): OperatorActionLaneResult {
  const task = compileOperatorActionTask(text, options);
  if (!task) {
    return {
      handled: false,
      reply: '',
    };
  }

  try {
    const runLifecycle = options.runLifecycle ?? runOperatorLifecycle;
    const appendLedger = options.appendLedger ?? appendRunLedgerEntryForResult;
    const result = runLifecycle(task);
    const ledgerEntry = appendLedger(task, result);

    return {
      handled: true,
      reply: formatActionReply(task, result, ledgerEntry),
      task,
      result,
      ledgerEntry,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      handled: true,
      reply: `Action lane failed before ledger write: ${message}`,
      task,
      error: message,
    };
  }
}
