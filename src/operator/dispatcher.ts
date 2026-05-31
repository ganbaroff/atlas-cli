import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
import { evaluateOperatorResult } from './evaluator.js';

const REPO_ROOT = process.cwd();
const STATE_PATH = resolve(REPO_ROOT, 'operator/state/operator-state.json');
const RUNS_DIR = resolve(REPO_ROOT, 'operator/runs');

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

export function writeOperatorTrace(result: OperatorResult): OperatorResult {
  mkdirSync(RUNS_DIR, { recursive: true });
  const tracePath = resolve(RUNS_DIR, `${result.task_id}.result.json`);
  const withPath = { ...result, trace_path: tracePath };
  const withBrowserTrace = withBrowserSessionTrace(withPath);
  writeFileSync(tracePath, JSON.stringify(withBrowserTrace, null, 2) + '\n', 'utf-8');
  const state = loadOperatorState() as Record<string, unknown>;
  const proofTokens = [...new Set(withBrowserTrace.evidence.map((item) => item.proof_token ?? item.id))];
  const nextState = {
    ...state,
    updated_at: new Date().toISOString(),
    last_run: {
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
    },
  };
  writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n', 'utf-8');
  return withBrowserTrace;
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

function dispatchOpenManusTask(task: OperatorTask, startedAt: string, foundEvidence: OperatorEvidence[]): OperatorResult {
  if (!task.safety.sandbox_required || task.safety.write_allowed || task.mode !== 'read_only') {
    return writeOperatorTrace(createBlockedResult(task, startedAt, [
      'OpenManus adapter accepts only sandboxed read_only tasks with write_allowed=false',
    ], foundEvidence));
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
    ], foundEvidence, 'OpenManus adapter ready; sandbox credential missing.'));
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

  const resultWithPath = { ...result, trace_path: resolve(RUNS_DIR, `${task.id}.result.json`) };
  const resultWithBrowserTrace = withBrowserSessionTrace(resultWithPath);
  const evidenceGate = validateResultEvidence(task, resultWithBrowserTrace);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithBrowserTrace,
      status: 'blocked',
      summary: 'OpenManus smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    });
  }

  return writeOperatorTrace(resultWithBrowserTrace);
}

function dispatchOpenManusLocalTask(task: OperatorTask, startedAt: string, foundEvidence: OperatorEvidence[]): OperatorResult {
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

  const resultWithPath = { ...result, trace_path: resolve(RUNS_DIR, `${task.id}.result.json`) };
  const resultWithBrowserTrace = withBrowserSessionTrace(resultWithPath);
  const evidenceGate = validateResultEvidence(task, resultWithBrowserTrace);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...resultWithBrowserTrace,
      status: 'blocked',
      summary: 'OpenManus local smoke did not produce required evidence.',
      errors: [...errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    });
  }

  return writeOperatorTrace(resultWithBrowserTrace);
}

