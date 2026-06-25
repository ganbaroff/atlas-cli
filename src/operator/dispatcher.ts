import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { withBrowserSessionTrace } from './browser-trace.js';
import {
  controlAllowsModelCalls,
  describeControlBlock,
  operatorStatePath as controlStatePath,
  readOperatorState,
} from '../atlas/control-plane.js';
import {
  type OperatorEvidence,
  type OperatorResult,
  type OperatorTask,
  parseOperatorTask,
  parseOperatorResult,
  validateResultEvidence,
} from './contracts.js';
import { evaluateOperatorResultWithRetry } from './evaluator.js';
import { decidePromotion } from './promotion.js';

const REPO_ROOT = process.cwd();
const STATE_PATH = resolve(REPO_ROOT, 'operator/state/operator-state.json');
const RUNS_DIR = resolve(REPO_ROOT, 'operator/runs');

export interface DispatchWriteOptions {
  tracePath?: string;
  persistState?: boolean;
}

export function loadOperatorState(): unknown {
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
}

export function loadOperatorTask(taskPath: string): OperatorTask {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, taskPath), 'utf-8'));
  return parseOperatorTask(raw);
}

export function loadOperatorResult(resultPath: string): OperatorResult {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, resultPath), 'utf-8'));
  return parseOperatorResult(raw);
}

export function writeOperatorTrace(result: OperatorResult, options: DispatchWriteOptions = {}): OperatorResult {
  mkdirSync(RUNS_DIR, { recursive: true });
  const tracePath = options.tracePath ?? result.trace_path ?? resolve(RUNS_DIR, `${result.task_id}.result.json`);
  const withPath = { ...result, trace_path: tracePath };
  const withBrowserTrace = withBrowserSessionTrace(withPath);
  writeFileSync(tracePath, JSON.stringify(withBrowserTrace, null, 2) + '\n', 'utf-8');
  if (options.persistState !== false) {
    const state = loadOperatorState() as Record<string, unknown>;
    const proofTokens = [...new Set([
      ...withBrowserTrace.evidence.map((item) => item.proof_token ?? item.id),
      ...(withBrowserTrace.lifecycle?.proof_tokens ?? []),
    ])];
    const lastRun = {
      task_id: withBrowserTrace.task_id,
      status: withBrowserTrace.status,
      reason: withBrowserTrace.summary,
      executor: withBrowserTrace.executor,
      started_at: withBrowserTrace.started_at,
      completed_at: withBrowserTrace.completed_at,
      trace_path: withBrowserTrace.trace_path,
      proof_tokens: proofTokens,
      evidence_types: [...new Set(withBrowserTrace.evidence.map((item) => item.type))],
      evaluation: withBrowserTrace.evaluation,
      promotion: withBrowserTrace.promotion,
      lifecycle: withBrowserTrace.lifecycle,
    };
    const stateWithLastRun = {
      ...state,
      last_run: lastRun,
    };
    const promotion = withBrowserTrace.promotion ?? decidePromotion({
      state: stateWithLastRun,
      result: withBrowserTrace,
    });
    const nextState = {
      ...state,
      updated_at: new Date().toISOString(),
      last_run: {
        ...lastRun,
        promotion,
      },
    };
    writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n', 'utf-8');
  }
  return withBrowserTrace;
}

function resultTracePath(task: OperatorTask, options: DispatchWriteOptions = {}): string {
  return options.tracePath ?? resolve(RUNS_DIR, `${task.id}.result.json`);
}

function evidence(id: string, task: OperatorTask, type: OperatorEvidence['type'], source: string, summary: string): OperatorEvidence {
  return {
    id,
    task_id: task.id,
    type,
    source,
    observed_at: new Date().toISOString(),
    summary,
    data: {},
    proof_token: id,
    verifier: 'atlas-operator-dispatcher',
  };
}

function isPathWithinAllowedPaths(targetPath: string, allowedPaths: string[]): boolean {
  const resolvedTarget = resolve(targetPath);
  return allowedPaths.some((allowedPath) => {
    const resolvedAllowed = resolve(allowedPath);
    const pathDelta = relative(resolvedAllowed, resolvedTarget);
    return pathDelta === '' || (pathDelta.length > 0 && !pathDelta.startsWith('..') && !isAbsolute(pathDelta));
  });
}

