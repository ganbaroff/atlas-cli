/**
 * Goal Intake interpreter + exec-graph binder.
 * Deterministic, no LLM. Safe assumptions only; stop on destructive uncertainty.
 */
import { createHash } from 'node:crypto';
import { createGoal, createTask } from '../../exec-graph/api.js';
import {
  AtlasGoalIntakeError,
  parseAtlasGoalContract,
  type AtlasGoalContract,
  type GoalIntakeRisk,
  type GoalIntakeStatus,
} from './contracts.js';
import { findProjectByAlias, getProjectById, type RegistryProject } from './project-registry.js';

const READ_ONLY_RE =
  /ничего не меняй|не меняй|read[\s-]?only|не трогай|audit|анализ|analyze|inspect|review|observe|без изменен/i;
const DESTRUCTIVE_RE =
  /удал|delete|drop\s+table|wipe|уничтож|rm\s+-rf|format\s+disk/i;
const FINANCIAL_RE =
  /оплат|payment|stripe|перевод\s+денег|wire\s+transfer|invoice\s+pay|банк/i;
const CREDENTIAL_RE =
  /password|api[\s_-]?key|secret|credential|токен\s+доступ|выгруз\w*\s+ключ/i;
const PRODUCTION_WRITE_RE =
  /задепло|deploy|push\s+to\s+prod|production\s+(write|change|update)|в\s+прод(акшн|е)?|измени\s+сайт|поменяй\s+сайт|publish\s+live|dns\s+change/i;

export type InterpretGoalInput = {
  ceoMessage: string;
  /** Optional override when CEO names a project id explicitly */
  projectIdHint?: string;
  nowIso?: string;
};

export type BindGoalOptions = {
  /** When false, only interpret — do not createGoal/createTask */
  bindExecGraph?: boolean;
  actor?: string;
};

function sha8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

function isReadOnly(message: string): boolean {
  return READ_ONLY_RE.test(message);
}

function detectStopReasons(message: string): string[] {
  const reasons: string[] = [];
  if (DESTRUCTIVE_RE.test(message)) reasons.push('destructive-action-uncertainty');
  if (FINANCIAL_RE.test(message)) reasons.push('financial-action-requires-ceo');
  if (CREDENTIAL_RE.test(message)) reasons.push('credential-uncertainty');
  if (PRODUCTION_WRITE_RE.test(message) && !isReadOnly(message)) {
    reasons.push('production-modification-requires-ceo');
  }
  return reasons;
}

function riskFor(message: string, readOnly: boolean, stop: string[]): GoalIntakeRisk {
  if (stop.some((s) => s.includes('destructive') || s.includes('credential'))) return 'critical';
  if (stop.some((s) => s.includes('financial') || s.includes('production'))) return 'high';
  if (readOnly) return 'low';
  return 'medium';
}