function dispatchManualEvaluationTask(task: OperatorTask, startedAt: string, foundEvidence: OperatorEvidence[]): OperatorResult {
  const state = loadOperatorState() as Record<string, unknown>;
  const targetTaskId = typeof task.inputs.result_task_id === 'string' && task.inputs.result_task_id.trim().length > 0
    ? task.inputs.result_task_id.trim()
    : (typeof state.last_run === 'object' && state.last_run !== null
      ? String((state.last_run as Record<string, unknown>).task_id ?? '').trim()
      : '');

  if (!targetTaskId) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      ['result_task_id missing and operator state has no last_run.task_id'],
      foundEvidence,
      'Evaluator blocked: no target result.',
    ));
  }

  const targetTaskPath = resolve(REPO_ROOT, 'operator/tasks', `${targetTaskId}.json`);
  const targetResultPath = resolve(RUNS_DIR, `${targetTaskId}.result.json`);

  if (!existsSync(targetTaskPath)) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`target task missing: ${targetTaskPath}`],
      foundEvidence,
      'Evaluator blocked: source task missing.',
    ));
  }

  if (!existsSync(targetResultPath)) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`target result missing: ${targetResultPath}`],
      foundEvidence,
      'Evaluator blocked: source result missing.',
    ));
  }

  const sourceTask = loadOperatorTask(`operator/tasks/${targetTaskId}.json`);
  const sourceResult = loadOperatorResult(`operator/runs/${targetTaskId}.result.json`);
  const evaluation = evaluateOperatorResult(sourceTask, sourceResult);
  const verdictSource = targetResultPath;

  foundEvidence.push(evidence(
    `${task.id}.task`,
    task,
    'file_read',
    targetTaskPath,
    `Loaded task ${sourceTask.id} for evaluation`,
  ));
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

  const evidenceGate = validateResultEvidence(task, result);
  if (!evidenceGate.passed) {
    return writeOperatorTrace({
      ...result,
      status: 'blocked',
      summary: 'Evaluator task did not produce required evidence.',
      errors: [...result.errors, `missing evidence: ${evidenceGate.missing.join(', ')}`],
    });
  }

  return writeOperatorTrace(result);
}

function dispatchOctogentTask(task: OperatorTask, startedAt: string, foundEvidence: OperatorEvidence[]): OperatorResult {
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
    });
  }

  return writeOperatorTrace(result);
}

function dispatchOctogentLiveChildAckTask(task: OperatorTask, startedAt: string, foundEvidence: OperatorEvidence[]): OperatorResult {
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
    });
  }

  return writeOperatorTrace(result);
}

function dispatchVellumTask(task: OperatorTask, startedAt: string, foundEvidence: OperatorEvidence[]): OperatorResult {
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
    ));
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
    });
  }

  return writeOperatorTrace(result);
}

export function dispatchOperatorTask(task: OperatorTask): OperatorResult {
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
    ));
  }

  const missingAllowedPaths = task.allowed_paths.filter((path) => !existsSync(resolve(path)));
  if (missingAllowedPaths.length > 0) {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      missingAllowedPaths.map((path) => `allowed path missing: ${path}`),
      foundEvidence,
    ));
  }

  if (task.route === 'openmanus') {
    if (openManusUsesSandbox(task.cwd)) {
      return dispatchOpenManusTask(task, startedAt, foundEvidence);
    }
    return dispatchOpenManusLocalTask(task, startedAt, foundEvidence);
  }

  if (task.route === 'octogent') {
    const runtimeMode = task.inputs.runtime_mode;
    if (typeof runtimeMode === 'string' && runtimeMode === 'live_child_ack') {
      return dispatchOctogentLiveChildAckTask(task, startedAt, foundEvidence);
    }
    return dispatchOctogentTask(task, startedAt, foundEvidence);
  }

  if (task.route === 'vellum') {
    return dispatchVellumTask(task, startedAt, foundEvidence);
  }

  if (task.route === 'manual') {
    return dispatchManualEvaluationTask(task, startedAt, foundEvidence);
  }

  if (task.route !== 'local') {
    return writeOperatorTrace(createBlockedResult(
      task,
      startedAt,
      [`runner adapter not implemented: ${task.route}`],
      foundEvidence,
    ));
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
    });
  }

  return writeOperatorTrace(result);
}

export function ensureOperatorArtifacts(): string[] {
  return [
    STATE_PATH,
    resolve(REPO_ROOT, 'operator/schemas/task.schema.json'),
    resolve(REPO_ROOT, 'operator/schemas/result.schema.json'),
    resolve(REPO_ROOT, 'operator/schemas/evidence.schema.json'),
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
  ].filter((path) => existsSync(path));
}

export function operatorStatePath(): string {
  return STATE_PATH;
}

export function operatorRunsDir(): string {
  mkdirSync(dirname(resolve(RUNS_DIR, 'x')), { recursive: true });
  return RUNS_DIR;
}