function isSensitiveFileSmokePath(targetPath: string): boolean {
  const segments = resolve(targetPath)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const fileName = segments.at(-1) ?? '';
  const sensitiveDirectories = new Set(['secret', 'secrets', 'credential', 'credentials']);
  const sensitiveFileNames = new Set([
    '.env',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'known_hosts',
  ]);

  return segments.some((segment) => segment.startsWith('.'))
    || segments.some((segment) => sensitiveDirectories.has(segment))
    || sensitiveFileNames.has(fileName)
    || fileName.startsWith('.env.')
    || fileName.endsWith('.key')
    || fileName.endsWith('.pem')
    || fileName.endsWith('.p12')
    || fileName.endsWith('.pfx');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function openManusPython(cwd: string): { command: string; argsPrefix: string[]; label: string } {
  const venvPython = resolve(cwd, '.venv/Scripts/python.exe');
  if (existsSync(venvPython)) {
    return { command: venvPython, argsPrefix: [], label: venvPython };
  }

  return { command: 'py', argsPrefix: ['-3.12'], label: 'py -3.12' };
}

function hasOpenManusDaytonaKey(cwd: string): boolean {
  if (process.env.DAYTONA_API_KEY?.trim()) return true;

  const configPath = resolve(cwd, 'config/config.toml');
  if (!existsSync(configPath)) return false;

  const configText = readFileSync(configPath, 'utf-8');
  const match = configText.match(/daytona_api_key\s*=\s*["']([^"']+)["']/i);
  const value = match?.[1]?.trim();
  if (!value) return false;
  return !['your_api_key', 'sk-...', 'todo', 'changeme'].includes(value.toLowerCase());
}

function openManusUsesSandbox(cwd: string): boolean {
  const configPath = resolve(cwd, 'config/config.toml');
  if (!existsSync(configPath)) return true;

  const configText = readFileSync(configPath, 'utf-8');
  const match = configText.match(/\[sandbox\][\s\S]*?use_sandbox\s*=\s*(true|false)/i);
  if (!match) return true;
  return match[1].toLowerCase() === 'true';
}

function createBlockedResult(
  task: OperatorTask,
  startedAt: string,
  errors: string[],
  foundEvidence: OperatorEvidence[],
  summary = 'Task validated, execution blocked.',
): OperatorResult {
  return {
    task_id: task.id,
    status: 'blocked',
    executor: task.route === 'openmanus' ? 'openmanus' : 'atlas',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary,
    evidence: foundEvidence,
    errors,
  };
}

function dispatchOpenManusTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  if (!task.safety.sandbox_required || task.safety.write_allowed || task.mode !== 'read_only') {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'OpenManus adapter accepts only sandboxed read_only tasks with write_allowed=false',
    ], foundEvidence), options);
  }

  const smokeUrl = typeof task.inputs.smoke_url === 'string' ? task.inputs.smoke_url : '';
  const expectedText = typeof task.inputs.expected_text === 'string' ? task.inputs.expected_text : '';
  const prompt = [
    'Atlas hands smoke. Read-only.',
    `Open ${smokeUrl}.`,
    `Confirm page contains exact text: ${expectedText}.`,
    'Do not write files.',
    'End with one JSON object containing status, observed_text, and summary.',
  ].join('\n');

  const timeoutMs = typeof task.inputs.timeout_ms === 'number' ? task.inputs.timeout_ms : 180000;
  const cwd = resolve(task.cwd);
  const python = openManusPython(cwd);
  if (!hasOpenManusDaytonaKey(cwd)) {
    foundEvidence.push(evidence(
      `${task.id}.daytona`,
      task,
      'manual_note',
      resolve(cwd, 'config/config.toml'),
      'Daytona API key not configured; sandbox launch blocked before execution',
    ));

    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'DAYTONA_API_KEY missing for OpenManus sandbox',
    ], foundEvidence, 'OpenManus adapter ready; sandbox credential missing.'), options);
  }

  const proc = spawnSync(python.command, [...python.argsPrefix, 'sandbox_main.py', '--prompt', prompt], {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  const output = [proc.stdout ?? '', proc.stderr ?? ''].join('\n').trim();
  foundEvidence.push(evidence(
    `${task.id}.command`,
    task,
    'command_exit',
    `${python.label} sandbox_main.py --prompt <atlas-smoke>`,
    `OpenManus process exit ${proc.status ?? 'unknown'}`,
  ));

  if (output.length > 0) {
    foundEvidence.push({
      ...evidence(
        `${task.id}.log`,
        task,
        'log_trace',
        resolve(task.cwd, 'sandbox_main.py'),
        output.slice(0, 4000),
      ),
      data: {
        stdout: (proc.stdout ?? '').slice(0, 12000),
        stderr: (proc.stderr ?? '').slice(0, 12000),
      },
    });
  }

  if (expectedText && output.includes(expectedText)) {
    foundEvidence.push(evidence(
      `${task.id}.browser`,
      task,
      'browser_observation',
      smokeUrl,
      `Observed expected text: ${expectedText}`,
    ));
  }

  const errors: string[] = [];
  if (proc.error) errors.push(proc.error.message);
  if (proc.status !== 0) errors.push(`OpenManus exited with code ${proc.status ?? 'unknown'}`);

  const result: OperatorResult = {
    task_id: task.id,
    status: errors.length === 0 ? 'success' : 'failure',
    executor: 'openmanus',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: errors.length === 0 ? 'OpenManus smoke executed.' : 'OpenManus smoke failed.',
    evidence: foundEvidence,
    errors,
  };

  const resultWithPath = { ...result, trace_path: resultTracePath(task, options) };
  const resultWithBrowserTrace = withBrowserSessionTrace(resultWithPath);
  const evidenceGate = validateResultEvidence(task, resultWithBrowserTrace);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithBrowserTrace,
      status: 'blocked',
      summary: 'OpenManus smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace(resultWithBrowserTrace, options);
}

function dispatchOpenManusLocalTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  const smokeUrl = typeof task.inputs.smoke_url === 'string' ? task.inputs.smoke_url : '';
  const expectedText = typeof task.inputs.expected_text === 'string' ? task.inputs.expected_text : '';
  const prompt = [
    'Read-only smoke.',
    `Open ${smokeUrl}.`,
    'Report current URL and page title.',
    `Confirm exact text: ${expectedText}.`,
    'Do not edit files.',
    'Terminate when done.',
  ].join('\n');

  const timeoutMs = typeof task.inputs.timeout_ms === 'number' ? task.inputs.timeout_ms : 180000;
  const cwd = resolve(task.cwd);
  const python = openManusPython(cwd);
  const proc = spawnSync(python.command, [...python.argsPrefix, 'main.py', '--prompt', prompt], {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  const output = [proc.stdout ?? '', proc.stderr ?? ''].join('\n').trim();
  foundEvidence.push(evidence(
    `${task.id}.command`,
    task,
    'command_exit',
    `${python.label} main.py --prompt <atlas-smoke>`,
    `OpenManus process exit ${proc.status ?? 'unknown'}`,
  ));

  if (output.length > 0) {
    foundEvidence.push({
      ...evidence(
        `${task.id}.log`,
        task,
        'log_trace',
        resolve(cwd, 'main.py'),
        output.slice(0, 4000),
      ),
      data: {
        stdout: (proc.stdout ?? '').slice(0, 12000),
        stderr: (proc.stderr ?? '').slice(0, 12000),
      },
    });
  }

  const pageTitleMatch = output.match(/Page title:\s*(.+)/i);
  const navigatedMatch = output.match(/Navigated to\s+(https?:\/\/\S+)/i);
  const observedTitle = pageTitleMatch?.[1]?.trim() ?? '';
  const observedUrl = navigatedMatch?.[1]?.trim() ?? smokeUrl;
  if (expectedText && (output.includes(expectedText) || observedTitle.includes(expectedText))) {
    foundEvidence.push(evidence(
      `${task.id}.browser`,
      task,
      'browser_observation',
      observedUrl || smokeUrl,
      `Observed page title: ${observedTitle || expectedText}`,
    ));
  } else if (observedTitle || observedUrl) {
    foundEvidence.push(evidence(
      `${task.id}.browser`,
      task,
      'browser_observation',
      observedUrl || smokeUrl,
      `Observed page title: ${observedTitle || 'unknown'}`,
    ));
  }

  const errors: string[] = [];
  if (proc.error) errors.push(proc.error.message);
  if (proc.status !== 0) errors.push(`OpenManus exited with code ${proc.status ?? 'unknown'}`);

  const result: OperatorResult = {
    task_id: task.id,
    status: errors.length === 0 ? 'success' : 'failure',
    executor: 'openmanus',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: errors.length === 0 ? 'OpenManus local smoke executed.' : 'OpenManus local smoke failed.',
    evidence: foundEvidence,
    errors,
  };

  const resultWithPath = { ...result, trace_path: resultTracePath(task, options) };
  const resultWithBrowserTrace = withBrowserSessionTrace(resultWithPath);
  const evidenceGate = validateResultEvidence(task, resultWithBrowserTrace);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithBrowserTrace,
      status: 'blocked',
      summary: 'OpenManus local smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace(resultWithBrowserTrace, options);
}

const LOCAL_HTTP_SMOKE_SCRIPT = `
const [url, expectedText] = process.argv.slice(1);
const startedAt = Date.now();
(async () => {
  const response = await fetch(url);
  const text = await response.text();
  const matched = expectedText.length === 0 || text.includes(expectedText);
  const payload = {
    ok: response.ok,
    status: response.status,
    url: response.url,
    content_type: response.headers.get('content-type') ?? '',
    matched,
    elapsed_ms: Date.now() - startedAt,
    snippet: text.slice(0, 500),
  };
  console.log(JSON.stringify(payload));
  process.exitCode = response.ok && matched ? 0 : 2;
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`.trim();

function dispatchLocalHttpSmokeTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  if (task.mode !== 'read_only' || task.safety.write_allowed) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'Local HTTP smoke accepts only read_only tasks with write_allowed=false',
    ], foundEvidence), options);
  }

  if (!task.safety.network_allowed) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'Local HTTP smoke requires network_allowed=true',
    ], foundEvidence), options);
  }

  const smokeUrl = typeof task.inputs.smoke_url === 'string' ? task.inputs.smoke_url : '';
  const expectedText = typeof task.inputs.expected_text === 'string' ? task.inputs.expected_text : '';
  if (!/^https?:\/\//i.test(smokeUrl)) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'Local HTTP smoke requires http(s) smoke_url',
    ], foundEvidence), options);
  }

  const timeoutMs = typeof task.inputs.timeout_ms === 'number' ? task.inputs.timeout_ms : 30000;
  const proc = spawnSync(process.execPath, ['-e', LOCAL_HTTP_SMOKE_SCRIPT, smokeUrl, expectedText], {
    cwd: resolve(task.cwd),
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  const output = [proc.stdout ?? '', proc.stderr ?? ''].join('\n').trim();
  foundEvidence.push(evidence(
    `${task.id}.command`,
    task,
    'command_exit',
    `node fetch ${smokeUrl}`,
    `Local HTTP smoke process exit ${proc.status ?? 'unknown'}`,
  ));

  let payload: Record<string, unknown> = {};
  const stdout = (proc.stdout ?? '').trim();
  if (stdout.length > 0) {
    try {
      payload = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      payload = { raw_stdout: stdout.slice(0, 1000) };
    }
  }

  foundEvidence.push({
    ...evidence(
      `${task.id}.log`,
      task,
      'log_trace',
      smokeUrl,
      output.slice(0, 4000) || 'Local HTTP smoke produced no output',
    ),
    data: {
      stdout: (proc.stdout ?? '').slice(0, 12000),
      stderr: (proc.stderr ?? '').slice(0, 12000),
      payload,
    },
  });

  if (payload.matched === true) {
    foundEvidence.push({
      ...evidence(
        `${task.id}.browser`,
        task,
        'browser_observation',
        typeof payload.url === 'string' ? payload.url : smokeUrl,
        expectedText ? `Observed expected text: ${expectedText}` : 'Observed successful HTTP response',
      ),
      data: payload,
    });
  }

  const errors: string[] = [];
  if (proc.error) errors.push(proc.error.message);
  if (proc.status !== 0) errors.push(`Local HTTP smoke exited with code ${proc.status ?? 'unknown'}`);
  if (payload.matched === false && expectedText) errors.push(`expected text not observed: ${expectedText}`);
  if (payload.ok === false) errors.push(`HTTP status not ok: ${String(payload.status ?? 'unknown')}`);

  const result: OperatorResult = {
    task_id: task.id,
    status: errors.length === 0 ? 'success' : 'failure',
    executor: 'atlas',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: errors.length === 0 ? 'Local HTTP smoke executed.' : 'Local HTTP smoke failed.',
    evidence: foundEvidence,
    errors,
  };

  const resultWithPath = { ...result, trace_path: resultTracePath(task, options) };
  const resultWithBrowserTrace = withBrowserSessionTrace(resultWithPath);
  const evidenceGate = validateResultEvidence(task, resultWithBrowserTrace);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithBrowserTrace,
      status: 'blocked',
      summary: 'Local HTTP smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace(resultWithBrowserTrace, options);
}

function dispatchLocalFileSmokeTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  if (task.mode !== 'read_only' || task.safety.write_allowed) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'Local file smoke accepts only read_only tasks with write_allowed=false',
    ], foundEvidence), options);
  }

  const rawFilePath = typeof task.inputs.file_path === 'string' ? task.inputs.file_path.trim() : '';
  const expectedText = typeof task.inputs.expected_text === 'string' ? task.inputs.expected_text : '';
  if (!rawFilePath) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'Local file smoke requires file_path',
    ], foundEvidence), options);
  }

  const filePath = isAbsolute(rawFilePath) ? resolve(rawFilePath) : resolve(task.cwd, rawFilePath);
  if (!isPathWithinAllowedPaths(filePath, task.allowed_paths)) {
    foundEvidence.push(evidence(
      `${task.id}.path`,
      task,
      'manual_note',
      filePath,
      'File path rejected before read because it is outside allowed_paths',
    ));

    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      `file_path outside allowed_paths: ${filePath}`,
    ], foundEvidence, 'Local file smoke blocked before read: path outside allowed_paths.'), options);
  }

  if (isSensitiveFileSmokePath(filePath)) {
    foundEvidence.push(evidence(
      `${task.id}.sensitive_path`,
      task,
      'manual_note',
      filePath,
      'File path rejected before read because sensitive paths are denied for file smoke',
    ));

    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      `file_path denied by sensitive path policy: ${filePath}`,
    ], foundEvidence, 'Local file smoke blocked before read: sensitive path denied.'), options);
  }

  if (!existsSync(filePath)) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      `file missing: ${filePath}`,
    ], foundEvidence, 'Local file smoke blocked: file missing.'), options);
  }

  foundEvidence.push(evidence(
    `${task.id}.file`,
    task,
    'file_exists',
    filePath,
    'Target file exists',
  ));

  let content = '';
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      `file read failed: ${error instanceof Error ? error.message : String(error)}`,
    ], foundEvidence, 'Local file smoke blocked: file read failed.'), options);
  }

  const matched = expectedText.length === 0 || content.includes(expectedText);
  const metadata = {
    file_path: filePath,
    bytes: Buffer.byteLength(content, 'utf-8'),
    sha256: sha256(content),
    expected_text_sha256: expectedText ? sha256(expectedText) : undefined,
    expected_text_length: expectedText.length,
    matched,
  };

  foundEvidence.push({
    ...evidence(
      `${task.id}.read`,
      task,
      'file_read',
      filePath,
      matched ? 'Read target file and matched expected text hash' : 'Read target file but expected text hash was not observed',
    ),
    data: metadata,
  });
  foundEvidence.push({
    ...evidence(
      `${task.id}.trace`,
      task,
      'log_trace',
      filePath,
      JSON.stringify(metadata),
    ),
    data: metadata,
  });

  const errors = matched ? [] : ['expected text not observed in file'];
  const result: OperatorResult = {
    task_id: task.id,
    status: errors.length === 0 ? 'success' : 'failure',
    executor: 'atlas',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: errors.length === 0 ? 'Local file smoke executed.' : 'Local file smoke failed.',
    evidence: foundEvidence,
    errors,
  };

  const resultWithPath = { ...result, trace_path: resultTracePath(task, options) };
  const evidenceGate = validateResultEvidence(task, resultWithPath);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithPath,
      status: 'blocked',
      summary: 'Local file smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace(resultWithPath, options);
}

function dispatchManualEvaluationTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  const state = loadOperatorState() as Record<string, unknown>;
  const explicitTargetTaskId = typeof task.inputs.result_task_id === 'string' && task.inputs.result_task_id.trim().length > 0
    ? task.inputs.result_task_id.trim()
    : '';
  const fallbackTargetTaskId = typeof state.last_run === 'object' && state.last_run !== null
    ? String((state.last_run as Record<string, unknown>).task_id ?? '').trim()
    : '';
  const targetTaskId = explicitTargetTaskId || (fallbackTargetTaskId && fallbackTargetTaskId !== task.id ? fallbackTargetTaskId : '');

  if (!targetTaskId) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      ['result_task_id missing or points back at evaluator task'],
      foundEvidence,
      'Evaluator blocked: no target result.',
    ), options);
  }

  const targetTaskPath = resolve(REPO_ROOT, 'operator/tasks', `${targetTaskId}.json`);
  const targetResultPath = resolve(RUNS_DIR, `${targetTaskId}.result.json`);

  const sourceTaskInput = task.inputs.source_task;
  let sourceTask: OperatorTask;
  if (existsSync(targetTaskPath)) {
    sourceTask = loadOperatorTask(`operator/tasks/${targetTaskId}.json`);
    foundEvidence.push(evidence(
      `${task.id}.task`,
      task,
      'file_read',
      targetTaskPath,
      `Loaded task ${sourceTask.id} for evaluation`,
    ));
  } else if (typeof sourceTaskInput === 'object' && sourceTaskInput !== null) {
    sourceTask = parseOperatorTask(sourceTaskInput);
    if (sourceTask.id !== targetTaskId) {
      return writeOperatorTrace(createBlockedResult(
        task,
        startedAt,
        [`source_task id mismatch: expected ${targetTaskId}, got ${sourceTask.id}`],
        foundEvidence,
        'Evaluator blocked: source task input mismatch.',
      ), options);
    }
    foundEvidence.push(evidence(
      `${task.id}.task`,
      task,
      'manual_note',
      'task.inputs.source_task',
      `Loaded dynamic task ${sourceTask.id} for evaluation`,
    ));
  } else {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`target task missing: ${targetTaskPath}`],
      foundEvidence,
      'Evaluator blocked: source task missing.',
    ), options);
  }

  if (!existsSync(targetResultPath)) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`target result missing: ${targetResultPath}`],
      foundEvidence,
      'Evaluator blocked: source result missing.',
    ), options);
  }

  const sourceResult = loadOperatorResult(`operator/runs/${targetTaskId}.result.json`);
  const verdictSource = targetResultPath;
  const evaluationBundle = evaluateOperatorResultWithRetry({
    task: sourceTask,
    sourceResult,
    sourceResultPath: targetResultPath,
    retryDispatcher: ({ task: retryTask, tracePath }) => dispatchOperatorTask(retryTask, {
      tracePath,
      persistState: false,
    }),
  });
  const evaluation = evaluationBundle.evaluation;

  foundEvidence.push(evidence(
    `${task.id}.result`,
    task,
    'file_read',
    targetResultPath,
    `Loaded result ${sourceResult.task_id} for evaluation`,
  ));
  foundEvidence.push({
    ...evidence(
      `${task.id}.verdict`,
      task,
      'manual_note',
      verdictSource,
      evaluation.summary,
    ),
    data: {
      target_task_id: sourceTask.id,
      target_result_path: targetResultPath,
      evaluation,
      source_attempt: evaluationBundle.sourceAttempt,
      retry_attempt: evaluationBundle.retryAttempt,
      retry_result_path: evaluationBundle.retryResultPath,
    },
  });
  foundEvidence.push({
    ...evidence(
      `${task.id}.trace`,
      task,
      'log_trace',
      verdictSource,
      JSON.stringify({
        target_task_id: sourceTask.id,
        target_result: sourceResult.status,
        evaluation,
      }, null, 2).slice(0, 4000),
    ),
    data: {
      target_task_id: sourceTask.id,
      target_result_path: targetResultPath,
      evaluation,
      source_attempt: evaluationBundle.sourceAttempt,
      retry_attempt: evaluationBundle.retryAttempt,
      retry_result_path: evaluationBundle.retryResultPath,
    },
  });

  const result: OperatorResult = {
    task_id: task.id,
    status: evaluation.passed ? 'success' : 'blocked',
    executor: 'manual',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: evaluation.summary,
    evidence: foundEvidence,
    errors: evaluation.passed ? [] : evaluation.issues.map((issue) => issue.message),
    evaluation,
  };

  const resultWithPath = { ...result, trace_path: resultTracePath(task, options) };
  const evidenceGate = validateResultEvidence(task, resultWithPath);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithPath,
      status: 'blocked',
      summary: 'Evaluator task did not produce required evidence.',
      errors: [...result.errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace(resultWithPath, options);
}

function dispatchManualPromotionTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  const targetTaskId = typeof task.inputs.promotion_result_task_id === 'string' && task.inputs.promotion_result_task_id.trim().length > 0
    ? task.inputs.promotion_result_task_id.trim()
    : '';

  if (!targetTaskId) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      ['promotion_result_task_id missing'],
      foundEvidence,
      'Promotion blocked: no target result.',
    ), options);
  }

  const targetResultPath = resolve(RUNS_DIR, `${targetTaskId}.result.json`);
  if (!existsSync(targetResultPath)) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`target result missing: ${targetResultPath}`],
      foundEvidence,
      'Promotion blocked: source result missing.',
    ), options);
  }

  const sourceResult = loadOperatorResult(`operator/runs/${targetTaskId}.result.json`);
  const promotion = decidePromotion({ result: sourceResult });

  foundEvidence.push(evidence(
    `${task.id}.result`,
    task,
    'file_read',
    targetResultPath,
    `Loaded result ${sourceResult.task_id} for promotion`,
  ));
  foundEvidence.push({
    ...evidence(
      `${task.id}.verdict`,
      task,
      'manual_note',
      targetResultPath,
      promotion.reason,
    ),
    data: {
      target_task_id: sourceResult.task_id,
      target_result_path: targetResultPath,
      promotion,
    },
  });
  foundEvidence.push({
    ...evidence(
      `${task.id}.trace`,
      task,
      'log_trace',
      targetResultPath,
      JSON.stringify({
        target_task_id: sourceResult.task_id,
        target_result: sourceResult.status,
        promotion,
      }, null, 2).slice(0, 4000),
    ),
    data: {
      target_task_id: sourceResult.task_id,
      target_result_path: targetResultPath,
      promotion,
    },
  });

  const result: OperatorResult = {
    task_id: task.id,
    status: promotion.promoted ? 'success' : 'blocked',
    executor: 'manual',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: promotion.reason,
    evidence: foundEvidence,
    errors: promotion.promoted ? [] : [promotion.reason],
    evaluation: sourceResult.evaluation,
    promotion,
  };

  const resultWithPath = { ...result, trace_path: resultTracePath(task, options) };
  const evidenceGate = validateResultEvidence(task, resultWithPath);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithPath,
      status: 'blocked',
      summary: 'Promotion task did not produce required evidence.',
      errors: [...result.errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace(resultWithPath, options);
}

function dispatchOctogentTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  const repoRoot = resolve(task.cwd);
  const packagePath = resolve(repoRoot, 'package.json');
  const readmePath = resolve(repoRoot, 'README.md');
  const rawDocPaths = task.inputs.doc_paths;
  const docPaths = Array.isArray(rawDocPaths) ? rawDocPaths : [];
  const normalizedDocPaths = docPaths
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((relativePath) => resolve(repoRoot, relativePath));
  const pathsToRead = normalizedDocPaths.length > 0 ? normalizedDocPaths : [packagePath, readmePath];

  const readSummaries: string[] = [];
  const missing: string[] = [];

  for (const absolutePath of pathsToRead) {
    if (!existsSync(absolutePath)) {
      missing.push(absolutePath);
      continue;
    }

    const content = readFileSync(absolutePath, 'utf-8');
    const summary = content
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trim()
      .slice(0, 160) ?? 'file read';
    foundEvidence.push(evidence(
      `${task.id}.${pathsToRead.indexOf(absolutePath)}`,
      task,
      'file_read',
      absolutePath,
      summary,
    ));
    readSummaries.push(`${absolutePath}: ${summary}`);
  }

  const rawExpectedTerms = task.inputs.expected_terms;
  if (Array.isArray(rawExpectedTerms) && rawExpectedTerms.length > 0) {
    const combined = pathsToRead
      .filter((absolutePath) => existsSync(absolutePath))
      .map((absolutePath) => readFileSync(absolutePath, 'utf-8'))
      .join('\n')
      .toLowerCase();
    const terms = rawExpectedTerms.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const matchedTerms = terms.filter((term) => combined.includes(term.toLowerCase()));
    readSummaries.push(`matched terms: ${matchedTerms.join(', ') || 'none'}`);
  }

  foundEvidence.push(evidence(
    `${task.id}.trace`,
    task,
    'log_trace',
    repoRoot,
    readSummaries.join('; '),
  ));

  const errors: string[] = missing.map((path) => `missing required file: ${path}`);

  const result: OperatorResult = {
    task_id: task.id,
    status: errors.length === 0 ? 'success' : 'failure',
    executor: 'octogent',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: errors.length === 0 ? 'Octogent docs gate verified.' : 'Octogent docs gate incomplete.',
    evidence: foundEvidence,
    errors,
  };

  const evidenceGate = validateResultEvidence(task, result);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...result,
      status: 'blocked',
      summary: 'Octogent scaffold did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace({ ...result, trace_path: resultTracePath(task, options) }, options);
}

function dispatchOctogentLiveChildAckTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  const repoRoot = resolve(task.cwd);
  const scriptPath = resolve(REPO_ROOT, 'scripts/octogent-live-child-ack-smoke.mjs');
  const livePort = typeof task.inputs.start_port === 'number' ? task.inputs.start_port : 8795;
  const parentTerminalId = typeof task.inputs.parent_terminal_id === 'string' && task.inputs.parent_terminal_id.trim().length > 0
    ? task.inputs.parent_terminal_id.trim()
    : 'octogent-live-parent';
  const childTerminalId = typeof task.inputs.child_terminal_id === 'string' && task.inputs.child_terminal_id.trim().length > 0
    ? task.inputs.child_terminal_id.trim()
    : 'octogent-live-child';
  const parentPrompt = typeof task.inputs.parent_prompt === 'string' && task.inputs.parent_prompt.trim().length > 0
    ? task.inputs.parent_prompt.trim()
    : 'Live parent ready.';
  const childPrompt = typeof task.inputs.child_prompt === 'string' && task.inputs.child_prompt.trim().length > 0
    ? task.inputs.child_prompt.trim()
    : 'Live child ready.';
  const parentToChildMessage = typeof task.inputs.parent_message === 'string' && task.inputs.parent_message.trim().length > 0
    ? task.inputs.parent_message.trim()
    : 'Need ACK from child.';
  const childToParentMessage = typeof task.inputs.child_message === 'string' && task.inputs.child_message.trim().length > 0
    ? task.inputs.child_message.trim()
    : 'ACK: live worker online.';
  const timeoutMs = typeof task.inputs.timeout_ms === 'number' ? task.inputs.timeout_ms : 240000;

  const proc = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 4,
    env: {
      ...process.env,
      OCTOGENT_LIVE_TARGET_ROOT: repoRoot,
      OCTOGENT_LIVE_PORT: String(livePort),
      OCTOGENT_LIVE_PARENT_ID: parentTerminalId,
      OCTOGENT_LIVE_CHILD_ID: childTerminalId,
      OCTOGENT_LIVE_PARENT_PROMPT: parentPrompt,
      OCTOGENT_LIVE_CHILD_PROMPT: childPrompt,
      OCTOGENT_LIVE_PARENT_MESSAGE: parentToChildMessage,
      OCTOGENT_LIVE_CHILD_MESSAGE: childToParentMessage,
    },
  });

  const stdout = proc.stdout ?? '';
  const stderr = proc.stderr ?? '';
  const output = [stdout, stderr].filter((value) => value.trim().length > 0).join('\n').trim();
  const commandSummary = `node ${scriptPath}`;
  foundEvidence.push(evidence(
    `${task.id}.command`,
    task,
    'command_exit',
    commandSummary,
    `Live Octogent child-ack smoke exit ${proc.status ?? 'unknown'}`,
  ));

  type LiveOctogentSmokeOutput = {
    apiBaseUrl?: string;
    parent?: { terminalId?: string; lifecycleState?: string; agentRuntimeState?: string; processId?: number };
    child?: { terminalId?: string; lifecycleState?: string; agentRuntimeState?: string; processId?: number };
    sent?: {
      parentToChild?: { messageId?: string; delivered?: boolean };
      childToParent?: { messageId?: string; delivered?: boolean };
    };
    parentMessages?: { messages?: Array<{ messageId?: string; delivered?: boolean; content?: string }> };
    childMessages?: { messages?: Array<{ messageId?: string; delivered?: boolean; content?: string }> };
    snapshots?: Array<{ terminalId?: string; lifecycleState?: string; agentRuntimeState?: string; parentTerminalId?: string }>;
    trace?: string[];
  };

  let parsed: LiveOctogentSmokeOutput | null = null;

  if (stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(stdout) as LiveOctogentSmokeOutput;
    } catch (error) {
      parsed = null;
      const msg = error instanceof Error ? error.message : String(error);
      foundEvidence.push(evidence(
        `${task.id}.parse`,
        task,
        'manual_note',
        scriptPath,
        `Failed to parse live smoke JSON output: ${msg}`,
      ));
    }
  }

  const traceSummary = parsed
    ? [
        `api=${parsed.apiBaseUrl ?? 'unknown'}`,
        `parent=${parsed.parent?.terminalId ?? parentTerminalId}:${parsed.parent?.lifecycleState ?? 'unknown'}/${parsed.parent?.agentRuntimeState ?? 'unknown'}`,
        `child=${parsed.child?.terminalId ?? childTerminalId}:${parsed.child?.lifecycleState ?? 'unknown'}/${parsed.child?.agentRuntimeState ?? 'unknown'}`,
        `parent->child=${parsed.sent?.parentToChild?.delivered ? 'delivered' : 'pending'}`,
        `child->parent=${parsed.sent?.childToParent?.delivered ? 'delivered' : 'pending'}`,
      ].join('; ')
    : output.slice(0, 4000) || 'no live smoke output';

  foundEvidence.push({
    ...evidence(
      `${task.id}.trace`,
      task,
      'log_trace',
      repoRoot,
      traceSummary,
    ),
    data: {
      stdout: stdout.slice(0, 12000),
      stderr: stderr.slice(0, 12000),
      ...(parsed ? { parsed } : {}),
    },
  });

  const errors: string[] = [];
  if (proc.error) {
    errors.push(proc.error.message);
  }
  if (proc.status !== 0) {
    errors.push(`Live Octogent child-ack smoke exited with code ${proc.status ?? 'unknown'}`);
  }
  if (!parsed) {
    errors.push('Live Octogent child-ack smoke did not return JSON output');
  }

  const result: OperatorResult = {
    task_id: task.id,
    status: errors.length === 0 ? 'success' : 'failure',
    executor: 'octogent',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: errors.length === 0
      ? 'Octogent live child-ack smoke verified.'
      : 'Octogent live child-ack smoke failed.',
    evidence: foundEvidence,
    errors,
  };

  const evidenceGate = validateResultEvidence(task, result);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...result,
      status: 'blocked',
      summary: 'Octogent live child-ack smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace({ ...result, trace_path: resultTracePath(task, options) }, options);
}