function inferObjective(message: string, project: RegistryProject | null): string {
  const trimmed = message.replace(/\s+/g, ' ').trim();
  if (project?.projectId === 'prj_integronix' && /integronix\.az|integronix/i.test(message)) {
    if (isReadOnly(message)) {
      return 'Read-only audit of integronix.az: identify site gaps (photos, trust, copy, mobile, conversion) without changing anything';
    }
  }
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function buildUnknownProjectContract(message: string): AtlasGoalContract {
  const objective = message.replace(/\s+/g, ' ').trim().slice(0, 240);
  return parseAtlasGoalContract({
    originalCeoMessage: message,
    interpretedObjective: objective,
    selectedProject: { projectId: 'prj_unknown', name: 'Unknown' },
    projectPath: null,
    relevantCanonicalMemorySources: [
      'C:\\Projects\\VOLAURA\\memory\\atlas\\CEO-PROJECT-MAP.md',
    ],
    requestedOutcome: 'Clarify project identity before any execution',
    allowedActions: ['memory-read', 'ask-ceo-clarification'],
    forbiddenActions: [
      'code-write',
      'production-write',
      'deploy',
      'credential-access',
      'invent-project-facts',
    ],
    riskLevel: 'high',
    approvalRequirements: ['ceo-project-identity'],
    completionCriteria: ['CEO names a known project or adds it to the registry'],
    evidenceRequirements: ['ceo-clarification-receipt'],
    unresolvedAssumptions: ['Project could not be matched to CEO-PROJECT-MAP registry'],
    recommendedNextWorkflow: 'stop-and-ask-ceo-for-project',
    status: 'unknown-project',
    facts: [],
    assumptions: ['No project facts may be invented'],
    conciseCeoSummary: `Не нашёл проект в карте. Нужно имя/путь — без этого не начинаю. Цель: ${objective.slice(0, 120)}`,
    memoryConflicts: [],
    staleMemoryWarnings: [],
  });
}

/**
 * Interpret a CEO message into AtlasGoalContract without side effects.
 */
export function interpretCeoGoal(input: InterpretGoalInput): AtlasGoalContract {
  const message = input.ceoMessage?.trim();
  if (!message) {
    throw new AtlasGoalIntakeError('empty CEO message', 'INVALID');
  }

  const project =
    (input.projectIdHint?.startsWith('prj_') ? getProjectById(input.projectIdHint) : null) ??
    (input.projectIdHint ? findProjectByAlias(input.projectIdHint) : null) ??
    findProjectByAlias(message);

  if (!project) {
    return buildUnknownProjectContract(message);
  }

  const resolved = project;

  const readOnly = isReadOnly(message);
  const stop = detectStopReasons(message);
  const riskLevel = riskFor(message, readOnly, stop);

  let status: GoalIntakeStatus = 'ready';
  if (stop.length > 0) {
    status = stop.some((s) => s.includes('destructive') || s.includes('credential'))
      ? 'blocked'
      : 'needs-approval';
  }

  const allowedActions = readOnly
    ? ['memory-read', 'web-observe-readonly', 'report-write-quarantine', 'screenshot-readonly']
    : ['memory-read', 'code-edit-worktree', 'test-run', 'report-write-quarantine'];

  const forbidden = [
    ...resolved.defaultForbiddenActions,
    'invent-project-facts',
    'second-planner',
    'second-task-graph',
    ...(readOnly ? ['code-write', 'production-write', 'deploy', 'dns-change'] : []),
  ];

  const facts = [...resolved.knownFacts];
  const assumptions: string[] = [];
  if (resolved.projectPath === null) {
    assumptions.push('No verified live repository path — audit is external/read-only observation only');
  }
  if (readOnly) {
    assumptions.push('CEO forbade changes — treat all work as observe/report');
  }
  // Safe inference for Integronix website audit dimensions when CEO listed themes
  if (resolved.projectId === 'prj_integronix' && /фото|довер|текст|мобил|конверс|photo|trust|mobile|conversion/i.test(message)) {
    assumptions.push(
      'Audit dimensions include photos, trust signals, copy, mobile UX, and conversion (inferred from CEO wording)',
    );
  }

  const approvalRequirements =
    status === 'ready'
      ? []
      : status === 'blocked'
        ? stop
        : [...stop, 'ceo-explicit-go'];

  const interpretedObjective = inferObjective(message, resolved);
  const draftSummary = `${resolved.name}: ${interpretedObjective} Status ${status}, risk ${riskLevel}.`;

  return parseAtlasGoalContract({
    originalCeoMessage: message,
    interpretedObjective,
    selectedProject: { projectId: resolved.projectId, name: resolved.name },
    projectPath: resolved.projectPath,
    relevantCanonicalMemorySources: resolved.canonicalMemorySources,
    requestedOutcome: readOnly
      ? 'Written gap analysis with evidence citations; zero site mutations'
      : 'Bounded implementation with EvidencePack and independent verification',
    allowedActions,
    forbiddenActions: [...new Set(forbidden)],
    riskLevel,
    approvalRequirements,
    completionCriteria: readOnly
      ? [
          'Gap list covers requested dimensions',
          'Each claim cites observation or canon memory',
          'No production or site changes performed',
        ]
      : [
          'Allowed-scope changes only',
          'Tests/evidence recorded',
          'Independent verifier PASS',
        ],
    evidenceRequirements: [
      'diff-or-observation-log',
      'command-exit-hashes',
      'memory-source-citations',
      ...(readOnly ? ['no-mutation-proof'] : ['effectProofs']),
    ],
    unresolvedAssumptions: [
      ...assumptions.filter((a) => a.includes('No verified')),
      ...(resolved.staleWarnings.length ? ['Live production state is unverified — conclusions must say so'] : []),
    ],
    recommendedNextWorkflow:
      status === 'blocked'
        ? 'stop-fail-closed'
        : status === 'needs-approval'
          ? 'ceo-approval-then-courier-loop'
          : readOnly
            ? 'courier-loop-readonly-audit'
            : 'courier-loop-bounded-impl',
    status,
    facts,
    assumptions,
    conciseCeoSummary: draftSummary.slice(0, 300),
    memoryConflicts: resolved.memoryConflicts,
    staleMemoryWarnings: resolved.staleWarnings,
  });
}

/**
 * Interpret + optionally bind to exec-graph (createGoal + createTask).
 * Only binds when status === 'ready'.
 */
export function intakeCeoGoal(
  input: InterpretGoalInput,
  opts: BindGoalOptions = {},
): AtlasGoalContract {
  const contract = interpretCeoGoal(input);
  const bind = opts.bindExecGraph !== false;

  if (!bind) return contract;

  if (contract.status === 'unknown-project') {
    throw new AtlasGoalIntakeError('cannot bind unknown project', 'UNKNOWN_PROJECT');
  }
  if (contract.status === 'blocked') {
    throw new AtlasGoalIntakeError(`blocked: ${contract.approvalRequirements.join(',')}`, 'BLOCKED');
  }
  if (contract.status === 'needs-approval') {
    throw new AtlasGoalIntakeError(
      `needs CEO approval: ${contract.approvalRequirements.join(',')}`,
      'NEEDS_APPROVAL',
    );
  }

  const key = sha8(contract.originalCeoMessage);
  const goal = createGoal({
    title: contract.interpretedObjective.slice(0, 200),
    source: { kind: 'ceo-chat', ref: `goal-intake:${key}` },
    actor: opts.actor ?? 'atlas-goal-intake',
  });
  const { task } = createTask({
    goalId: goal.id,
    title: contract.interpretedObjective.slice(0, 200),
    riskClass:
      contract.riskLevel === 'critical'
        ? 'irreversible'
        : contract.riskLevel === 'high'
          ? 'high'
          : contract.riskLevel === 'medium'
            ? 'medium'
            : 'low',
    source: { kind: 'ceo-chat', ref: `goal-intake-task:${key}` },
    actor: opts.actor ?? 'atlas-goal-intake',
    idempotencyKey: `goal-intake:${key}`,
  });

  return parseAtlasGoalContract({
    ...contract,
    execGraphBinding: { goalId: goal.id, taskId: task.id },
  });
}
