/**
 * atlas/executor/adapter.ts — the Atlas-owned executor boundary.
 *
 * This is the ONE interface Atlas talks to when it needs hands. Cline,
 * OpenHands, Codex or a future executor each live entirely behind it: nothing
 * in this file names a vendor, imports a vendor SDK, or leaks a vendor type.
 * Replacing the executor must never require touching Goal Intake, Project
 * Resolution, Context Assembly, Work Orders, memory, or the verifier.
 *
 * Authority stays on the Atlas side of this boundary. An adapter receives a
 * SignedWorkOrder and a broker; it does not decide scope, spend, or process
 * ownership, and it cannot widen its own mission. `src/core-spine/
 * executor-adapter-contract.ts` remains the declarative capability contract —
 * this module is its runtime counterpart, not a second contract.
 */

import type { SignedWorkOrder } from '../work-order/types.js';

/** Lifecycle of one adapter-run mission, as Atlas observes it. */
export type ExecutorRunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'panicked'
  | 'disposed';

/**
 * A structured event emitted by the executor. Deliberately narrow: Atlas must
 * never have to parse prose to learn what happened. An adapter maps whatever
 * its vendor emits onto this closed set, dropping anything it cannot map
 * rather than passing vendor shapes through.
 */
export type ExecutorEvent =
  | { readonly kind: 'run-started'; readonly at: string }
  | { readonly kind: 'turn-started'; readonly at: string; readonly turn: number }
  | { readonly kind: 'tool-requested'; readonly at: string; readonly tool: string; readonly input: unknown }
  | { readonly kind: 'tool-refused'; readonly at: string; readonly tool: string; readonly reason: string }
  | { readonly kind: 'tool-succeeded'; readonly at: string; readonly tool: string }
  | { readonly kind: 'model-invoked'; readonly at: string; readonly provider: string; readonly model: string }
  | { readonly kind: 'assistant-message'; readonly at: string; readonly chars: number }
  | { readonly kind: 'paused'; readonly at: string; readonly reason: string }
  | { readonly kind: 'resumed'; readonly at: string }
  | { readonly kind: 'panicked'; readonly at: string; readonly reason: string }
  | { readonly kind: 'run-finished'; readonly at: string; readonly status: ExecutorRunStatus };

export interface ExecutorRunResult {
  readonly status: ExecutorRunStatus;
  /** Executor's final text, if any. Never authoritative — the verifier decides. */
  readonly outputText: string;
  readonly turns: number;
  readonly toolCallsRequested: number;
  readonly toolCallsRefused: number;
  readonly events: readonly ExecutorEvent[];
  readonly error?: string;
}

/**
 * Atlas-owned state that must survive a process restart. `executorSession` is
 * an OPAQUE vendor blob: Atlas persists it so a restarted mission can rehydrate
 * the executor, but never reads it as authority. Durable memory authority stays
 * with VOLAURA `memory/atlas`; this is executor session state, nothing more.
 */
export interface ExecutorSnapshot {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly missionId: string;
  readonly workOrderHash: string;
  readonly status: ExecutorRunStatus;
  readonly turns: number;
  readonly capturedAt: string;
  readonly executorSession: unknown;
}

/** Everything an adapter is allowed to know about its mission. */
export interface ExecutorRunContext {
  readonly missionId: string;
  readonly signedWorkOrder: SignedWorkOrder;
  /** Absolute path of the isolated worktree the mission may touch. */
  readonly worktreeRoot: string;
  /** The instruction Atlas derived from the goal — not the raw CEO text. */
  readonly instruction: string;
  /** The ONLY tools the executor gets. An adapter must not add its own. */
  readonly broker: ExecutorToolBroker;
  /** Provider decision already approved by Atlas spend authority. */
  readonly provider: ApprovedProvider;
  readonly onEvent?: (event: ExecutorEvent) => void;
}

/**
 * A provider decision that has already passed Atlas spend policy. An adapter
 * receives this and may not construct one: no approved decision, no model call.
 */
export interface ApprovedProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl?: string;
  /** Resolved at call time from the Atlas secret provider; never logged. */
  readonly apiKey: string;
  readonly paid: boolean;
  /** Evidence claim id proving the spend decision that authorized this. */
  readonly spendClaimId: string;
}

/** One tool the executor may call. Every implementation is Atlas-authored. */
export interface BrokeredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mutating: boolean;
}

export type BrokerOutcome =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly refusedReason: string };

/**
 * The broker is the only path from executor intent to the host. It re-derives
 * authority from disk on every call — a caller-supplied boolean never stands in
 * for a check, and refusal happens before any side effect.
 */
export interface ExecutorToolBroker {
  readonly tools: readonly BrokeredTool[];
  invoke(toolName: string, input: unknown): Promise<BrokerOutcome>;
}

/**
 * The replaceable-hands contract.
 *
 * `panic()` is deliberately not `abort()`: it must terminate the mission's
 * whole process tree, not merely ask the agent loop to stop. An adapter that
 * cannot honour that has failed qualification — the semantics do not bend to
 * accommodate an SDK.
 */
export interface ExecutorAdapter {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly status: ExecutorRunStatus;
  execute(context: ExecutorRunContext): Promise<ExecutorRunResult>;
  /** Stops before the next mutation. Never reports the mission complete. */
  pause(reason: string): Promise<void>;
  resume(): Promise<void>;
  /** Hard stop: executor and every mission-owned child process. */
  panic(reason: string): Promise<void>;
  snapshot(): ExecutorSnapshot;
  restore(snapshot: ExecutorSnapshot): Promise<void>;
  dispose(): Promise<void>;
}

export class ExecutorAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'paused'
      | 'panicked'
      | 'not-running'
      | 'snapshot-mismatch'
      | 'provider-unapproved'
      | 'vendor-unavailable',
  ) {
    super(message);
    this.name = 'ExecutorAdapterError';
  }
}