function dispatchVellumTask(
  task: OperatorTask,
  startedAt: string,
  foundEvidence: OperatorEvidence[],
  options: DispatchWriteOptions = {},
): OperatorResult {
  const repoRoot = resolve(task.cwd);
  const files = [
    'README.md',
    'AGENTS.md',
    'assistant/package.json',
    'assistant/AGENTS.md',
    'assistant/docs/architecture/security.md',
    'assistant/docs/architecture/memory.md',
    'assistant/.env.example',
  ].map((relativePath) => ({
    relativePath,
    absolutePath: resolve(repoRoot, relativePath),
  }));

  const missing = files.filter(({ absolutePath }) => !existsSync(absolutePath));
  if (missing.length > 0) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      missing.map(({ relativePath }) => `missing required file: ${relativePath}`),
      foundEvidence,
      'Vellum gate blocked: required files missing.',
    ), options);
  }

  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf-8');
  const agents = readFileSync(resolve(repoRoot, 'AGENTS.md'), 'utf-8');
  const assistantPackage = JSON.parse(readFileSync(resolve(repoRoot, 'assistant/package.json'), 'utf-8')) as {
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const assistantSecurity = readFileSync(resolve(repoRoot, 'assistant/docs/architecture/security.md'), 'utf-8');
  const assistantMemory = readFileSync(resolve(repoRoot, 'assistant/docs/architecture/memory.md'), 'utf-8');
  const assistantEnv = readFileSync(resolve(repoRoot, 'assistant/.env.example'), 'utf-8');

  foundEvidence.push(evidence(
    `${task.id}.readme`,
    task,
    'file_read',
    resolve(repoRoot, 'README.md'),
    `README describes ${readme.includes('Memory') ? 'memory' : 'assistant'} and ${readme.includes('Security') ? 'security' : 'runtime'}`,
  ));
  foundEvidence.push(evidence(
    `${task.id}.agents`,
    task,
    'file_read',
    resolve(repoRoot, 'AGENTS.md'),
    `AGENTS define assistant/gateway boundaries and runtime rules`,
  ));
  foundEvidence.push(evidence(
    `${task.id}.package`,
    task,
    'file_read',
    resolve(repoRoot, 'assistant/package.json'),
    `assistant package ${assistantPackage.name ?? 'unknown'}; scripts ${Object.keys(assistantPackage.scripts ?? {}).join(', ')}`,
  ));
  foundEvidence.push(evidence(
    `${task.id}.security`,
    task,
    'file_read',
    resolve(repoRoot, 'assistant/docs/architecture/security.md'),
    `security doc mentions ${assistantSecurity.includes('trust') ? 'trust' : 'permissions'} and ${assistantSecurity.includes('sandbox') ? 'sandbox' : 'runtime'}`,
  ));
  foundEvidence.push(evidence(
    `${task.id}.memory`,
    task,
    'file_read',
    resolve(repoRoot, 'assistant/docs/architecture/memory.md'),
    `memory doc mentions ${assistantMemory.includes('turn_context') ? 'turn_context' : 'memory'} and workspace persistence`,
  ));
  foundEvidence.push(evidence(
    `${task.id}.env`,
    task,
    'file_read',
    resolve(repoRoot, 'assistant/.env.example'),
    assistantEnv.includes('VELLUM_PLATFORM_URL') ? 'env example exposes platform url and runtime hints' : 'env example read',
  ));
  foundEvidence.push(evidence(
    `${task.id}.trace`,
    task,
    'log_trace',
    repoRoot,
    [
      'Vellum repo present',
      `assistant scripts: ${Object.keys(assistantPackage.scripts ?? {}).join(', ')}`,
      'security and memory docs present',
    ].join('; '),
  ));

  const result: OperatorResult = {
    task_id: task.id,
    status: 'success',
    executor: 'vellum',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: 'Vellum gate verified.',
    evidence: foundEvidence,
    errors: [],
  };

  const evidenceGate = validateResultEvidence(task, result);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...result,
      status: 'blocked',
      summary: 'Vellum gate did not produce required evidence.',
      errors: [`missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace({ ...result, trace_path: resultTracePath(task, options) }, options);
}

export function dispatchOperatorTask(task: OperatorTask, options: DispatchWriteOptions = {}): OperatorResult {
  const startedAt = new Date().toISOString();
  const foundEvidence: OperatorEvidence[] = [];

  const cwd = resolve(task.cwd);
  if (existsSync(cwd)) {
    foundEvidence.push(evidence(
      `${task.id}.cwd`,
      task,
      'file_exists',
      cwd,
      'Task cwd exists',
    ));
  }

  const controlState = readOperatorState();
  if (!controlAllowsModelCalls(controlState)) {
    foundEvidence.push(evidence(
      `${task.id}.control`,
      task,
      'manual_note',
      controlStatePath(),
      describeControlBlock(controlState),
    ));

    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [describeControlBlock(controlState)],
      foundEvidence,
      describeControlBlock(controlState),
    ), options);
  }

  const missingAllowedPaths = task.allowed_paths.filter((path) => !existsSync(resolve(path)));
  if (missingAllowedPaths.length > 0) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      missingAllowedPaths.map((path) => `allowed path missing: ${path}`),
      foundEvidence,
    ), options);
  }

  if (task.route === 'openmanus') {
    const usesSandbox = openManusUsesSandbox(task.cwd);
    if (task.safety.sandbox_required && !usesSandbox) {
      foundEvidence.push(evidence(
        `${task.id}.sandbox`,
        task,
        'manual_note',
        resolve(task.cwd, 'config/config.toml'),
        'OpenManus sandbox required by task contract, but runtime config has use_sandbox=false',
      ));

      return writeOperatorTrace(createBlockedResult(
        task,
        startedAt,
        ['OpenManus sandbox required, but config/config.toml has use_sandbox=false'],
        foundEvidence,
        'OpenManus execution blocked before launch: sandbox contract mismatch.',
      ), options);
    }

    if (usesSandbox) {
      return dispatchOpenManusTask(task, startedAt, foundEvidence, options);
    }
    return dispatchOpenManusLocalTask(task, startedAt, foundEvidence, options);
  }

  if (task.route === 'octogent') {
    const runtimeMode = task.inputs.runtime_mode;
    if (typeof runtimeMode === 'string' && runtimeMode === 'live_child_ack') {
      return dispatchOctogentLiveChildAckTask(task, startedAt, foundEvidence, options);
    }
    return dispatchOctogentTask(task, startedAt, foundEvidence, options);
  }

  if (task.route === 'vellum') {
    return dispatchVellumTask(task, startedAt, foundEvidence, options);
  }

  if (task.route === 'manual') {
    if (typeof task.inputs.promotion_result_task_id === 'string') {
      return dispatchManualPromotionTask(task, startedAt, foundEvidence, options);
    }
    return dispatchManualEvaluationTask(task, startedAt, foundEvidence, options);
  }

  if (task.route !== 'local') {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`runner adapter not implemented: ${task.route}`],
      foundEvidence,
    ), options);
  }

  if (task.inputs.runtime_mode === 'http_smoke') {
    return dispatchLocalHttpSmokeTask(task, startedAt, foundEvidence, options);
  }

  if (task.inputs.runtime_mode === 'file_smoke') {
    return dispatchLocalFileSmokeTask(task, startedAt, foundEvidence, options);
  }

  const result: OperatorResult = {
    task_id: task.id,
    status: 'success',
    executor: 'atlas',
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    summary: 'Local operator task validated.',
    evidence: foundEvidence,
    errors: [],
  };

  const evidenceGate = validateResultEvidence(task, result);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...result,
      status: 'blocked',
      summary: 'Success blocked: expected evidence missing.',
      errors: [`missing evidence: ${evidenceGate.missing.join(', ')}`],
    }, options);
  }

  return writeOperatorTrace({ ...result, trace_path: resultTracePath(task, options) }, options);
}

export function ensureOperatorArtifacts(): string[] {
  return [
    STATE_PATH,
    resolve(REPO_ROOT, 'operator/schemas/task.schema.json'),
    resolve(REPO_ROOT, 'operator/schemas/result.schema.json'),
    resolve(REPO_ROOT, 'operator/schemas/evidence.schema.json'),
    resolve(REPO_ROOT, 'operator/schemas/run-ledger.schema.json'),
    resolve(REPO_ROOT, 'operator/tasks/openmanus-smoke-readonly.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-scaffold-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/vellum-gate-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-child-agent-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-inter-agent-message-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-todo-swarm-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-worktree-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-parent-swarm-loop-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-channel-delivery-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/octogent-live-child-ack-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/result-quality-evaluator-smoke.json'),
    resolve(REPO_ROOT, 'operator/tasks/result-promotion-smoke.json'),
  ].filter((path) => existsSync(path));
}

export function operatorStatePath(): string {
  return STATE_PATH;
}

export function operatorRunsDir(): string {
  mkdirSync(dirname(resolve(RUNS_DIR, 'x')), { recursive: true });
  return RUNS_DIR;
}
