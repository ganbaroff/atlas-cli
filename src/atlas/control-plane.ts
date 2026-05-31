import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { OperatorEvaluation } from '../operator/contracts.js';

export type ControlMode = 'active' | 'paused' | 'stopped';
export type ControlCommandName = 'pause' | 'stop' | 'resume' | 'reroute' | 'validate';
export type ControlSource = 'cli' | 'telegram' | 'operator' | 'api';

export interface ControlCommandInput {
  command: ControlCommandName;
  lane?: string;
  note?: string;
}

export interface ControlValidationReport {
  passed: boolean;
  issues: string[];
  summary: string;
}

export interface ControlState {
  mode: ControlMode;
  next_lane: string;
  last_command?: {
    command: ControlCommandName;
    source: ControlSource;
    at: string;
    note?: string;
    lane?: string;
  };
  last_validation?: {
    at: string;
    passed: boolean;
    issues: string[];
    summary: string;
  };
}

export interface OperatorStateRecord {
  updated_at?: string;
  status?: string;
  operator?: Record<string, unknown>;
  route?: Record<string, unknown>;
  rules?: string[];
  phase?: {
    name?: string;
    implemented?: boolean;
    next?: string;
    [key: string]: unknown;
  };
  last_run?: {
    task_id?: string;
    status?: string;
    reason?: string;
    executor?: string;
    started_at?: string;
    completed_at?: string;
    trace_path?: string;
    proof_tokens?: string[];
    evidence_types?: string[];
    evaluation?: OperatorEvaluation;
    [key: string]: unknown;
  };
  control?: ControlState;
  [key: string]: unknown;
}

export interface ControlActionResult {
  changed: boolean;
  message: string;
  state: OperatorStateRecord;
  validation?: ControlValidationReport;
}

const REPO_ROOT = process.cwd();
const STATE_PATH = resolve(REPO_ROOT, 'operator/state/operator-state.json');

function now(): string {
  return new Date().toISOString();
}

function cloneState(state: OperatorStateRecord): OperatorStateRecord {
  return structuredClone(state);
}

export function operatorStatePath(): string {
  return STATE_PATH;
}

export function readOperatorState(): OperatorStateRecord {
  return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as OperatorStateRecord;
}

export function writeOperatorState(state: OperatorStateRecord): OperatorStateRecord {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${STATE_PATH}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  writeFileSync(tmpPath, payload, 'utf-8');
  renameSync(tmpPath, STATE_PATH);
  return state;
}

export function getControlState(state: OperatorStateRecord = readOperatorState()): ControlState {
  const raw = (state.control ?? {}) as Partial<ControlState>;
  const phaseNext = typeof state.phase?.next === 'string' && state.phase.next.trim().length > 0
    ? state.phase.next.trim()
    : 'pick next lane';

  return {
    mode: raw.mode === 'paused' || raw.mode === 'stopped' ? raw.mode : 'active',
    next_lane: typeof raw.next_lane === 'string' && raw.next_lane.trim().length > 0
      ? raw.next_lane.trim()
      : phaseNext,
    last_command: raw.last_command,
    last_validation: raw.last_validation,
  };
}

export function controlAllowsModelCalls(state: OperatorStateRecord = readOperatorState()): boolean {
  return getControlState(state).mode === 'active';
}

export function describeControlBlock(state: OperatorStateRecord = readOperatorState()): string {
  const control = getControlState(state);
  return control.mode === 'paused'
    ? 'Control paused. Use /resume.'
    : 'Control stopped. Use /resume.';
}

export function buildControlContext(state: OperatorStateRecord = readOperatorState()): string {
  const control = getControlState(state);
  const lastRun = state.last_run;
  const evaluation = lastRun?.evaluation;
  const lastCommand = control.last_command
    ? `${control.last_command.command} via ${control.last_command.source}`
    : 'none';
  const validation = control.last_validation
    ? `${control.last_validation.passed ? 'ok' : 'blocked'} @ ${control.last_validation.at}`
    : 'not run';
  const lastEvaluation = evaluation
    ? `${evaluation.final_verdict ?? (evaluation.passed ? 'passed' : 'blocked')}${evaluation.retry_used ? ' after retry' : ''}`
    : 'none';

  return [
    '## CONTROL',
    `mode: ${control.mode}`,
    `next lane: ${control.next_lane}`,
    `last command: ${lastCommand}`,
    `last evaluation: ${lastEvaluation}`,
    `validation: ${validation}`,
  ].join('\n');
}

