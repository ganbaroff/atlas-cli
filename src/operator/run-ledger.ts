import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { constrainMigratingStatePath } from '../atlas/state-root.js';
import {
  parseOperatorRunLedgerEntry,
  selectCanonicalRunLedgerEntry,
  type OperatorResult,
  type OperatorRunLedgerEntry,
  type OperatorTask,
  validateResultEvidence,
} from './contracts.js';
import { operatorRunsDir } from './dispatcher.js';

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}

function stampForRunId(isoTimestamp: string): string {
  return isoTimestamp
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24);
}

function proofTokensFromResult(result: OperatorResult): string[] {
  return unique([
    ...result.evidence.map((item) => item.proof_token ?? item.id),
    ...(result.lifecycle?.proof_tokens ?? []),
    ...(result.promotion?.proof_tokens ?? []),
  ]);
}

function resultPath(result: OperatorResult): string {
  return constrainMigratingStatePath(
    'operator-runs',
    result.trace_path ?? resolve(operatorRunsDir(), `${result.task_id}.result.json`),
  );
}

function expectedEvidenceMet(task: OperatorTask, result: OperatorResult): boolean {
  if (result.status !== 'success') return false;

  if (result.lifecycle) {
    return result.lifecycle.source_task_id === task.id
      && result.lifecycle.final_status === 'success'
      && result.promotion?.promoted === true
      && result.promotion.final_verdict !== 'blocked';
  }

  return validateResultEvidence(task, result).passed;
}

export function operatorRunLedgerPath(): string {
  return resolve(operatorRunsDir(), 'run-ledger.jsonl');
}

export function readRunLedgerEntries(ledgerPath = operatorRunLedgerPath()): OperatorRunLedgerEntry[] {
  const resolvedLedgerPath = constrainMigratingStatePath('operator-runs', ledgerPath);
  if (!existsSync(resolvedLedgerPath)) return [];

  return readFileSync(resolvedLedgerPath, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseOperatorRunLedgerEntry(JSON.parse(line)));
}

export function buildRunId(
  taskId: string,
  completedAt: string,
  entries: OperatorRunLedgerEntry[] = [],
): string {
  const prefix = `${taskId}.${stampForRunId(completedAt)}`;
  const lastSequence = entries
    .filter((entry) => entry.run_id.startsWith(`${prefix}.`))
    .map((entry) => Number.parseInt(entry.run_id.slice(prefix.length + 1), 10))
    .filter(Number.isFinite)
    .reduce((max, value) => Math.max(max, value), 0);

  return `${prefix}.${String(lastSequence + 1).padStart(6, '0')}`;
}

export function buildRunLedgerEntry(
  task: OperatorTask,
  result: OperatorResult,
  entries: OperatorRunLedgerEntry[] = [],
): OperatorRunLedgerEntry {
  const proofTokens = proofTokensFromResult(result);
  const evidenceMet = expectedEvidenceMet(task, result);
  const verdict: OperatorRunLedgerEntry['verdict'] = result.status === 'success'
    && evidenceMet
    && proofTokens.length > 0
    ? 'passed'
    : 'blocked';

  return parseOperatorRunLedgerEntry({
    run_id: buildRunId(task.id, result.completed_at, entries),
    task_id: task.id,
    executor: result.executor,
    started_at: result.started_at,
    completed_at: result.completed_at,
    status: result.status,
    verdict,
    expected_evidence_met: evidenceMet,
    proof_tokens: proofTokens,
    result_path: resultPath(result),
  });
}

export function appendRunLedgerEntry(
  entry: OperatorRunLedgerEntry,
  ledgerPath = operatorRunLedgerPath(),
): OperatorRunLedgerEntry {
  const parsed = parseOperatorRunLedgerEntry(entry);
  const resolvedLedgerPath = constrainMigratingStatePath('operator-runs', ledgerPath);
  mkdirSync(dirname(resolvedLedgerPath), { recursive: true });
  appendFileSync(resolvedLedgerPath, `${JSON.stringify(parsed)}\n`, 'utf-8');
  return parsed;
}

export function appendRunLedgerEntryForResult(
  task: OperatorTask,
  result: OperatorResult,
  ledgerPath = operatorRunLedgerPath(),
): OperatorRunLedgerEntry {
  const entries = readRunLedgerEntries(ledgerPath);
  const entry = buildRunLedgerEntry(task, result, entries);
  return appendRunLedgerEntry(entry, ledgerPath);
}

export function selectCanonicalRunLedgerEntryForTask(
  taskId: string,
  ledgerPath = operatorRunLedgerPath(),
): OperatorRunLedgerEntry | undefined {
  const entries = readRunLedgerEntries(ledgerPath).filter((entry) => entry.task_id === taskId);
  return selectCanonicalRunLedgerEntry(entries);
}
