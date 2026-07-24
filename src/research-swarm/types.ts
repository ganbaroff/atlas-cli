/**
 * Research swarm — typed contracts for honest multi-provider orchestration.
 */

import type { ProviderName } from '../model-router.js';

export const RESEARCH_SWARM_SCHEMA_VERSION = 1 as const;

export type ResearchSwarmStatus =
  | 'SUCCESS'
  | 'LIMITED_DIVERSITY'
  | 'MULTIMODEL_UNAVAILABLE'
  | 'NO_CONSENSUS'
  | 'TIMEOUT'
  | 'PROVIDER_FAILURE'
  | 'JUDGE_FAILURE';

export type MemoryState = 'OK' | 'DEGRADED_MEMORY' | 'LOCAL_ONLY';

export type WorkerPhaseStatus = 'ok' | 'timeout' | 'provider_error' | 'routing_error' | 'blocked';

export interface WorkerEvidence {
  id: number;
  perspective?: string;
  declaredProvider?: ProviderName | string;
  actualProvider: string;
  actualModelId: string;
  modelFamily: string;
  status: WorkerPhaseStatus;
  output: string;
  durationMs: number;
  error?: string;
}

export interface JudgeEvidence {
  provider: string;
  modelId: string;
  modelFamily: string;
  status: 'ok' | 'timeout' | 'provider_error';
  output: string;
  durationMs: number;
  error?: string;
  independent: false;
}

export interface DiversityReport {
  successfulProviders: string[];
  successfulFamilies: string[];
  providerCount: number;
  familyCount: number;
  meetsLimitedDiversity: boolean;
  meetsStrongConsensus: boolean;
}

export interface SwarmClaim {
  text: string;
  sources: number[];
  dissent?: boolean;
}

export interface ResearchSwarmArtifact {
  schemaVersion: typeof RESEARCH_SWARM_SCHEMA_VERSION;
  runId: string;
  taskHash: string;
  task: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ResearchSwarmStatus;
  exitReason: string;
  memoryState: MemoryState;
  workers: WorkerEvidence[];
  judge: JudgeEvidence | null;
  claims: SwarmClaim[];
  dissent: SwarmClaim[];
  diversity: DiversityReport;
  consensus: string | null;
  synthesis: string;
  secretScan: { clean: boolean; findings: string[] };
  bridgeSource?: 'typescript' | 'python' | 'typescript-fallback';
}

export interface ResearchSwarmResult {
  artifact: ResearchSwarmArtifact;
  synthesis: string;
  exitCode: number;
}

export interface ProviderPreference {
  preferred?: ProviderName;
  required?: ProviderName;
}

export interface TimeoutConfig {
  routingMs: number;
  workerMs: number;
  judgeMs: number;
  globalMs: number;
}

export type EvalVerdict = 'KEEP_DISABLED' | 'RESEARCH_ONLY' | 'READY_FOR_RESEARCH';

export interface EvalReport {
  fixtureId: string;
  baselineMs: number;
  swarmMs: number;
  baselineTokens: number;
  swarmTokens: number;
  swarmStatus: ResearchSwarmStatus;
  verdict: EvalVerdict;
  rationale: string;
}