export function parseControlCommand(text: string): ControlCommandInput | null {
  const raw = text.trim();
  if (/^stop\s+caveman\b/i.test(raw)) return null;

  const normalized = raw.replace(/^\/+/, '').replace(/^control\s+/i, '').trim();
  if (!normalized) return null;

  const match = normalized.match(/^(pause|stop|resume|reroute|validate)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;

  const command = match[1].toLowerCase() as ControlCommandName;
  const tail = match[2]?.trim();

  if (command === 'reroute') {
    const lane = tail?.replace(/^to\s+/i, '').trim();
    return { command, lane: lane && lane.length > 0 ? lane : undefined };
  }

  return {
    command,
    note: tail && tail.length > 0 ? tail : undefined,
  };
}

function summarizeValidation(state: OperatorStateRecord): ControlValidationReport {
  const issues: string[] = [];
  const control = getControlState(state);
  const phaseNext = typeof state.phase?.next === 'string' ? state.phase.next.trim() : '';

  if (!phaseNext) {
    issues.push('phase.next missing');
  }

  if (!control.next_lane.trim()) {
    issues.push('control.next_lane missing');
  }

  if (phaseNext && control.next_lane && phaseNext !== control.next_lane) {
    issues.push(`phase.next and control.next_lane drift: ${phaseNext} != ${control.next_lane}`);
  }

  const lastRun = state.last_run;
  if (lastRun) {
    if (!Array.isArray(lastRun.proof_tokens) || lastRun.proof_tokens.length === 0) {
      issues.push('last_run.proof_tokens missing');
    }

    if (typeof lastRun.trace_path === 'string' && lastRun.trace_path.trim().length > 0 && !existsSync(lastRun.trace_path)) {
      issues.push(`trace missing: ${lastRun.trace_path}`);
    }

    const evaluation = lastRun.evaluation;
    if (evaluation && Array.isArray(evaluation.attempts) && evaluation.attempts.length > 0) {
      if (evaluation.retry_used === true && evaluation.attempts.length < 2) {
        issues.push('last_run.evaluation retry_used without retry attempt');
      }

      if (evaluation.retry_used === true && (!Array.isArray(evaluation.result_chain_paths) || evaluation.result_chain_paths.length < 2)) {
        issues.push('last_run.evaluation result chain missing retry path');
      }

      if (evaluation.retry_used === false && Array.isArray(evaluation.result_chain_paths) && evaluation.result_chain_paths.length > 1) {
        issues.push('last_run.evaluation retry chain present without retry_used');
      }

      if (evaluation.final_verdict === 'passed' && !evaluation.winning_result_path) {
        issues.push('last_run.evaluation winning_result_path missing for passed verdict');
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    summary: issues.length === 0 ? 'control state valid' : issues.join('; '),
  };
}

export function validateControlState(state: OperatorStateRecord = readOperatorState()): ControlValidationReport {
  return summarizeValidation(state);
}

export function nextControlState(
  state: OperatorStateRecord,
  input: ControlCommandInput,
  source: ControlSource,
): ControlActionResult {
  const current = getControlState(state);
  const nextState = cloneState(state);
  const commandStamp = {
    command: input.command,
    source,
    at: now(),
    note: input.note?.trim() || undefined,
    lane: input.lane?.trim() || undefined,
  };

  const nextControl: ControlState = {
    ...current,
    last_command: commandStamp,
  };

  switch (input.command) {
    case 'pause': {
      nextControl.mode = 'paused';
      nextState.control = nextControl;
      nextState.updated_at = commandStamp.at;
      return {
        changed: true,
        message: commandStamp.note
          ? `Control paused. ${commandStamp.note}`
          : 'Control paused. Use /resume.',
        state: nextState,
      };
    }
    case 'stop': {
      nextControl.mode = 'stopped';
      nextState.control = nextControl;
      nextState.updated_at = commandStamp.at;
      return {
        changed: true,
        message: commandStamp.note
          ? `Control stopped. ${commandStamp.note}`
          : 'Control stopped. Use /resume.',
        state: nextState,
      };
    }
    case 'resume': {
      nextControl.mode = 'active';
      nextState.control = nextControl;
      nextState.updated_at = commandStamp.at;
      return {
        changed: true,
        message: commandStamp.note ? `Control resumed. ${commandStamp.note}` : 'Control resumed.',
        state: nextState,
      };
    }
    case 'reroute': {
      if (!commandStamp.lane) {
        return {
          changed: false,
          message: 'Lane required for reroute.',
          state,
        };
      }

      nextControl.next_lane = commandStamp.lane;
      nextState.control = nextControl;
      nextState.updated_at = commandStamp.at;
      if (nextState.phase) {
        nextState.phase = { ...nextState.phase, next: commandStamp.lane };
      } else {
        nextState.phase = { next: commandStamp.lane, implemented: true, name: 'control' };
      }

      return {
        changed: true,
        message: `Control rerouted to ${commandStamp.lane}.`,
        state: nextState,
      };
    }
    case 'validate': {
      const validation = summarizeValidation(nextState);
      nextControl.last_validation = {
        at: commandStamp.at,
        passed: validation.passed,
        issues: validation.issues,
        summary: validation.summary,
      };
      nextState.control = nextControl;
      nextState.updated_at = commandStamp.at;
      return {
        changed: true,
        message: validation.passed
          ? `Control valid. ${validation.summary}`
          : `Control blocked. ${validation.summary}`,
        state: nextState,
        validation,
      };
    }
    default: {
      return {
        changed: false,
        message: 'Unknown control command.',
        state,
      };
    }
  }
}

export function applyControlCommand(
  input: ControlCommandInput,
  source: ControlSource,
  state: OperatorStateRecord = readOperatorState(),
): ControlActionResult {
  const transition = nextControlState(state, input, source);
  if (transition.changed) {
    writeOperatorState(transition.state);
  }
  return transition;
}
